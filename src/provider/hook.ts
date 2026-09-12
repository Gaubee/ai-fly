// hooks 子系统（Owner 裁决 2026-09-12，多轮收敛的最终形态）：
//
// 【资产模型】hooks 脚本是可枚举、可选择的资产：
// - 内建库：<包根>/hooks/<name>.cjs（随 npm 包分发）
// - 用户库：~/.aifly/hooks/<name>.cjs（同名时用户库优先）
//
// 【发现规范】脚本内导出的函数名 = 钩子清单（discoverHooks 枚举两者并聚合）。
// 命名规范（当前消费面 + 未来扩展锚点，均按函数名发现）：
// - authHeader(ctx)：HTTP 认证头钩子（本实现唯一的消费点：headerSet 值）
// - onRequest/onResponse（未实现）：对象级改写钩子——未来在服务配置
//   hooks: {request?: ..., response?: ...} 位置消费，见 rewrite.ts 头注释
//
// 【契约】authHeader(ctx) 三态返回：
// - string：每请求拉取
// - Promise<string>：每请求拉取（await）
// - AsyncIterable<string>：订阅模式——首个请求建立后台消费循环，逐 yield
//   更新 latest，后续请求读 latest（watch/推送语义）
// ctx = { homedir, args, secrets }（secrets 为密钥库访问器：值只进头不回显）
//
// 【配置面】服务配置 hooks: "<scriptName>"（选中脚本）；headerSet 值两协议：
// 字面量 string 原样 | { hook: "<函数名>", args?, bearer? }（取所选脚本
// 该函数的返回值；bearer=true 拼 "Bearer " 前缀）。
//
// 信任模型：脚本以 ai-fly 同权限执行宿主 IO（无 VM 隔离——node:vm 非安全
// 边界且 Bun/Deno 支持残缺，Owner 取简方案）。模块经 require 缓存——
// 脚本文件修改需重启进程；值的动态性由三态契约承担。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export interface HookCtx {
  homedir: string;
  args: Record<string, string>;
  /** 密钥库访问器（SecretsStore 桥；值只进头，不回显）。 */
  secrets: (name: string) => string | undefined;
  /** 环境变量访问器（缺省回落 process.env；引擎注入请求级 env 源）。 */
  env: (name: string) => string | undefined;
}

export type HookResult = string | Promise<string> | AsyncIterable<string>;
export type HookFn = (ctx: HookCtx) => HookResult;

/** headerSet 值两协议：字面量 | 钩子调用。 */
export type HeaderValue =
  | string
  | { hook: string; args?: Record<string, string> | undefined; bearer?: boolean | undefined };

export class HookMissingError extends Error {
  constructor() {
    super("credential source missing");
    this.name = "HookMissingError";
  }
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
// 发现（函数名命名规范 → 钩子清单）
// ---------------------------------------------------------------------------

export interface HookScriptInfo {
  /** 脚本名（服务配置 hooks 字段的取值）。 */
  name: string;
  source: "user" | "builtin";
  /** 导出的钩子函数名清单（命名规范发现）。 */
  fns: string[];
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

/** 枚举可用 hooks 脚本及其钩子清单（用户库优先；内建同名被覆盖不重复列出）。 */
export function discoverHooks(home = homedir()): HookScriptInfo[] {
  const paths = hookScriptPaths(home);
  const seen = new Map<string, HookScriptInfo>();
  for (const name of dirScriptNames(paths.userDir)) {
    const mod = loadHookScript(name, home);
    if (mod === undefined) continue;
    seen.set(name, { name, source: "user", fns: exportedHookFns(mod) });
  }
  for (const name of dirScriptNames(paths.builtinDir)) {
    if (seen.has(name)) continue;
    const mod = loadHookScript(name, home);
    if (mod === undefined) continue;
    seen.set(name, { name, source: "builtin", fns: exportedHookFns(mod) });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 模块导出面的钩子函数名（typeof function 且非下划线开头）。 */
export function exportedHookFns(mod: Record<string, unknown>): string[] {
  return Object.keys(mod).filter((k) => !k.startsWith("_") && typeof mod[k] === "function").sort();
}

// ---------------------------------------------------------------------------
// 三态取值（拉取 / 订阅）
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
 * 生成器（如等待 watch 事件）可能永不结算——300ms 竞速后放弃该迭代器。 */
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
  /** 测试注入：脚本模块加载面。 */
  loader?: (name: string, home: string) => Record<string, unknown> | undefined;
}

/**
 * 解析一次钩子取值（headerSet 的 {hook,...} 协议消费点）。
 * 订阅键 = script|fn —— 同键首个请求建立订阅，后续读 latest。
 * 任何未命中（脚本/函数缺席、调用抛错、非字符串、空串、订阅未出首值）
 * 抛 HookMissingError（零上游请求；信息不含脚本路径与值）。
 */
export async function resolveHookValue(
  fnName: string,
  opts: ResolveHookOptions,
): Promise<string> {
  const home = opts.home ?? homedir();
  const loader = opts.loader ?? loadHookScript;
  const mod = loader(opts.script, home);
  const raw = mod?.[fnName];
  if (typeof raw !== "function") throw new HookMissingError();
  let result: HookResult;
  try {
    result = (raw as HookFn)({
      homedir: home,
      args: opts.args ?? {},
      secrets: (n) => opts.secrets?.(n),
      env: (n) => opts.env?.(n) ?? process.env[n],
    });
  } catch {
    throw new HookMissingError();
  }
  const key = `${opts.script}|${fnName}`;
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
  const awaited = await result;
  if (typeof awaited !== "string" || awaited === "") throw new HookMissingError();
  return awaited;
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
  return { name, path, fns };
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
