// HTTP 上游转发：REQ（重组完成）-> 出站归一层 -> RESP_META / RESP_CHUNK /
// RESP_END / ERROR。超时族（design A6）：连接期 10s（TCP 探测，fetch 不暴露连接
// 建立，探测失败/超时回 upstream_unreachable；绑定 ③ request 脚本时跳过——连接
// 语义归脚本）、首字节 600s（fetch resolve / ③ 脚本返回 = 响应头到达）、流停滞
// 120s（分片间）、首字节等待期每 30s PING(id) 并挂起提供方侧空闲计时。
// hooks-lifecycle v2 出站归一层（任务 4.2/4.3）：原生 fetch 结果与 ③ onRequest
// 脚本结果统一归一为 {status, headers, body: AsyncIterable<Uint8Array>}，转发
// 循环只消费归一形（SSE 逐块、禁止缓冲攒齐；waitOutboundQueue 背压门控保留）；
// ③ 返回 headers 小写化/last-wins/经 RESP_META 白名单过滤（content-type 独立
// 投影 contentType）；④ onResponse 在归一后、RESP_META 下发前插入（局部覆盖
// status/白名单内头/流式 body）；引擎中止 cancel 归一迭代器（ReadableStream 走
// cancel、AsyncIterable 调 return()）传播到脚本流。fetchImpl 测试注入缝在原生
// 路径保留。错误分族：HookStageError（②③④ 缺席/抛错/形状非法/流中途失败）→
// ERROR(hook_failed)；① HookMissingError 与 $secret 缺失 → secret_missing。
// 正交意图（本文件不实现）：
// - 授权/限额（引擎在拨号前完成；本层只转发已放行请求）；
// - REQ 重组（mux + 引擎；本层收到的是完整正文）；
// - WS 升级通道（ws-upstream.ts；本文件在构造 plan 后分流——①② 头链对 WS
//   生效，③ request 接管不适用于 WS）。
// 上游 URL 目标仅来自本地服务配置（rewrite 断言过），帧内字段不影响 origin（防SSRF）。

import { connect as netConnect } from "node:net";
import type { ReqHeader, ErrorCodeValue } from "../wire/frames.ts";
import { ERROR_CODE, FRAME_TYPE, RESP_META_HEADER_WHITELIST } from "../wire/frames.ts";
import { DEFAULT_BODY_CHUNK_BYTES } from "../wire/codec.ts";
import type { WireSession } from "../wire/mux.ts";
import type { ServiceConfig } from "./store.ts";
import type { UsageRecord } from "./limits.ts";
import {
  HookMissingError,
  HookStageError,
  resolveStageRequest,
  resolveStageResponse,
  type StageResolveBase,
} from "./hook.ts";
import { buildUpstreamRequest, type EnvSource, type SecretSource, type UpstreamPlan } from "./rewrite.ts";
import { PathNotOfferedError, RewriteError, SecretMissingError } from "./rewrite.ts";
import type { WsRelayHandle } from "./ws-upstream.ts";
import { forwardWsUpgrade } from "./ws-upstream.ts";

/** 上游超时族（全部可配；测试注入小值）。 */
export interface UpstreamTimeouts {
  /** 上游连接期（TCP 探测窗）。 */
  connectMs: number;
  /** 首字节（fetch resolve = 响应头到达）。 */
  firstByteMs: number;
  /** 流中途停滞（分片间隔）。 */
  stallMs: number;
  /** 首字节等待期 PING 节奏。 */
  pingMs: number;
}

export const DEFAULT_UPSTREAM_TIMEOUTS: UpstreamTimeouts = {
  connectMs: 10_000,
  firstByteMs: 600_000,
  stallMs: 120_000,
  pingMs: 30_000,
};

/** 引擎侧主动中止（abort reason）：code = 回送 ERROR 码；reply=false 不回帧。 */
export class UpstreamAbortError extends Error {
  readonly code: ErrorCodeValue;
  readonly reply: boolean;

  constructor(code: ErrorCodeValue, reply = true) {
    super(`upstream forward aborted: ${code}`);
    this.name = "UpstreamAbortError";
    this.code = code;
    this.reply = reply;
  }
}

/** 连接期探测失败/超时（upstream_unreachable 语义；内部区分 fetch 失败文案用）。 */
class ProbeFailedError extends Error {
  constructor() {
    super("upstream connect failed or timed out");
    this.name = "ProbeFailedError";
  }
}

