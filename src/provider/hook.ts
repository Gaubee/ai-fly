// hooks 子系统（hooks-lifecycle v2 阶段化，openspec changes/hooks-lifecycle；
// 六轮 Codex 评审冻结的契约——修改前先对照 proposal「③/④ 运行时契约冻结」节）：
//
// 【资产模型】hooks 脚本是可枚举、可选择的资产：
// - 内建库：<包根>/hooks/<name>.cjs（随 npm 包分发）
// - 用户库：~/.aifly/hooks/<name>.cjs（同名时用户库优先）
//
// 【阶段模型】四段生命周期管线（顺序 = provider/lifecycle.ts STAGE_FN_NAMES）：
// - ① onRequestBearerAuthentication(ctx)：Authorization 头取值（返回裸值，
//   Bearer 前缀由配置的 auth.bearer 拼）。**仅有的三态返回契约**：
//   string（每请求拉取）| Promise<string>（await）| AsyncIterable<string>
//   （订阅模式——首请求建立后台消费循环逐 yield 更新 latest，后续请求读
//   latest；watch/推送语义）。失败归 secret_missing 族（HookMissingError）。
// - ② onRequestHeaders(ctx)：返回 `{set?, remove?}` 增量对象（同步或
//   Promise；`{}` = 合法 no-op）。set 值必须 string、remove 必须 string[]，
//   头数量 ≤32 / 键 ≤1KiB / 值 ≤8KiB（wire 帧资源上限）；非法 → hook_failed。
// - ③ onRequest(ctx)：整体接管出站。ctx 含 {url, method, headers, body:
//   Uint8Array, signal}；返回 {status: 200..599, headers, body?}（body 接受
//   ReadableStream|AsyncIterable；缺省 = 空流，由引擎归一层补齐）。
// - ④ onResponse(ctx)：响应后处理。ctx 含 {status, headers, body:
//   AsyncIterable<Uint8Array>, signal}；返回 {status?, headers?, body?} 局部
//   覆盖（body 接受 ReadableStream|AsyncIterable）。
// ②③④ 缺席（绑定声明但导出缺失）/抛错/返回形状非法 → HookStageError
// （hook_failed 族，消息脱敏固定文案——不含脚本路径与返回值）。
//
// 【ctx 超集】所有阶段 ctx 含既有 {homedir, args, secrets, env}；①② 另附
// 请求级 {method, path, headers}。
//
// 【发现规范】discoverHooks 枚举两库脚本并输出**阶段矩阵**（stages: 按导出的
// 阶段函数名归类）+ fns（原始导出函数名清单——hooks run 管理面按名调用用）。
// 旧导出名（如 authHeader）不在 stages 内：UI 按阶段过滤自然排除，提示重写。
//
// 【消费面分层】本文件是纯函数层（发现 + 调用 + 形状校验 + 错误分族）；
// 接线到 upstream/rewrite 管道（probeConnect 跳过、归一层取消传播等）在
// upstream.ts/rewrite.ts（Agent C 任务 4.x）。
//
// 信任模型：脚本以 ai-fly 同权限执行宿主 IO（无 VM 隔离——node:vm 非安全
// 边界且 Bun/Deno 支持残缺，Owner 取简方案）。模块经 require 缓存——
// 脚本文件修改需重启进程；值的动态性由 ① 三态契约承担。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { STAGE_FN_NAMES, type StageFnName } from "./lifecycle.ts";

// ---------------------------------------------------------------------------
// 阶段名（re-export 维持单源；消费方不重复声明）
// ---------------------------------------------------------------------------

export { STAGE_FN_NAMES };
export type { StageFnName };

// ---------------------------------------------------------------------------
// ctx 与错误
// ---------------------------------------------------------------------------

export interface HookCtx {
  homedir: string;
  args: Record<string, string>;
  /** 密钥库访问器（SecretsStore 桥；值只进头，不回显）。 */
  secrets: (name: string) => string | undefined;
  /** 环境变量访问器（缺省回落 process.env；引擎注入请求级 env 源）。 */
  env: (name: string) => string | undefined;
  /** ①② 请求级扩展（v2）：当前请求的 method/path/headers（头键小写字典）。 */
  method?: string | undefined;
  path?: string | undefined;
  headers?: Record<string, string> | undefined;
}

