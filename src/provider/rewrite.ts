// 上游请求构造：REQ 帧 -> 最终上游 URL + 转发头集 + Host 值。
// 正交意图（本文件不实现）：
// - 网络转发（upstream.ts / ws-upstream.ts）；本文件只做纯构造与断言，零 IO；
// - SSRF 防线：上游 URL 目标仅来自本地服务配置，帧内任何字段不影响 origin；
//   拼接规范化后双重断言（origin 一致 + 基础路径前缀），任一不成立抛
//   RewriteError（protocol_error 语义，调用方回送 ERROR 帧且零上游请求）；
// - Host 头由服务配置决定（缺省上游 host，rewrite.hostHeader 覆盖），MUST NOT
//   来自帧内（wire schema 已拒绝 host 头，此处纵深防御同样剥离）；
// - $env:VAR 每请求解析（空串与未设置同义 -> 该头省略）；解析时机为每请求，
//   不做启动期缓存（env 可变）。
// - $secret:<name> 每请求从密钥库解析（SecretSource 注入；未命中抛
//   SecretMissingError -> secret_missing，不回退空值、不带引用名出网）；与
//   $env 可并存于不同头。

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { FORBIDDEN_REQ_HEADER_NAMES } from "../wire/frames.ts";
import type { ReqHeader } from "../wire/frames.ts";
import { routeLocalPrefix } from "../shared/rpc-contract.ts";
import { compileMatchPattern, matchRequestPath } from "./match-pattern.ts";
import { resolveHookValue, type HeaderValue } from "./hook.ts";
import { expandUriTemplate } from "./uri-template.ts";
import { parseUpstreamUrl } from "./store.ts";
import type { ServiceConfig } from "./store.ts";

import { SECRET_REF_PREFIX } from "./detail.ts";

export { ENV_REF_PREFIX, SECRET_REF_PREFIX, isEnvRef, isSecretRef } from "./detail.ts";

/** 拼接/断言失败（protocol_error 语义）。 */
export class RewriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RewriteError";
  }
}

/**
 * 服务声明了路由表但请求路径未命中任何标准前缀（path_not_offered 语义，
 * 消费侧映射 404）：只转发声明的 API 标准面——防 /user、/balance 等
 * 个人信息端点被提供方凭据打穿（Owner 2026-09-10 裁决：路由表即白名单）。
 */
export class PathNotOfferedError extends Error {
  constructor() {
    super("path is not offered by this service");
    this.name = "PathNotOfferedError";
  }
}

/**
 * `$secret:<name>` 引用未命中（secret_missing 语义）：该请求以 ERROR(secret_missing)
 * 拒绝。message 固定——MUST NOT 包含密钥名与值（错误帧会过网）。
 */
export class SecretMissingError extends Error {
  constructor() {
    super("referenced secret is missing");
    this.name = "SecretMissingError";
  }
}

/** 环境读取面（默认 process.env；测试注入用）。 */
export type EnvSource = Record<string, string | undefined>;

/** 密钥读取面（name -> value；未命中 undefined——由 resolveHeaderValue 升级为错误）。 */
export type SecretSource = (name: string) => string | undefined;

/** 文件凭据读取面（绝对路径 + JSON path -> 值；未命中 undefined）。每请求调用——
 *  无内存态（与 $secret 同法则：外部写入即刻生效，无需缓存/watchFiles）。 */
export type FileCredentialSource = (path: string, jsonPath: string) => string | undefined;

export interface UpstreamPlan {
  /** 最终上游 URL（已过双重断言；含查询串）。 */
  url: URL;
  /** 经 headerRemove/headerSet 链处理后的帧内头集（凭据类纵深剥离；含 contentType 折叠）。 */
  headers: Record<string, string>;
  /** Host 头值（服务配置决定）。 */
  host: string;
  /** 请求是否携带 WS 升级握手头（分流到 ws-upstream）。 */
  isWebSocketUpgrade: boolean;
}

// ---------------------------------------------------------------------------
// $file: 文件型凭据引用
// ---------------------------------------------------------------------------

export const FILE_REF_PREFIX = "$file:";

/** `$file:<path>#<json-path>[?bearer]` 的解析结果。 */
export interface FileRef {
  path: string;
  jsonPath: string;
  bearer: boolean;
}

/**
 * 解析 `$file:` 引用。path 支持 `~` 前缀（解析时展开）；jsonPath 为 jq 风格
 * 点径（`.tokens.access_token`，支持 `[n]` 数组下标）；`?bearer` 后缀给非空
 * 值拼 `Bearer ` 前缀。格式非法（缺 `#`）抛 SecretMissingError 同族的
 * UsageError 语义由调用方决定——此处返回 null 交由上层按未命中处理。
 */