export interface ForwardCtx {
  session: WireSession;
  id: string;
  service: ServiceConfig;
  req: ReqHeader;
  /** 完整请求正文（引擎已重组；③ onRequest ctx 原样透传）。 */
  body: Uint8Array;
  /** 引擎控制信号（ABORT / idle / 断连），abort reason 为 UpstreamAbortError。 */
  signal: AbortSignal;
  /** 授权密钥（限额归属 / 用量记录）。 */
  keyId: string;
  timeouts?: Partial<UpstreamTimeouts> | undefined;
  onUsage?: ((record: UsageRecord) => void) | undefined;
  /** $env 解析源（默认 process.env）。 */
  env?: EnvSource | undefined;
  /** $secret 解析源（密钥库读取面；未注入时任何 $secret 引用按 secret_missing 拒绝）。 */
  secrets?: SecretSource | undefined;
  /** ①②③④ 脚本库 home 基准（缺省 os.homedir()）。 */
  home?: string | undefined;
  /** ③④ 脚本模块加载面（测试注入缝）。 */
  loader?: StageResolveBase["loader"] | undefined;
  /** 连接期探测（默认 TCP 探测；测试注入；绑定 ③ request 脚本时跳过）。 */
  probeConnect?: ((url: URL, ms: number) => Promise<void>) | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** WS 中继句柄回挂（引擎 DATA_UP / CLOSE 路由用）。 */
  onWsRelay?: ((relay: WsRelayHandle) => void) | undefined;
}

// ---------------------------------------------------------------------------
// 共用小件（ws-upstream 同族逻辑）
// ---------------------------------------------------------------------------

/** 默认连接期探测：独立 TCP 连接探活（fetch 不暴露连接建立阶段；探测成功即销毁）。 */
export function defaultProbeConnect(url: URL, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    const socket = netConnect({ host: url.hostname, port });
    let done = false;
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err === undefined) resolve();
      else reject(err);
    };
    socket.setTimeout(ms, () => finish(new Error("connect timeout")));
    socket.once("connect", () => finish());
    socket.once("error", (err: Error) => finish(err));
  });
}