/** ① 三态返回（string | Promise | AsyncIterable 订阅）。 */
export type HookResult = string | Promise<string> | AsyncIterable<string>;
export type HookFn = (ctx: HookCtx) => HookResult;

/**
 * ① auth 阶段脚本失效（secret_missing 族）：零上游请求；消息固定——不含
 * 脚本名/路径/值（错误帧会过网）。
 */
export class HookMissingError extends Error {
  constructor() {
    super("credential source missing");
    this.name = "HookMissingError";
  }
}

/** ②③④ 阶段脚本失效的统一脱敏文案（hook_failed 族；不内插任何脚本细节）。 */
const HOOK_STAGE_FAILED_MESSAGE = "hook stage failed";

/**
 * ②③④ 阶段脚本失效（hook_failed 族）：导出缺席、调用抛错、返回形状非法、
 * 上限超限均归此；消息固定脱敏——MUST NOT 含脚本名/路径/返回值。
 */
export class HookStageError extends Error {
  constructor() {
    super(HOOK_STAGE_FAILED_MESSAGE);
    this.name = "HookStageError";
  }
}

// ---------------------------------------------------------------------------
// ② 返回形状契约（对象 + wire 帧资源上限）
// ---------------------------------------------------------------------------

/** ② onRequestHeaders 的增量返回形状（`{}` = 合法 no-op）。 */
export interface StageHeadersResult {
  set?: Record<string, string> | undefined;
  remove?: string[] | undefined;
}

/** wire 帧资源上限（hooks-lifecycle 冻结：头数量 ≤32 / 键 ≤1KiB / 值 ≤8KiB）。 */
export const STAGE_HEADER_LIMITS = {
  maxCount: 32,
  nameMaxBytes: 1024,
  valueMaxBytes: 8192,
} as const;

const BYTE_LEN = new TextEncoder();

function byteLen(value: string): number {
  return BYTE_LEN.encode(value).length;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isAsyncIterableObj(v: unknown): v is AsyncIterable<unknown> {
  return v !== null && typeof v === "object" && Symbol.asyncIterator in (v as object);
}

function isReadableStreamLike(v: unknown): v is ReadableStream {
  return typeof ReadableStream === "function" && v instanceof ReadableStream;
}

// ---------------------------------------------------------------------------
// 脚本定位与加载
// ---------------------------------------------------------------------------

/** 包根（向上找 name=ai-fly 的 package.json；dev 仓库与安装布局皆成立）。 */
function packageRoot(start = dirname(fileURLToPath(import.meta.url))): string {
  let dir = resolve(start);
  for (let hops = 0; hops < 12; hops += 1) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(pkg, "utf8"));
        if (parsed !== null && typeof parsed === "object" && (parsed as { name?: unknown }).name === "ai-fly") {
          return dir;
        }
      } catch {
        // 损坏 package.json——继续向上
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export interface HookScriptPaths {
  userDir: string;
  builtinDir: string;
}

export function hookScriptPaths(home = homedir()): HookScriptPaths {
  return { userDir: join(home, ".aifly", "hooks"), builtinDir: join(packageRoot(), "hooks") };
}

function scriptCandidates(name: string, paths: HookScriptPaths): string[] {
  const bases = [join(paths.userDir, name), join(paths.builtinDir, name)];
  const out: string[] = [];
  for (const b of bases) {
    out.push(`${b}.cjs`, b.endsWith(".cjs") || b.endsWith(".js") ? b : `${b}.js`);
  }
  return out;
}

/** 加载 hooks 脚本模块（用户库优先于内建库；缺席返回 undefined）。 */
export function loadHookScript(name: string, home = homedir()): Record<string, unknown> | undefined {
  if (name === "" || name.includes("/") || name.includes("..")) return undefined;
  const req = createRequire(import.meta.url);
  for (const candidate of scriptCandidates(name, hookScriptPaths(home))) {
    if (!existsSync(candidate)) continue;
    try {
      const mod: unknown = req(candidate);
      if (mod !== null && typeof mod === "object") return mod as Record<string, unknown>;
    } catch {
      // 脚本抛错视为不可用（发现面容忍；消费面在调用时再报）
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 发现（阶段矩阵 + 导出函数名清单）
// ---------------------------------------------------------------------------

export interface HookScriptInfo {
  /** 脚本名（服务配置各阶段槽的脚本绑定名）。 */
  name: string;
  source: "user" | "builtin";
  /** 导出的函数名清单（命名规范发现；hooks run 管理面按名调用）。 */
  fns: string[];
  /** 阶段矩阵：按 STAGE_FN_NAMES 发现的阶段导出（顺序 = 管线执行顺序）。
   *  旧导出名（如 v1 authHeader）不在此列——UI 按阶段过滤自然排除。 */
  stages: StageFnName[];
}

/** 模块导出面的钩子函数名（typeof function 且非下划线开头）。 */
export function exportedHookFns(mod: Record<string, unknown>): string[] {
  return Object.keys(mod).filter((k) => !k.startsWith("_") && typeof mod[k] === "function").sort();
}

/** 模块导出面的阶段函数矩阵（按 STAGE_FN_NAMES 顺序过滤 typeof function）。 */
export function stageFnsOf(mod: Record<string, unknown>): StageFnName[] {
  return STAGE_FN_NAMES.filter((name) => typeof mod[name] === "function");
}

function dirScriptNames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".cjs"))
      .map((f) => f.slice(0, -".cjs".length));
  } catch {
    return [];
  }
}

