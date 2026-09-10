// HTTP 上游转发：REQ（重组完成）-> fetch(AbortController) -> RESP_META / RESP_CHUNK
// / RESP_END / ERROR。超时族（design A6）：连接期 10s（TCP 探测，fetch 不暴露连接
// 建立，探测失败/超时回 upstream_unreachable）、首字节 600s（fetch resolve = 响应头
// 到达 = 首字节等待结束）、流停滞 120s（分片间）、首字节等待期每 30s PING(id) 并挂起
// 提供方侧空闲计时。
// 正交意图（本文件不实现）：
// - 授权/限额（引擎在拨号前完成；本层只转发已放行请求）；
// - REQ 重组（mux + 引擎；本层收到的是完整正文）；
// - WS 升级通道（ws-upstream.ts；本文件在构造 plan 后分流）。
// 上游 URL 目标仅来自本地服务配置（rewrite 断言过），帧内字段不影响 origin（防SSRF）。

import { connect as netConnect } from "node:net";
import type { ReqHeader, ErrorCodeValue } from "../wire/frames.ts";
import { ERROR_CODE, FRAME_TYPE, RESP_META_HEADER_WHITELIST } from "../wire/frames.ts";
import { DEFAULT_BODY_CHUNK_BYTES } from "../wire/codec.ts";
import type { WireSession } from "../wire/mux.ts";
import type { ServiceConfig } from "./store.ts";
import type { UsageRecord } from "./limits.ts";
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

export interface ForwardCtx {
  session: WireSession;
  id: string;
  service: ServiceConfig;
  req: ReqHeader;
  /** 完整请求正文（引擎已重组）。 */
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
  /** 连接期探测（默认 TCP 探测；测试注入）。 */
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
    plan = buildUpstreamRequest(ctx.service, ctx.req, ctx.env ?? process.env, ctx.secrets);
  } catch (err) {
    // 分类：$secret 未命中（secret_missing）> 路由白名单外（path_not_offered，
    // 消费侧 404）> RewriteError（protocol_error）> 兜底。前三类都是零上游请求；
    // message 不含密钥名与值。
    const code =
      err instanceof SecretMissingError
        ? ERROR_CODE.secret_missing
        : err instanceof PathNotOfferedError
          ? ERROR_CODE.path_not_offered
          : ERROR_CODE.protocol_error;
    const message =
      err instanceof RewriteError || err instanceof SecretMissingError || err instanceof PathNotOfferedError
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
// HTTP 路径
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

  // 连接期探测（10s；失败/超时 -> upstream_unreachable，零 fetch）。
  const probe = ctx.probeConnect ?? defaultProbeConnect;
  try {
    await probe(plan.url, t.connectMs);
  } catch {
    await finishWithError(ERROR_CODE.upstream_unreachable, "upstream connect failed or timed out");
    return;
  }

  const ctrl = new AbortController();
  let firstByteTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  // 本地超时中止的原因（首字节/停滞计时器触发；外部信号另有 abortCodeOf 分类）。
  let localAbortCode: ErrorCodeValue | undefined;

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

  // 外部信号（ABORT / idle / 断连）：中止上游，由 fetch/read 拒绝路径统一回帧。
  const onExternalAbort = (): void => {
    ctrl.abort();
  };
  if (ctx.signal.aborted) onExternalAbort();
  else ctx.signal.addEventListener("abort", onExternalAbort, { once: true });

  // 首字节等待期：挂起提供方侧空闲计时 + 30s PING（活度由 PING 节奏与首字节超时管辖）。
  session.suspendProviderIdle(id);
  if (t.pingMs > 0) {
    pingTimer = setInterval(() => {
      void session.send(FRAME_TYPE.PING, { id }).catch(() => undefined);
    }, t.pingMs);
  }

  const abortWith = (code: ErrorCodeValue): void => {
    if (localAbortCode === undefined) localAbortCode = code;
    ctrl.abort();
  };
  firstByteTimer = setTimeout(() => abortWith(ERROR_CODE.idle_timeout), t.firstByteMs);

  const fetchFn = ctx.fetchImpl ?? fetch;
  const headers: Record<string, string> = { ...plan.headers, host: plan.host };
  const init: RequestInit = { method: ctx.req.method, headers, redirect: "manual", signal: ctrl.signal };
  if (ctx.body.length > 0) init.body = ctx.body;

  /** 中止分类：外部信号（ABORT/idle/断连）优先，其次本地超时码，否则网络失败。 */
  const classifyAbort = (): { code: ErrorCodeValue; reply: boolean } | undefined => {
    if (!ctrl.signal.aborted) return undefined;
    if (ctx.signal.aborted) return abortCodeOf(ctx.signal);
    return { code: localAbortCode ?? ERROR_CODE.aborted, reply: true };
  };

  let resp: Response;
  try {
    resp = await fetchFn(plan.url, init);
  } catch {
    clearTimers();
    const aborted = classifyAbort();
    if (aborted !== undefined) {
      if (aborted.reply) await finishWithError(aborted.code, `upstream request aborted (${aborted.code})`);
      else settled = true; // 本地清理路径（断连等）：不回帧
      return;
    }
    await finishWithError(ERROR_CODE.upstream_unreachable, "upstream request failed");
    return;
  }
  clearTimers(); // 首字节已到（响应头）；PING 停发

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    // 响应元信息（白名单头）；4xx/5xx 亦原样透传（upstream_status 语义）。
    const metaHeader: Record<string, unknown> = {
      id,
      status: resp.status,
      contentType: resp.headers.get("content-type") ?? "",
    };
    const picked = pickResponseWhitelist((name) => resp.headers.get(name));
    if (picked !== undefined) metaHeader.headers = picked;
    await session.send(FRAME_TYPE.RESP_META, metaHeader);

    // 正文流：逐块转发（SSE 不得缓冲拼齐），停滞计时每块重置。
    let seq = 0;
    const armStall = (): void => {
      if (stallTimer !== null) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => abortWith(ERROR_CODE.idle_timeout), t.stallMs);
    };
    armStall();
    reader = resp.body?.getReader();
    if (reader !== undefined) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armStall();
        for (const piece of splitBodyChunks(value)) {
          await session.waitOutboundQueue(id); // 队列门控（暂停读上游）
          await session.send(FRAME_TYPE.RESP_CHUNK, { id, seq }, piece);
          seq += 1;
          bytes += piece.length;
        }
      }
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
    recordUsage(resp.status);
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
    await finishWithError(ERROR_CODE.upstream_unreachable, "upstream stream failed");
  } finally {
    clearTimers();
    ctrl.abort(); // 释放上游资源（已完成的 fetch abort 是 no-op）
    // 中止/失败路径显式 cancel：reader 持锁时必须经 reader.cancel（body.cancel 会因
    // 锁抛 TypeError 被吞），确保 undici 销毁上游连接（MUST 中止上游请求）。
    if (reader !== undefined) void reader.cancel().catch(() => undefined);
    else void resp.body?.cancel().catch(() => undefined);
  }
}