/** RESP_META 白名单头挑选（小写键）。 */
export function pickResponseWhitelist(
  get: (name: string) => string | null,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const name of RESP_META_HEADER_WHITELIST) {
    const value = get(name);
    if (value !== null) out[name] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** 大分片拆为 ≤ 上限的帧序列（RESP_CHUNK / DATA_DOWN 共用）。 */
export function splitBodyChunks(data: Uint8Array, limit = DEFAULT_BODY_CHUNK_BYTES): Uint8Array[] {
  if (data.length <= limit) return [data];
  const out: Uint8Array[] = [];
  for (let off = 0; off < data.length; off += limit) {
    out.push(data.subarray(off, Math.min(off + limit, data.length)));
  }
  return out;
}

/** 信号 reason -> 回送码（缺省 aborted）。 */
export function abortCodeOf(signal: AbortSignal): { code: ErrorCodeValue; reply: boolean } {
  const reason = signal.reason;
  if (reason instanceof UpstreamAbortError) return { code: reason.code, reply: reason.reply };
  return { code: ERROR_CODE.aborted, reply: true };
}

function mergeTimeouts(overrides?: Partial<UpstreamTimeouts> | undefined): UpstreamTimeouts {
  return { ...DEFAULT_UPSTREAM_TIMEOUTS, ...overrides };
}

// ---------------------------------------------------------------------------
// 入口：构造 plan（含双重断言）-> HTTP / WS 分流
// ---------------------------------------------------------------------------

export async function forwardRequest(ctx: ForwardCtx): Promise<void> {
  let plan: UpstreamPlan;
  try {
    plan = await buildUpstreamRequest(
      ctx.service,
      ctx.req,
      ctx.env ?? process.env,
      ctx.secrets,
      { ...(ctx.home !== undefined ? { home: ctx.home } : {}), ...(ctx.loader !== undefined ? { loader: ctx.loader } : {}) },
    );
  } catch (err) {
    // 分类：① auth 失效与 $secret 未命中（secret_missing）> ② 脚本失效
    // （hook_failed——rewrite 构造期同样归此码，非 protocol_error）> 路由白名单外
    // （path_not_offered，消费侧 404）> RewriteError（protocol_error）> 兜底。
    // 前若干类都是零上游请求；message 不含密钥名与值。
    const code =
      err instanceof SecretMissingError || err instanceof HookMissingError
        ? ERROR_CODE.secret_missing
        : err instanceof HookStageError
          ? ERROR_CODE.hook_failed
          : err instanceof PathNotOfferedError
            ? ERROR_CODE.path_not_offered
            : ERROR_CODE.protocol_error;
    const message =
      err instanceof RewriteError ||
      err instanceof SecretMissingError ||
      err instanceof PathNotOfferedError ||
      err instanceof HookStageError ||
      err instanceof HookMissingError
        ? err.message
        : "request rewrite failed";
    await sendError(ctx.session, ctx.id, code, message);
    ctx.onUsage?.({
      ts: Date.now(),
      keyId: ctx.keyId,
      serviceId: ctx.service.serviceId,
      status: code,
      bytes: 0,
    });
    return;
  }
  if (plan.isWebSocketUpgrade) {
    // WS 路径共享 plan（①② 头链对 WS 生效）；③ request 接管不适用于 WS
    // （hooks-lifecycle Non-goal：出站仍原生 WebSocket）。
    await forwardWsUpgrade(ctx, plan, mergeTimeouts(ctx.timeouts));
    return;
  }
  await forwardHttp(ctx, plan, mergeTimeouts(ctx.timeouts));
}

async function sendError(
  session: WireSession,
  id: string,
  code: ErrorCodeValue,
  message: string,
): Promise<void> {
  try {
    await session.send(FRAME_TYPE.ERROR, { id, code, message });
  } catch {
    // 连接已坏：由关闭路径处置
  }
}

// ---------------------------------------------------------------------------
// 出站归一层（hooks-lifecycle v2）：原生 fetch 与 ③ 脚本结果统一为
// {status, headers, body: AsyncIterable}，转发循环只消费归一形。
// ---------------------------------------------------------------------------

/** 归一 body 句柄：单消费异步迭代器（④ ctx.body 与引擎消费共用同一实例）+ 取消传播。 */
export interface NormalizedBodyHandle {
  readonly iterable: AsyncIterable<Uint8Array>;
  /** 取消传播（ReadableStream→cancel；AsyncIterable→return()；幂等、不抛）。 */
  cancel(): Promise<void>;
}

const EMPTY_ASYNC_ITERATOR: AsyncIterator<Uint8Array> = {
  next: async () => ({ done: true as const, value: undefined }),
};

/**
 * 归一 body 源：ReadableStream 走 reader；AsyncIterable 直用其迭代器；
 * 缺省/null = 空流（③ 无正文状态合法）。取消语义统一经 cancel()。
 */
export function normalizeBody(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | null | undefined,
): NormalizedBodyHandle {
  if (source === null || source === undefined) {
    return {
      iterable: { [Symbol.asyncIterator]: () => EMPTY_ASYNC_ITERATOR },
      cancel: async () => undefined,
    };
  }
  if (typeof ReadableStream === "function" && source instanceof ReadableStream) {
    const reader = source.getReader();
    let drained = false; // 自然结束（done）：锁已释放，cancel 无效（复核 R3-P2）
    return {
      iterable: {
        [Symbol.asyncIterator]: () => ({
          // 自然结束（done=true）后显式释放锁（复核 R1-F7）：stream 后续
          // cancel()/tee() 不被已释放 reader 阻塞。
          next: async () => {
            const r = await reader.read();
            if (r.done === true) {
              drained = true;
              reader.releaseLock();
            }
            return r;
          },
        }),
      },
      cancel: () =>
        (drained ? Promise.resolve() : reader.cancel()).then(
          () => undefined,
          () => undefined,
        ),
    };
  }
  const iterator = (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  return {
    iterable: { [Symbol.asyncIterator]: () => iterator },
    cancel: async () => {
      try {
        await iterator.return?.(undefined);
      } catch {
        // 终止失败不阻塞清理（脚本流自担 signal 语义）
      }
    },
  };
}

/** 引擎内部的归一响应（同 lifecycle.NormalizedUpstreamResponse 形，body 换持
 *  句柄以携带取消语义；headers 已小写化 last-wins；fromScript 标记流中途失败分族）。 */
interface EngineNormalizedResponse {
  status: number;
  headers: Record<string, string>;
  body: NormalizedBodyHandle;
  /** body 产自脚本（③ 返回或 ④ 变换）：流中途失败归 hook_failed 而非 upstream_unreachable。 */
  fromScript: boolean;
}

/** 头表小写化（last-wins 字典语义；③④ 返回与原生 Response.headers 共用）。 */
function lowercaseHeaders(source: Iterable<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of source) out[name.toLowerCase()] = value;
  return out;
}

/**
 * RESP_META 投影（③④ 与原生路径同规则）：白名单三头挑选 + content-type 独立
 * 投影至 contentType；status 204/304 无正文——contentType 归一为空。
 */
export function projectRespMeta(
  id: string,
  status: number,
  headers: Record<string, string>,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    id,
    status,
    contentType: status === 204 || status === 304 ? "" : (headers["content-type"] ?? ""),
  };
  const picked = pickResponseWhitelist((name) => headers[name] ?? null);
  if (picked !== undefined) meta.headers = picked;
  return meta;
}