/** 枚举可用 hooks 脚本及其阶段矩阵（用户库优先；内建同名被覆盖不重复列出）。 */
export function discoverHooks(home = homedir()): HookScriptInfo[] {
  const paths = hookScriptPaths(home);
  const seen = new Map<string, HookScriptInfo>();
  for (const name of dirScriptNames(paths.userDir)) {
    const mod = loadHookScript(name, home);
    if (mod === undefined) continue;
    seen.set(name, { name, source: "user", fns: exportedHookFns(mod), stages: stageFnsOf(mod) });
  }
  for (const name of dirScriptNames(paths.builtinDir)) {
    if (seen.has(name)) continue;
    const mod = loadHookScript(name, home);
    if (mod === undefined) continue;
    seen.set(name, { name, source: "builtin", fns: exportedHookFns(mod), stages: stageFnsOf(mod) });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// 三态取值（① 拉取 / 订阅——唯一保留订阅语义的契约）
// ---------------------------------------------------------------------------

function isAsyncIterable(v: unknown): v is AsyncIterable<string> {
  return v !== null && typeof v === "object" && Symbol.asyncIterator in (v as object);
}

interface Subscription {
  latest?: string;
  iterator?: AsyncIterator<string>;
}
const subscriptions = new Map<string, Subscription>();

/** 建立订阅并等待首个 yield：返回首值（后续值由后台循环更新 latest）。 */
function startSubscription(
  key: string,
  stream: AsyncIterable<string>,
  sub: Subscription,
): Promise<string | undefined> {
  sub.iterator = stream[Symbol.asyncIterator]();
  return new Promise((resolveFirst) => {
    let firstSettled = false;
    void (async () => {
      try {
        const it = sub.iterator!;
        for (;;) {
          const r = await it.next();
          if (r.done === true) break;
          if (typeof r.value === "string" && r.value !== "") {
            sub.latest = r.value;
            if (firstSettled === false) {
              firstSettled = true;
              resolveFirst(r.value);
            }
          }
        }
      } catch {
        // 迭代出错：保留最后有效值（错误不外泄脚本路径）
      }
      if (firstSettled === false) {
        firstSettled = true;
        resolveFirst(undefined); // 流自然结束且无值
      }
    })();
  });
}

/** 回收全部订阅（daemon stop / 测试收尾）。return() 对挂起在内部 await 的
 *  生成器（如等待 watch 事件）可能永不结算——300ms 竞速后放弃该迭代器。 */
export async function disposeHookSubscriptions(): Promise<void> {
  const subs = [...subscriptions.entries()];
  subscriptions.clear();
  await Promise.all(
    subs.map(async ([, sub]) => {
      try {
        await Promise.race([
          sub.iterator?.return?.(undefined) ?? Promise.resolve(),
          new Promise((r) => setTimeout(r, 300)),
        ]);
      } catch {
        // 终止失败不阻塞回收
      }
    }),
  );
}

export interface ResolveHookOptions {
  /** 服务选中的 hooks 脚本名。 */
  script: string;
  home?: string;
  args?: Record<string, string>;
  secrets?: (name: string) => string | undefined;
  env?: (name: string) => string | undefined;
  /** ①② 请求级 ctx 扩展（v2：当前请求的 method/path/headers）。 */
  request?: { method: string; path: string; headers: Record<string, string> } | undefined;
  /** 测试注入：脚本模块加载面。 */
  loader?: (name: string, home: string) => Record<string, unknown> | undefined;
}

function baseHookCtx(opts: ResolveHookOptions, home: string): HookCtx {
  const request = opts.request;
  return {
    homedir: home,
    args: opts.args ?? {},
    secrets: (n) => opts.secrets?.(n),
    env: (n) => opts.env?.(n) ?? process.env[n],
    ...(request !== undefined
      ? { method: request.method, path: request.path, headers: { ...request.headers } }
      : {}),
  };
}

/**
 * 解析一次钩子取值（① 阶段函数 / hooks run 管理面共用）。
 * 订阅键 = script|fn —— 同键首个请求建立订阅，后续读 latest。
 * 任何未命中（脚本/函数缺席、调用抛错、非字符串、空串、订阅未出首值）
 * 抛 HookMissingError（零上游请求；信息不含脚本路径与值）。
 */
export async function resolveHookValue(
  fnName: string,
  opts: ResolveHookOptions,
): Promise<string> {
  const home = opts.home ?? homedir();
  // 订阅键含 home 作用域（复核 R2-P2）：多实例/跨 HOME 测试不串订阅缓存。
  const key = `${home}|${opts.script}|${fnName}`;
  const loader = opts.loader ?? loadHookScript;
  const mod = loader(opts.script, home);
  const raw = mod?.[fnName];
  if (typeof raw !== "function") throw new HookMissingError();
  let result: HookResult;
  try {
    result = (raw as HookFn)(baseHookCtx(opts, home));
  } catch {
    throw new HookMissingError();
  }
  if (isAsyncIterable(result)) {
    let sub = subscriptions.get(key);
    if (sub === undefined) {
      sub = {};
      subscriptions.set(key, sub);
      // 首请求：等待首个 yield（立即产值的 watch 流即刻可用；纯事件驱动流
      // 阻塞至首个事件）；订阅后台续消费后续值更新 latest
      const first = await startSubscription(key, result, sub);
      if (first === undefined) throw new HookMissingError();
      return first;
    }
    if (sub.latest === undefined) throw new HookMissingError();
    return sub.latest;
  }
  let awaited: HookResult;
  try {
    awaited = await result;
  } catch {
    // Promise 拒绝与同步抛错同族归一（复核 R1-F7：不外泄脚本原始异常）
    throw new HookMissingError();
  }
  if (typeof awaited !== "string" || awaited === "") throw new HookMissingError();
  return awaited;
}

// ---------------------------------------------------------------------------
// 阶段解析器（纯函数层：调用 + 形状校验 + 错误分族）
// ---------------------------------------------------------------------------

/** 阶段解析共用基础面（脚本加载 + 基础 ctx 源 + 测试注入）。 */
export interface StageResolveBase {
  home?: string | undefined;
  secrets?: ((name: string) => string | undefined) | undefined;
  env?: ((name: string) => string | undefined) | undefined;
  /** 测试注入：脚本模块加载面。 */
  loader?: ((name: string, home: string) => Record<string, unknown> | undefined) | undefined;
}

/** ①② 的请求级描述子。 */
export interface StageRequestCtx {
  method: string;
  path: string;
  headers: Record<string, string>;
}

/** ③ onRequest 的请求级 ctx（spec 冻结形状）。 */
export interface RequestStageCtx {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
  signal: AbortSignal;
}

/** ④ onResponse 的响应级 ctx（spec 冻结形状）。 */
export interface ResponseStageCtx {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  signal: AbortSignal;
}

/** ③ 返回形状：status 限 200-599（1xx 非最终响应，越界即形状非法）。 */
export interface RequestStageResult {
  status: number;
  headers: Record<string, string>;
  body?: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | undefined;
}

/** ④ 返回形状：局部覆盖（status/headers/body 均可缺省）。 */
export interface ResponseStageResult {
  status?: number | undefined;
  headers?: Record<string, string> | undefined;
  body?: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | undefined;
}

/** 脚本槽绑定（headers.script / request / response 共用：{name, args?}）。 */
export interface StageScriptBinding {
  name: string;
  args?: Record<string, string> | undefined;
}

function loadStageFn(
  scriptName: string,
  fnName: StageFnName,
  base: StageResolveBase,
  home: string,
): (ctx: Record<string, unknown>) => unknown {
  const loader = base.loader ?? loadHookScript;
  const mod = loader(scriptName, home);
  const raw = mod?.[fnName];
  if (typeof raw !== "function") throw new HookStageError();
  return raw as (ctx: Record<string, unknown>) => unknown;
}

/** 阶段脚本的基础 ctx 面（③④ 调用壳共用）。 */
function stageBaseCtx(base: StageResolveBase, binding: StageScriptBinding, home: string): Record<string, unknown> {
  return {
    homedir: home,
    args: binding.args ?? {},
    secrets: (n: string) => base.secrets?.(n),
    env: (n: string) => base.env?.(n) ?? process.env[n],
  };
}

/**
 * ① onRequestBearerAuthentication：auth 槽脚本绑定取值（裸值——Bearer 前缀
 * 由配置层拼）。三态契约（string | Promise | AsyncIterable 订阅缓存）平移
 * 保留；任何失效（缺席/抛错/空产出/订阅未出首值）归 secret_missing 族
 * （HookMissingError——零上游请求、消息不泄脚本名与值）。
 */
export async function resolveStageAuth(
  binding: { script: string; args?: Record<string, string> | undefined },
  opts: StageResolveBase & { request?: StageRequestCtx | undefined },
): Promise<string> {
  try {
    return await resolveHookValue("onRequestBearerAuthentication", {
      script: binding.script,
      ...(binding.args !== undefined ? { args: binding.args } : {}),
      ...(opts.home !== undefined ? { home: opts.home } : {}),
      ...(opts.secrets !== undefined ? { secrets: opts.secrets } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.request !== undefined ? { request: opts.request } : {}),
      ...(opts.loader !== undefined ? { loader: opts.loader } : {}),
    });
  } catch (err) {
    // ① 失败族归一：resolveHookValue 自身已归 HookMissingError，此处兜底
    // 非预期异常类型（防御——不外泄任何脚本细节）。
    throw err instanceof HookMissingError ? err : new HookMissingError();
  }
}

/**
 * ② onRequestHeaders：headers 槽整段脚本调用与返回形状校验。
 * 返回 `{set?, remove?}`（同步或 Promise；`{}` 合法 no-op）；set 值必须
 * string、remove 必须 string[]；头数量 ≤32 / 键 ≤1KiB / 值 ≤8KiB。
 * 绑定缺席（导出缺失）/抛错/形状非法/上限超限 → HookStageError。
 */
export async function resolveStageHeaders(
  binding: StageScriptBinding,
  request: StageRequestCtx,
  base: StageResolveBase = {},
): Promise<StageHeadersResult> {
  const home = base.home ?? homedir();
  const fn = loadStageFn(binding.name, "onRequestHeaders", base, home);
  let returned: unknown;
  try {
    returned = await fn({
      ...stageBaseCtx(base, binding, home),
      method: request.method,
      path: request.path,
      headers: { ...request.headers },
    });
  } catch {
    throw new HookStageError();
  }
  if (!isPlainObject(returned)) throw new HookStageError();
  // 顶层键 strict（复核 R1-F7）：`{sets: ...}` 这类拼错若被宽容吞掉会静默
  // no-op——未知键一律 hook_failed（spec「非法一律 hook_failed」）。
  for (const key of Object.keys(returned)) {
    if (key !== "set" && key !== "remove") throw new HookStageError();
  }
  const out: StageHeadersResult = {};
  if (returned.remove !== undefined) {
    if (!Array.isArray(returned.remove)) throw new HookStageError();
    if (returned.remove.length > STAGE_HEADER_LIMITS.maxCount) throw new HookStageError();
    const remove: string[] = [];
    for (const name of returned.remove) {
      if (typeof name !== "string" || name === "" || byteLen(name) > STAGE_HEADER_LIMITS.nameMaxBytes) {
        throw new HookStageError();
      }
      remove.push(name);
    }
    out.remove = remove;
  }
  if (returned.set !== undefined) {
    if (!isPlainObject(returned.set)) throw new HookStageError();
    const entries = Object.entries(returned.set);
    if (entries.length > STAGE_HEADER_LIMITS.maxCount) throw new HookStageError();
    const set: Record<string, string> = {};
    for (const [name, value] of entries) {
      if (
        name === "" ||
        byteLen(name) > STAGE_HEADER_LIMITS.nameMaxBytes ||
        typeof value !== "string" ||
        byteLen(value) > STAGE_HEADER_LIMITS.valueMaxBytes
      ) {
        throw new HookStageError();
      }
      set[name] = value;
    }
    out.set = set;
  }
  return out;
}

/** 头记录形状校验（③④ 返回的 headers：Record<string,string> + 上限）。 */
function validateStageHeaders(headers: unknown): Record<string, string> {
  if (!isPlainObject(headers)) throw new HookStageError();
  const entries = Object.entries(headers);
  if (entries.length > STAGE_HEADER_LIMITS.maxCount) throw new HookStageError();
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (
      name === "" ||
      byteLen(name) > STAGE_HEADER_LIMITS.nameMaxBytes ||
      typeof value !== "string" ||
      byteLen(value) > STAGE_HEADER_LIMITS.valueMaxBytes
    ) {
      throw new HookStageError();
    }
    out[name] = value;
  }
  return out;
}

function validateStageBody(
  body: unknown,
): ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | undefined {
  if (body === undefined || body === null) return undefined;
  if (isReadableStreamLike(body) || isAsyncIterableObj(body)) {
    return body as ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
  }
  throw new HookStageError();
}

/**
 * ③ onRequest：request 槽脚本调用壳（纯函数层——只做调用 + 形状校验 +
 * 错误归 hook_failed；接线到 upstream/出站归一层在 Agent C 任务 4.2）。
 * ctx = 基础面 + {url, method, headers, body: Uint8Array, signal}；返回
 * {status: 200..599, headers: Record<string,string>, body?}（body 缺省 =
 * 空流，由引擎归一层补齐；1xx/6xx 越界即形状非法）。
 */
export async function resolveStageRequest(
  binding: StageScriptBinding,
  ctx: RequestStageCtx,
  base: StageResolveBase = {},
): Promise<RequestStageResult> {
  const home = base.home ?? homedir();
  const fn = loadStageFn(binding.name, "onRequest", base, home);
  let returned: unknown;
  try {
    returned = await fn({
      ...stageBaseCtx(base, binding, home),
      url: ctx.url,
      method: ctx.method,
      headers: { ...ctx.headers },
      body: ctx.body,
      signal: ctx.signal,
    });
  } catch {
    throw new HookStageError();
  }
  if (!isPlainObject(returned)) throw new HookStageError();
  // 顶层键 strict（复核 R3-P2，与 ② 同规）：未知键（拼错）一律 hook_failed，
  // 拒绝静默 no-op。
  for (const key of Object.keys(returned)) {
    if (key !== "status" && key !== "headers" && key !== "body") throw new HookStageError();
  }
  const status = returned.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) {
    throw new HookStageError();
  }
  const headers = validateStageHeaders(returned.headers);
  const body = validateStageBody(returned.body);
  return { status, headers, ...(body !== undefined ? { body } : {}) };
}