export function parseFileRef(value: string): FileRef | null {
  const body = value.slice(FILE_REF_PREFIX.length);
  const hash = body.indexOf("#");
  if (hash <= 0) return null;
  let spec = body.slice(hash + 1);
  let bearer = false;
  if (spec.endsWith("?bearer")) {
    bearer = true;
    spec = spec.slice(0, -"?bearer".length);
  }
  if (spec === "" || !spec.startsWith(".")) return null;
  return { path: body.slice(0, hash), jsonPath: spec, bearer };
}

/** jq 风格点径求值（`.a.b` / `.a[0].b`；起点须以 `.` 开头）。未命中返回 undefined。 */
export function evalJsonPath(root: unknown, jsonPath: string): unknown {
  if (!jsonPath.startsWith(".")) return undefined;
  let cur: unknown = root;
  const segments = jsonPath
    .slice(1)
    .split(/(?=\[)|\./)
    .filter((s) => s !== "");
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    const arr = /^\[(\d+)\]$/.exec(seg);
    if (arr !== null) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(arr[1])];
      continue;
    }
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 脚本凭据读取面（模块绝对路径 -> 导出函数或 undefined；由 resolveHeaderValue 调用取值）。 */
export type ScriptCredentialSource = (modulePath: string) => unknown;

export const SCRIPT_REF_PREFIX = "$script:";

/** `$script:<path>[?bearer]` 的解析结果。 */
export interface ScriptRef {
  path: string;
  bearer: boolean;
}

export function parseScriptRef(value: string): ScriptRef | null {
  let body = value.slice(SCRIPT_REF_PREFIX.length);
  let bearer = false;
  if (body.endsWith("?bearer")) {
    bearer = true;
    body = body.slice(0, -"?bearer".length);
  }
  if (body === "") return null;
  return { path: body, bearer };
}

/**
 * 默认脚本凭据源：createRequire 同步加载 CJS 模块并返回其导出——
 * 函数导出由 resolveHeaderValue 每请求调用（值按调用计算，token 刷新即刻生效）；
 * 脚本文件本身的修改需重启 daemon（require 缓存，跨 Node/Bun/Deno 一致）。
 * 信任模型与 $cmd 等价：脚本以 ai-fly 同权限执行宿主 IO（无 VM 隔离——
 * node:vm 非安全边界且 Bun/Deno 支持残缺，Owner 裁决 2026-09-12 取简方案）。
 */
export const defaultScriptCredentialSource: ScriptCredentialSource = (modulePath): unknown => {
  try {
    return createRequire(import.meta.url)(modulePath);
  } catch {
    return undefined;
  }
};

/** 脚本导出归一：函数 / {default: fn} 取函数；其余视为无效（undefined）。 */
function scriptExportFn(mod: unknown): ((ctx: { homedir: string }) => unknown) | undefined {
  if (typeof mod === "function") return mod as (ctx: { homedir: string }) => unknown;
  if (mod !== null && typeof mod === "object" && "default" in mod) {
    const d = (mod as { default?: unknown }).default;
    if (typeof d === "function") return d as (ctx: { homedir: string }) => unknown;
  }
  return undefined;
}

/** 默认文件凭据源：读文件 + JSON 解析 + 点径求值（仅字符串值；`~` 已在上层展开）。 */
export const defaultFileCredentialSource: FileCredentialSource = (path, jsonPath): string | undefined => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const value = evalJsonPath(parsed, jsonPath);
  return typeof value === "string" && value !== "" ? value : undefined;
};

/**
 * 头值解析（两协议，Owner 裁决 2026-09-12 最终形态）：
 * - string 字面量：原样（空串 = 省略该头）
 * - 对象 = 钩子调用：{ hook: <函数名>, args?, bearer? }——脚本取
 *   ctx.script（service.hooks），缺席时按 args 形态推导内建
 *   （var→env / name→secret / path→file）；经 resolveHookValue 三态取值
 *   （string/Promise 每请求拉取；AsyncIterable 订阅 latest）；bearer 拼
 *   前缀。未命中抛 SecretMissingError（零上游请求；不泄脚本路径与值）。
 */
export async function resolveHeaderEntry(
  entry: HeaderValue,
  ctx: {
    script?: string | undefined;
    env?: EnvSource;
    secrets?: SecretSource | undefined;
    home?: string;
    loader?: (name: string, home: string) => Record<string, unknown> | undefined;
  },
): Promise<string | undefined> {
  if (typeof entry === "string") return entry === "" ? undefined : entry;
  const args = entry.args ?? {};
  let script = ctx.script;
  if (script === undefined || script === "") {
    if (args.var !== undefined) script = "env";
    else if (args.name !== undefined) script = "secret";
    else if (args.path !== undefined) script = "file";
    else throw new SecretMissingError();
  }
  let raw: string;
  try {
    raw = await resolveHookValue(
      entry.hook,
      {
        script,
        ...(ctx.home !== undefined ? { home: ctx.home } : {}),
        ...(Object.keys(args).length > 0 ? { args } : {}),
        ...(ctx.secrets !== undefined ? { secrets: ctx.secrets } : {}),
        ...(ctx.env !== undefined ? { env: (n: string) => ctx.env?.[n] } : {}),
        ...(ctx.loader !== undefined ? { loader: ctx.loader } : {}),
      },
    );
  } catch {
    throw new SecretMissingError();
  }
  return entry.bearer === true ? `Bearer ${raw}` : raw;
}

