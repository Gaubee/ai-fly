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

import { FORBIDDEN_REQ_HEADER_NAMES } from "../wire/frames.ts";
import type { ReqHeader } from "../wire/frames.ts";
import { ROUTE_LOCAL_PREFIX } from "../shared/rpc-contract.ts";
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

/**
 * 头值解析：literal 原样；`$secret:<name>` 优先于 `$env:` 判定——命中密钥库返回
 * 完整值，未命中（含空名/空值/未注入密钥源）抛 SecretMissingError（不回退空值、
 * 不省略该头）；`$env:<VAR>` 语义保持——空串/未设置返回 undefined（= 省略该头）。
 * 两者可并存于不同头（逐头独立解析）。
 */
export function resolveHeaderValue(
  value: string,
  env: EnvSource,
  secrets?: SecretSource | undefined,
): string | undefined {
  if (value.startsWith(SECRET_REF_PREFIX)) {
    const name = value.slice(SECRET_REF_PREFIX.length);
    const resolved = secrets?.(name);
    if (resolved === undefined || resolved === "") {
      throw new SecretMissingError();
    }
    return resolved;
  }
  if (!value.startsWith("$env:")) return value;
  const name = value.slice("$env:".length);
  if (name === "") return undefined;
  const resolved = env[name];
  return resolved === undefined || resolved === "" ? undefined : resolved;
}

/** 服务声明的全部 $env 变量名（启动横幅 WARNING 用）。 */
export function collectEnvVarNames(service: ServiceConfig): string[] {
  const names = new Set<string>();
  const headerSet = service.rewrite?.headerSet;
  if (headerSet === undefined) return [];
  for (const value of Object.values(headerSet)) {
    if (value.startsWith("$env:")) {
      const name = value.slice("$env:".length);
      if (name !== "") names.add(name);
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

export function buildUpstreamRequest(
  service: ServiceConfig,
  req: ReqHeader,
  env: EnvSource = process.env,
  secrets?: SecretSource | undefined,
): UpstreamPlan {
  const upstream = parseUpstreamUrl(service.upstream);

  // 1) path：防御性形状检查 -> 按标准路由（最长本地前缀段边界命中 → upstream 前缀
  //    替换；未命中 = 路由表白名单外，本地拒绝零上游请求）-> 前缀剥离 ->
  //    前缀追加 -> 基础路径拼接 -> 点段规范化。
  //    路由改写优先于服务级 strip/append（预设/自定义只应择一使用）。
  assertFramePathShape(req.path);
  const { path: rawPath, query } = splitQuery(req.path);
  let requestPath = rawPath;
  if (service.routes !== undefined && service.routes.length > 0) {
    let matched: { localPrefix: string; upstreamPrefix: string } | null = null;
    for (const route of service.routes) {
      const local = ROUTE_LOCAL_PREFIX[route.form];
      const hit = requestPath === local || requestPath.startsWith(local + "/");
      if (hit && (matched === null || local.length > matched.localPrefix.length)) {
        matched = { localPrefix: local, upstreamPrefix: route.upstreamPrefix };
      }
    }
    if (matched === null) {
      // 路由表 = 白名单：未声明的标准前缀一律拒绝（个人信息端点保护）。
      throw new PathNotOfferedError();
    }
    const rest = requestPath.slice(matched.localPrefix.length); // "" | "/..."
    const up = matched.upstreamPrefix;
    requestPath = rest === "" ? (up === "" ? "/" : up) : `${up}${rest}`;
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
      const resolved = resolveHeaderValue(value, env, secrets);
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