/**
 * ④ onResponse：response 槽脚本调用壳（纯函数层；接线到 RESP_META 前的
 * 引擎管道在 Agent C 任务 4.3）。ctx = 基础面 + {status, headers, body:
 * AsyncIterable<Uint8Array>, signal}；返回 {status?, headers?, body?} 局部
 * 覆盖（status 域同 ③ 的 200..599；头白名单过滤归引擎投影层）。
 */
export async function resolveStageResponse(
  binding: StageScriptBinding,
  ctx: ResponseStageCtx,
  base: StageResolveBase = {},
): Promise<ResponseStageResult> {
  const home = base.home ?? homedir();
  const fn = loadStageFn(binding.name, "onResponse", base, home);
  let returned: unknown;
  try {
    returned = await fn({
      ...stageBaseCtx(base, binding, home),
      status: ctx.status,
      headers: { ...ctx.headers },
      body: ctx.body,
      signal: ctx.signal,
    });
  } catch {
    throw new HookStageError();
  }
  if (!isPlainObject(returned)) throw new HookStageError();
  // 顶层键 strict（复核 R3-P2，与 ②③ 同规）。
  for (const key of Object.keys(returned)) {
    if (key !== "status" && key !== "headers" && key !== "body") throw new HookStageError();
  }
  const out: ResponseStageResult = {};
  if (returned.status !== undefined) {
    const status = returned.status;
    if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) {
      throw new HookStageError();
    }
    out.status = status;
  }
  if (returned.headers !== undefined) {
    out.headers = validateStageHeaders(returned.headers);
  }
  const body = validateStageBody(returned.body);
  if (body !== undefined) out.body = body;
  return out;
}