/** 服务声明的 env 钩子变量名（启动横幅 WARNING 用：声明而未设置）。 */
export function collectEnvVarNames(service: ServiceConfig): string[] {
  const names = new Set<string>();
  const headerSet = service.rewrite?.headerSet;
  if (headerSet === undefined) return [];
  for (const entry of Object.values(headerSet)) {
    if (
      typeof entry === "object" &&
      entry.args?.var !== undefined &&
      (service.hooks === undefined || service.hooks === "env")
    ) {
      names.add(entry.args.var);
    }
  }
  return [...names];
}

/** HTTP hop-by-hop / 传输层自管头（普通 HTTP 转发路径剥离；WS 路径另行挑选）。 */
export const HOP_BY_HOP_HEADER_NAMES: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);

/** 帧内头防御性剥离集合（wire schema 已拒绝；此处纵深防御）。 */
const DEFENSIVE_STRIP = new Set<string>([
  ...FORBIDDEN_REQ_HEADER_NAMES,
  ...HOP_BY_HOP_HEADER_NAMES,
  "content-length",
]);

// ---------------------------------------------------------------------------
// 路径处理
// ---------------------------------------------------------------------------

/** 点段规范化（".", ".." 解析；不越出根，前缀断言兜底）。 */
function normalizeDotSegments(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return `/${out.join("/")}`;
}

interface SplitPath {
  path: string;
  query: string;
}

function splitQuery(raw: string): SplitPath {
  const idx = raw.indexOf("?");
  return idx < 0 ? { path: raw, query: "" } : { path: raw.slice(0, idx), query: raw.slice(idx + 1) };
}

/** 查询值解码（畸形序列原样保留；模板会重新编码）。 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, "%20"));
  } catch {
    return value;
  }
}

/** 查询串 → 变量表（pattern 模板变量域；同名捕获组优先覆盖）。 */
function parseQueryVars(query: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (query === "") return vars;
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) {
      if (pair !== "") vars[pair] = "";
      continue;
    }
    vars[pair.slice(0, eq)] = safeDecode(pair.slice(eq + 1));
  }
  return vars;
}

/** 帧内 path 的纵深防御检查（schema 层已拒；双保险）。 */
function assertFramePathShape(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) {
    throw new RewriteError("request path must start with a single '/'");
  }
  if (path.includes("\\")) {
    throw new RewriteError("request path must not contain backslash");
  }
  const pathPart = splitQuery(path).path;
  if (pathPart.includes("://")) {
    throw new RewriteError("request path must not contain a scheme");
  }
  for (const seg of pathPart.split("/").slice(1)) {
    if (seg === "." || seg === "..") {
      throw new RewriteError("request path must not contain '.' or '..' segments");
    }
  }
}

// ---------------------------------------------------------------------------
// WS 升级识别
// ---------------------------------------------------------------------------

/** connection 头 token 列表包含 upgrade 且 upgrade 头为 websocket（大小写不敏感）。 */
export function isWebSocketUpgradeRequest(headers: Record<string, string>): boolean {
  const connection = headers["connection"];
  const upgrade = headers["upgrade"];
  if (connection === undefined || upgrade === undefined) return false;
  const tokens = connection
    .split(",")
    .map((t) => t.trim().toLowerCase());
  return tokens.includes("upgrade") && upgrade.trim().toLowerCase() === "websocket";
}

// ---------------------------------------------------------------------------
// 主构造
// ---------------------------------------------------------------------------