/** ③④ 脚本调用基础面（env 记录 → 函数适配；secrets/loader/home 透传）。 */
function stageBaseOf(ctx: ForwardCtx): StageResolveBase {
  const env = ctx.env;
  return {
    ...(ctx.secrets !== undefined ? { secrets: (n: string) => ctx.secrets!(n) } : {}),
    env: (n: string) => env?.[n] ?? process.env[n],
    ...(ctx.home !== undefined ? { home: ctx.home } : {}),
    ...(ctx.loader !== undefined ? { loader: ctx.loader } : {}),
  };
}

// ---------------------------------------------------------------------------
// HTTP 路径（归一层消费循环）
// ---------------------------------------------------------------------------

async function forwardHttp(ctx: ForwardCtx, plan: UpstreamPlan, t: UpstreamTimeouts): Promise<void> {
  const { session, id } = ctx;
  let settled = false;
  let bytes = 0;

  const recordUsage = (status: number | string): void => {
    ctx.onUsage?.({ ts: Date.now(), keyId: ctx.keyId, serviceId: ctx.service.serviceId, status, bytes });
  };
  const finishWithError = async (code: ErrorCodeValue, message: string): Promise<void> => {
    if (settled) return;
    settled = true;
    await sendError(session, id, code, message);
    recordUsage(code);
  };

  // GET/HEAD 携带正文：HTTP 语义非法。
  if ((ctx.req.method === "GET" || ctx.req.method === "HEAD") && ctx.body.length > 0) {
    await finishWithError(ERROR_CODE.protocol_error, "request body not allowed for GET/HEAD");
    return;
  }

  const requestSlot = ctx.service.request; // ③ 绑定（整体接管出站；跳过 probeConnect）
  const ctrl = new AbortController();
  let firstByteTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  // 本地超时中止的原因（首字节/停滞计时器触发；外部信号另有 abortCodeOf 分类）。
  let localAbortCode: ErrorCodeValue | undefined;
  /** 归一 body 句柄（获取响应后登记；中止/清理路径取消传播）。 */
  let bodyHandle: NormalizedBodyHandle | undefined;
  /** 被 ④ 变换替换下的原始 body（完成后取消，释放上游连接）。 */
  const supersededBodies: NormalizedBodyHandle[] = [];

  const stopPing = (): void => {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };
  const clearTimers = (): void => {
    if (firstByteTimer !== null) {
      clearTimeout(firstByteTimer);
      firstByteTimer = null;
    }
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
    stopPing();
  };

  // 外部信号（ABORT / idle / 断连）：中止上游（fetch 拒绝路径）+ cancel 归一
  // 迭代器（ReadableStream→cancel；AsyncIterable→return()）传播到脚本流。
  const onExternalAbort = (): void => {
    ctrl.abort();
    void bodyHandle?.cancel();
    for (const b of supersededBodies) void b.cancel();
  };
  if (ctx.signal.aborted) onExternalAbort();
  else ctx.signal.addEventListener("abort", onExternalAbort, { once: true });

  // 首字节等待期：挂起提供方侧空闲计时 + 30s PING（活度由 PING 节奏与首字节超时
  // 管辖；③ 脚本调用期同窗覆盖——脚本返回 = 响应头到达）。
  session.suspendProviderIdle(id);
  if (t.pingMs > 0) {
    pingTimer = setInterval(() => {
      void session.send(FRAME_TYPE.PING, { id }).catch(() => undefined);
    }, t.pingMs);
  }

  const abortWith = (code: ErrorCodeValue): void => {
    if (localAbortCode === undefined) localAbortCode = code;
    ctrl.abort();
    void bodyHandle?.cancel();
    for (const b of supersededBodies) void b.cancel();
  };
  firstByteTimer = setTimeout(() => abortWith(ERROR_CODE.idle_timeout), t.firstByteMs);

  /** 中止分类：外部信号（ABORT/idle/断连）优先，其次本地超时码，否则网络失败。 */
  const classifyAbort = (): { code: ErrorCodeValue; reply: boolean } | undefined => {
    if (!ctrl.signal.aborted) return undefined;
    if (ctx.signal.aborted) return abortCodeOf(ctx.signal);
    return { code: localAbortCode ?? ERROR_CODE.aborted, reply: true };
  };

  /** ③ 脚本路径：整体接管出站（跳过连接期探测——连接语义归脚本）。 */
  const requestStageResponse = async (): Promise<EngineNormalizedResponse> => {
    const slot = requestSlot!;
    const result = await resolveStageRequest(
      { name: slot.script, ...(slot.args !== undefined ? { args: slot.args } : {}) },
      {
        url: plan.url.toString(),
        method: ctx.req.method,
        headers: { ...plan.headers, host: plan.host },
        body: ctx.body,
        signal: ctrl.signal,
      },
      stageBaseOf(ctx),
    );
    return {
      status: result.status,
      headers: lowercaseHeaders(Object.entries(result.headers)),
      body: normalizeBody(result.body),
      fromScript: true,
    };
  };

  /** 原生路径：连接期探测 + fetch（fetchImpl 测试注入缝保留于此）。 */
  const nativeResponse = async (): Promise<EngineNormalizedResponse> => {
    const probe = ctx.probeConnect ?? defaultProbeConnect;
    try {
      await probe(plan.url, t.connectMs); // 失败/超时 -> upstream_unreachable，零 fetch
    } catch {
      throw new ProbeFailedError();
    }
    const fetchFn = ctx.fetchImpl ?? fetch;
    const headers: Record<string, string> = { ...plan.headers, host: plan.host };
    const init: RequestInit = { method: ctx.req.method, headers, redirect: "manual", signal: ctrl.signal };
    if (ctx.body.length > 0) init.body = ctx.body;
    const resp = await fetchFn(plan.url, init);
    const out: Record<string, string> = {};
    resp.headers.forEach((value, name) => {
      out[name.toLowerCase()] = value;
    });
    return {
      status: resp.status,
      headers: out,
      body: normalizeBody(resp.body),
      fromScript: false,
    };
  };

  let normalized: EngineNormalizedResponse;
  try {
    normalized = requestSlot !== undefined ? await requestStageResponse() : await nativeResponse();
  } catch (err) {
    // 初始失败（probe / fetch / ③ 构造）提前返回——先解绑外部 abort 监听
    // （复核 R2-F4：此路径不经下方外层 finally，泄漏会让每请求闭包挂在
    // ctx.signal 上直至信号自身被 GC）。
    ctx.signal.removeEventListener("abort", onExternalAbort);
    clearTimers();
    const aborted = classifyAbort();
    if (aborted !== undefined) {
      if (aborted.reply) await finishWithError(aborted.code, `upstream request aborted (${aborted.code})`);
      else settled = true; // 本地清理路径（断连等）：不回帧
      return;
    }
    if (err instanceof HookStageError) {
      // ③ 构造期失效（缺席/抛错/形状非法）：RESP_META 未发，回 hook_failed。
      await finishWithError(ERROR_CODE.hook_failed, err.message);
      return;
    }
    if (err instanceof ProbeFailedError) {
      await finishWithError(ERROR_CODE.upstream_unreachable, err.message);
      return;
    }
    await finishWithError(ERROR_CODE.upstream_unreachable, "upstream request failed");
    return;
  }
  bodyHandle = normalized.body;
  clearTimers(); // 首字节已到（响应头）；PING 停发

  try {
    // ④ onResponse：上游响应归一后、RESP_META 下发前——局部覆盖 status/headers/
    // body（头键小写化 last-wins；白名单外头由投影层忽略；body 变换流式——脚本
    // 返回新 body 则消费之，未返回则透传原归一流）。
    const responseSlot = ctx.service.response;
    if (responseSlot !== undefined) {
      let override: Awaited<ReturnType<typeof resolveStageResponse>>;
      try {
        override = await resolveStageResponse(
          { name: responseSlot.script, ...(responseSlot.args !== undefined ? { args: responseSlot.args } : {}) },
          {
            status: normalized.status,
            headers: { ...normalized.headers },
            body: normalized.body.iterable,
            signal: ctrl.signal,
          },
          stageBaseOf(ctx),
        );
      } catch (err) {
        if (err instanceof HookStageError) {
          await finishWithError(ERROR_CODE.hook_failed, err.message);
          return;
        }
        throw err;
      }
      if (override.status !== undefined) normalized.status = override.status;
      if (override.headers !== undefined) {
        for (const [name, value] of Object.entries(override.headers)) {
          normalized.headers[name.toLowerCase()] = value;
        }
      }
      if (override.body !== undefined) {
        // 原始流交由脚本处置（ctx.body 已递入）；完成后取消释放上游连接。
        supersededBodies.push(normalized.body);
        bodyHandle = normalizeBody(override.body);
        normalized.body = bodyHandle;
        normalized.fromScript = true;
      }
    }

    // 响应元信息（白名单头 + contentType 投影；204/304 contentType 空）；
    // 4xx/5xx 亦原样透传（upstream_status 语义）。
    await session.send(FRAME_TYPE.RESP_META, projectRespMeta(id, normalized.status, normalized.headers));

    // 正文流：逐块转发（SSE 不得缓冲拼齐），停滞计时每块重置。
    let seq = 0;
    const armStall = (): void => {
      if (stallTimer !== null) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => abortWith(ERROR_CODE.idle_timeout), t.stallMs);
    };
    armStall();
    // 中止竞速：脚本 AsyncIterable 的 pending next() 不因 abort 拒绝（生成器可能
    // 挂起在内部 await）——外部信号/本地超时触发 ctrl.abort 时由竞速即刻退出
    // 循环，归一迭代器的取消（return/cancel）由 finally 收尾传播。
    let abortRaceReject: ((err: Error) => void) | undefined;
    const abortRace = new Promise<never>((_, reject) => {
      abortRaceReject = reject;
    });
    const onLoopAbort = (): void => abortRaceReject?.(new Error("normalized body consumption aborted"));
    if (ctrl.signal.aborted) onLoopAbort();
    else ctrl.signal.addEventListener("abort", onLoopAbort, { once: true });
    const bodyIterator = normalized.body.iterable[Symbol.asyncIterator]();
    try {
      for (;;) {
        const result = await Promise.race([bodyIterator.next(), abortRace]);
        if (result.done === true) break;
        armStall();
        for (const piece of splitBodyChunks(result.value)) {
          await session.waitOutboundQueue(id); // 队列门控（暂停读上游）
          await session.send(FRAME_TYPE.RESP_CHUNK, { id, seq }, piece);
          seq += 1;
          bytes += piece.length;
        }
      }
    } finally {
      ctrl.signal.removeEventListener("abort", onLoopAbort);
    }
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
    if (ctx.signal.aborted) {
      // 正文已到齐但使用方已中止：仍按中止语义终结。
      const { code, reply } = abortCodeOf(ctx.signal);
      if (reply) await finishWithError(code, `upstream request aborted (${code})`);
      else settled = true;
      return;
    }
    await session.send(FRAME_TYPE.RESP_END, { id });
    settled = true;
    recordUsage(normalized.status);
  } catch {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
    const aborted = classifyAbort();
    if (aborted !== undefined) {
      if (aborted.reply) await finishWithError(aborted.code, `upstream request aborted (${aborted.code})`);
      else settled = true;
      return;
    }
    // 流中途失败分族：脚本产出（③ 返回 / ④ 变换）→ hook_failed；原生上游流
    // → upstream_unreachable（既有语义）。
    await finishWithError(
      normalized.fromScript ? ERROR_CODE.hook_failed : ERROR_CODE.upstream_unreachable,
      normalized.fromScript ? "hook stage failed" : "upstream stream failed",
    );
  } finally {
    clearTimers();
    // 正常完成同样解除外部 abort 监听（复核 R1-F7）：避免每请求在 ctx.signal
    // 上遗留持有 session/句柄闭包的 listener。
    ctx.signal.removeEventListener("abort", onExternalAbort);
    ctrl.abort(); // 释放上游资源（已完成的 fetch abort 是 no-op）
    // 归一迭代器取消传播：中止/失败路径显式 cancel（reader 持锁时必须经
    // reader.cancel，body.cancel 会因锁抛 TypeError 被吞），确保 undici 销毁
    // 上游连接 / 脚本流被取消（MUST 中止上游请求）。
    void bodyHandle?.cancel();
    for (const b of supersededBodies) void b.cancel();
  }
}