// ---------------------------------------------------------------------------
// 管理面（与 group/secret 同构的资源域：list/get/add/remove + run）
// ---------------------------------------------------------------------------

import { mkdirSync, rmSync, writeFileSync } from "node:fs";

/** 脚本名合法性（资源标识符；防路径逃逸）。 */
export function validHookName(name: string): boolean {
  return /^[a-z][a-z0-9_-]{0,63}$/.test(name);
}

export function userHookPath(name: string, home = homedir()): string {
  return join(hookScriptPaths(home).userDir, `${name}.cjs`);
}

export interface UserHookInstall {
  name: string;
  path: string;
  fns: string[];
  /** 阶段矩阵（hooks.add RPC 输出投影用；stages-only 契约归 5.1）。 */
  stages: StageFnName[];
}

/**
 * 安装用户 hooks 脚本（写入 ~/.aifly/hooks/<name>.cjs 并校验可加载、
 * 至少导出一个钩子函数）。内建同名允许覆盖（用户库优先语义）。
 */
export function installUserHook(name: string, content: string, home = homedir()): UserHookInstall {
  if (!validHookName(name)) {
    throw new Error(`invalid hook script name '${name}' (lowercase identifier, 1-64 chars)`);
  }
  const paths = hookScriptPaths(home);
  mkdirSync(paths.userDir, { recursive: true });
  const path = userHookPath(name, home);
  writeFileSync(path, content, { mode: 0o600 });
  // 校验：隔离目录下加载（避免新写入文件污染当前进程的 require 缓存语义）
  const mod = loadHookScript(name, home);
  if (mod === undefined) {
    rmSync(path, { force: true });
    throw new Error("hook script failed to load (syntax error or non-object export)");
  }
  const fns = exportedHookFns(mod);
  if (fns.length === 0) {
    rmSync(path, { force: true });
    throw new Error("hook script exports no hook functions (named function exports required)");
  }
  return { name, path, fns, stages: stageFnsOf(mod) };
}

/** 删除用户脚本（内建库不可删；未命中报错）。 */
export function removeUserHook(name: string, home = homedir()): { path: string } {
  const path = userHookPath(name, home);
  if (!existsSync(path)) {
    // 用户库缺席但内建同名存在 → 明确拒绝（与"内建不可删"一致）
    const builtin = join(hookScriptPaths(home).builtinDir, `${name}.cjs`);
    if (existsSync(builtin)) {
      throw new Error(`'${name}' is a builtin hook script (cannot be removed)`);
    }
    throw new Error(`hook script '${name}' not found`);
  }
  rmSync(path, { force: true });
  return { path };
}

/** 读取用户脚本内容（get/show；内建脚本返回包内内容）。 */
export function readHookScript(name: string, home = homedir()): { path: string; source: "user" | "builtin"; content: string } | undefined {
  const user = userHookPath(name, home);
  if (existsSync(user)) {
    return { path: user, source: "user", content: readFileSync(user, "utf8") };
  }
  const builtin = join(hookScriptPaths(home).builtinDir, `${name}.cjs`);
  if (existsSync(builtin)) {
    return { path: builtin, source: "builtin", content: readFileSync(builtin, "utf8") };
  }
  return undefined;
}