export async function buildUpstreamRequest(
  service: ServiceConfig,
  req: ReqHeader,
  env: EnvSource = process.env,
  secrets?: SecretSource | undefined,
): Promise<UpstreamPlan> {
  const upstream = parseUpstreamUrl(service.upstream);

  // 1) path：防御性形状检查 -> 路径路由（**按声明顺序命中，先声明先匹配**
  //    ——M3-r7 Owner 裁决；prefix 模式段边界前缀替换 / pattern 模式
  //    URLPattern 匹配 + RFC 6570 模板拼装；未命中 = 白名单外，本地拒绝零
  //    上游请求）-> 前缀剥离 -> 前缀追加 -> 基础路径拼接 -> 点段规范化。
  //    路由改写优先于服务级 strip/append（预设/自定义只应择一使用）。
  assertFramePathShape(req.path);
  const split = splitQuery(req.path);
  let requestPath = split.path;
  let query = split.query;
  if (service.routes !== undefined && service.routes.length > 0) {
    let matched = false;
    for (const route of service.routes) {
      if (route.mode === "pattern") {
        const groups = matchRequestPath(compileMatchPattern(route.matchPattern!), requestPath, query);
        if (groups === null) continue;
        // 变量 = URLPattern 捕获组 + 请求查询参数；模板产物含查询串则替换之
        const vars: Record<string, string | undefined> = { ...parseQueryVars(query), ...groups };
        const assembled = expandUriTemplate(route.template!, vars);
        const qIdx = assembled.indexOf("?");
        if (qIdx >= 0) {
          requestPath = assembled.slice(0, qIdx);
          query = assembled.slice(qIdx + 1);
        } else {
          requestPath = assembled;
        }
        matched = true;
        break;
      }
      const local = routeLocalPrefix(route);
      const hit = requestPath === local || requestPath.startsWith(local + "/");
      if (!hit) continue;
      const rest = requestPath.slice(local.length); // "" | "/..."
      const up = route.upstreamPrefix ?? "";
      requestPath = rest === "" ? (up === "" ? "/" : up) : `${up}${rest}`;
      matched = true;
      break;
    }
    if (!matched) {
      // 路由表 = 白名单：未声明的路径一律拒绝（个人信息端点保护）。
      throw new PathNotOfferedError();
    }
  }
  const strip = service.rewrite?.pathPrefixStrip;
  if (strip !== undefined && (requestPath === strip || requestPath.startsWith(strip + "/"))) {
    // 仅在段边界剥离（strip=/a 命中 /a 与 /a/...，不误伤 /ab）；未携带前缀则原样。
    requestPath = requestPath.slice(strip.length);
    if (requestPath === "") requestPath = "/";
  }
  const append = service.rewrite?.pathPrefixAppend;
  if (append !== undefined) {
    const appendNormalized = normalizeDotSegments(append).replace(/\/+$/, "");
    if (appendNormalized !== "") {
      requestPath = appendNormalized + (requestPath === "/" ? "/" : requestPath);
    }
  }
  const basePath = upstream.pathname === "" ? "/" : upstream.pathname;
  const baseNormalized = normalizeDotSegments(basePath);
  const combined =
    baseNormalized === "/" ? requestPath : `${baseNormalized.replace(/\/+$/, "")}${requestPath}`;
  const finalPath = normalizeDotSegments(combined);

  // 2) 双重断言：origin 一致 + 规范化路径以基础路径为前缀（纵深防御；失败零上游请求）。
  let url: URL;
  try {
    url = new URL(finalPath + (query === "" ? "" : `?${query}`), upstream);
  } catch {
    throw new RewriteError("cannot build upstream URL from service config and request path");
  }
  if (url.origin !== upstream.origin) {
    throw new RewriteError(`upstream origin assertion failed (${url.origin} != ${upstream.origin})`);
  }
  if (!pathHasPrefix(finalPath, baseNormalized)) {
    throw new RewriteError("upstream base path prefix assertion failed");
  }

  // 3) 头链：帧内头（凭据/hop-by-hop 纵深剥离）-> headerRemove -> headerSet($secret/$env)。
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    if (DEFENSIVE_STRIP.has(name)) continue;
    headers[name] = value;
  }
  if (req.contentType !== undefined && req.contentType !== "") {
    headers["content-type"] = req.contentType;
  }
  for (const name of service.rewrite?.headerRemove ?? []) {
    delete headers[name];
  }
  const headerSet = service.rewrite?.headerSet;
  if (headerSet !== undefined) {
    for (const [name, value] of Object.entries(headerSet)) {
      // $secret 未命中在此抛 SecretMissingError（上游 catch 映射 secret_missing）；
      // $env 空串/未设置 = 省略。
      const resolved = await resolveHeaderEntry(value, { script: service.hooks, env, secrets });
      if (resolved === undefined) continue;
      headers[name] = resolved;
    }
  }

  // 4) Host：缺省上游 host（URL.host 已按缺省端口省略端口），rewrite 覆盖。
  const host = service.rewrite?.hostHeader ?? upstream.host;

  return { url, headers, host, isWebSocketUpgrade: isWebSocketUpgradeRequest(req.headers ?? {}) };
}

/** 段边界前缀判定：base 为根恒真；否则 final === base 或以 base/ 开头。 */
function pathHasPrefix(finalPath: string, basePath: string): boolean {
  if (basePath === "/" || basePath === "") return true;
  if (finalPath === basePath) return true;
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  return finalPath.startsWith(`${base}/`);
}
