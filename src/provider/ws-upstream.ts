// WebSocket 升级通道：识别 WS 升级请求（由 upstream.ts 分流）-> `ws` 客户端对重写后
// 的上游 URL 执行握手 -> 101 经 RESP_META（sec-websocket-accept 白名单透传）->
// DATA_UP / DATA_DOWN 双向中继 -> CLOSE 终结。
// 正交意图（本文件不实现）：
// - HTTP 普通转发（upstream.ts）；
// - 授权/限额（引擎）。
// 实现裁决（ws 库行为约束，见任务报告）：
// - ws 客户端总是生成自己的 Sec-WebSocket-Key 并按该 key 校验 accept，因此帧内
//   key 不透传；上游真实 sec-websocket-accept 从 'upgrade' 事件捕获并经白名单下发；
// - sec-websocket-extensions 不透传（ws 库按未协商压缩处理，保证 DATA 字节为
//   未压缩 payload；压缩由使用方本地 WS 服务与其客户端自行协商）；
// - 报文级中继：每条 ws message -> 一条 DATA_DOWN（>256KiB 才拆分，超限报文的
//   消息边界有损，v1 已知限制）；每条 DATA_UP -> 一次 ws.send(binary)。

import type { IncomingMessage } from "node:http";
import WebSocket from "ws";
import type { ErrorCodeValue } from "../wire/frames.ts";
import { ERROR_CODE, FRAME_TYPE } from "../wire/frames.ts";
import type { WireSession } from "../wire/mux.ts";
import {
  abortCodeOf,
  pickResponseWhitelist,
  splitBodyChunks,
  type ForwardCtx,
  type UpstreamTimeouts,
} from "./upstream.ts";
import type { UpstreamPlan } from "./rewrite.ts";

/** 引擎侧 DATA_UP / CLOSE 路由句柄。 */
export interface WsRelayHandle {
  /** DATA_UP 正文 -> 上游（二进制透传，不解析帧）。 */
  pushUp(data: Uint8Array): void;
  /** 使用方发来 CLOSE：本地终结，不再回帧（id 已终结）。 */
  closeByPeer(): void;
  /** 引擎侧中止（ABORT 回 ERROR(code)；断连等 reply=false 静默）。 */
  abort(code: ErrorCodeValue, reply: boolean): void;
}

/** http(s) URL -> ws(s) URL。 */
export function toWebSocketUrl(url: URL): string {
  return `${url.protocol === "https:" ? "wss" : "ws"}:${url.href.slice(url.protocol.length)}`;
}

function headerGet(headers: IncomingMessage["headers"], name: string): string | null {
  const value = headers[name];
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(", ") : value;
}

export async function forwardWsUpgrade(
  ctx: ForwardCtx,
  plan: UpstreamPlan,
  t: UpstreamTimeouts,
): Promise<void> {
  const { session, id } = ctx;
  let settled = false; // 终结帧已发（或本地终结）
  let opened = false;
  let downSeq = 0;
  let bytes = 0;
  let acceptHeader: string | null = null;
  /** 完成回调（await 完成Promise 的 resolve；close 与非 101 中继任一触发）。 */
  let completion: (() => void) | undefined;
  // 出站发送链：保证 DATA_DOWN 拆片与控制帧的本地顺序（wire 层另有 per-id 保序）。
  let sendChain: Promise<void> = Promise.resolve();

  const recordUsage = (status: number | string): void => {
    ctx.onUsage?.({ ts: Date.now(), keyId: ctx.keyId, serviceId: ctx.service.serviceId, status, bytes });
  };
  const enqueue = (task: () => Promise<void>): void => {
    sendChain = sendChain.then(task).catch(() => undefined);
  };
  const sendErrorFrame = (code: ErrorCodeValue, message: string): void => {
    if (settled) return;
    settled = true; // 调用即置位：'close' 事件可能先于入队任务执行（事件顺序竞态）
    enqueue(async () => {
      try {
        await session.send(FRAME_TYPE.ERROR, { id, code, message });
      } catch {
        // 连接已坏：关闭路径处置
      }
    });
  };

  // 首字节等待期语义同样适用（握手期）：挂起空闲计时 + 30s PING。
  session.suspendProviderIdle(id);
  const pingTimer =
    t.pingMs > 0
      ? setInterval(() => {
          void session.send(FRAME_TYPE.PING, { id }).catch(() => undefined);
        }, t.pingMs)
      : null;

  const cleanup = (): void => {
    if (pingTimer !== null) clearInterval(pingTimer);
  };
  const teardown = (code?: number): void => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      code === undefined ? ws.terminate() : ws.close(code);
    }
  };

  // 握手头：帧内头集（rewrite 已剥离凭据/hop-by-hop）+ Host；extensions/key/version
  // 由 ws 客户端自管（见文件头裁决）。
  const headers: Record<string, string> = { ...plan.headers, host: plan.host };
  delete headers["sec-websocket-extensions"];
  delete headers["sec-websocket-key"];
  delete headers["sec-websocket-version"];
  delete headers["content-type"];
  delete headers["content-length"];
  const protocolHeader = headers["sec-websocket-protocol"];
  delete headers["sec-websocket-protocol"];
  const protocols =
    protocolHeader === undefined
      ? []
      : protocolHeader
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p !== "");

  const ws = new WebSocket(toWebSocketUrl(plan.url), protocols, {
    headers,
    handshakeTimeout: t.connectMs,
    perMessageDeflate: false, // 压缩协商关闭：保证 DATA 字节为未压缩 payload（见文件头裁决）
  });

  const relay: WsRelayHandle = {
    pushUp(data) {
      if (ws.readyState !== WebSocket.OPEN) return; // 握手中/已关：丢弃
      bytes += data.length;
      ws.send(data, { binary: true });
    },
    closeByPeer() {
      settled = true;
      cleanup();
      teardown();
    },
    abort(code, reply) {
      if (reply) sendErrorFrame(code, `websocket relay aborted (${code})`);
      else settled = true;
      cleanup();
      teardown();
    },
  };
  ctx.onWsRelay?.(relay);

  // 引擎信号（ABORT / idle / 断连）。
  const onExternalAbort = (): void => {
    const { code, reply } = abortCodeOf(ctx.signal);
    relay.abort(code, reply);
  };
  if (ctx.signal.aborted) onExternalAbort();
  else ctx.signal.addEventListener("abort", onExternalAbort, { once: true });

  // 101 响应头先到（'upgrade' 在 'open' 前）：捕获 sec-websocket-accept。
  ws.on("upgrade", (res) => {
    acceptHeader = headerGet(res.headers, "sec-websocket-accept");
  });

  // 非 101：按普通 HTTP 响应原样回送（upstream_status 语义：RESP_META + 正文 + END）。
  ws.on("unexpected-response", (_req, res) => {
    if (settled) return;
    settled = true; // 占位终结权：随后的 close/error 不得再发终结帧
    const status = res.statusCode ?? 500;
    const contentType = headerGet(res.headers, "content-type") ?? "";
    enqueue(async () => {
      const meta: Record<string, unknown> = { id, status, contentType };
      const picked = pickResponseWhitelist((name) => headerGet(res.headers, name));
      if (picked !== undefined) meta.headers = picked;
      try {
        await session.send(FRAME_TYPE.RESP_META, meta);
      } catch {
        return;
      }
      let seq = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        enqueue(async () => {
          for (const piece of splitBodyChunks(new Uint8Array(chunk))) {
            await session.waitOutboundQueue(id);
            await session.send(FRAME_TYPE.RESP_CHUNK, { id, seq }, piece);
            seq += 1;
          }
        });
      });
      res.on("end", () => {
        enqueue(async () => {
          try {
            await session.send(FRAME_TYPE.RESP_END, { id });
          } finally {
            completion?.();
          }
          recordUsage(status);
        });
      });
      res.on("error", () => {
        enqueue(async () => {
          try {
            await session.send(FRAME_TYPE.ERROR, { id, code: ERROR_CODE.upstream_unreachable, message: "upstream error response stream failed" });
          } catch {
            // 连接已坏
          } finally {
            completion?.();
          }
        });
      });
      res.resume();
    });
  });

  ws.on("open", () => {
    opened = true;
    enqueue(async () => {
      const meta: Record<string, unknown> = { id, status: 101, contentType: "" };
      if (acceptHeader !== null) meta.headers = { "sec-websocket-accept": acceptHeader };
      try {
        await session.send(FRAME_TYPE.RESP_META, meta);
      } catch {
        return;
      }
      recordUsage(101); // 升级成功先记一次；关闭时补记 CLOSE 状态
    });
  });

  ws.on("message", (data) => {
    // RawData = Buffer | ArrayBuffer | Buffer[]（nodebuffer 默认下为 Buffer）。
    const payload = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);
    bytes += payload.length;
    const pieces = splitBodyChunks(new Uint8Array(payload));
    const startSeq = downSeq;
    downSeq += pieces.length;
    enqueue(async () => {
      let seq = startSeq;
      for (const piece of pieces) {
        await session.waitOutboundQueue(id); // DATA 同走 64 帧门控
        await session.send(FRAME_TYPE.DATA_DOWN, { v: 1, id, seq }, piece);
        seq += 1;
      }
    });
  });

  // 上游 WS 自有 ping/pong 维持使用方侧活度（PONG 无法过桥，用 PING 帧重置对端计时）。
  ws.on("ping", () => {
    void session.send(FRAME_TYPE.PING, { id }).catch(() => undefined);
  });

  ws.on("close", (code) => {
    cleanup();
    if (settled) return;
    settled = true;
    enqueue(async () => {
      const header: Record<string, unknown> = { id };
      if (code >= 1000 && code <= 65535) header.code = code;
      try {
        await session.send(FRAME_TYPE.CLOSE, header);
      } catch {
        // 连接已坏
      }
      recordUsage(opened ? "ws-closed" : ERROR_CODE.upstream_unreachable);
    });
  });

  ws.on("error", (err) => {
    cleanup();
    if (settled) return;
    if (!opened) {
      // 握手期传输失败（连接拒绝/超时/TLS 等）。注意顺序：sendErrorFrame 自身在
      // 发送任务内置 settled（先置位会让该任务被守卫跳过）。
      sendErrorFrame(ERROR_CODE.upstream_unreachable, `websocket handshake failed: ${err.message}`);
      recordUsage(ERROR_CODE.upstream_unreachable);
      return;
    }
    // 中途传输错误：按异常关闭终结（1011 = internal error）。
    settled = true;
    enqueue(async () => {
      try {
        await session.send(FRAME_TYPE.CLOSE, { id, code: 1011 });
      } catch {
        // 连接已坏
      }
      recordUsage("ws-error");
    });
  });

  // 等待终结（close / 非 101 中继完成 / 已关）。非 101 路径 ws 可能不触发 'close'。
  await new Promise<void>((resolve) => {
    let completed = false;
    const complete = (): void => {
      if (completed) return;
      completed = true;
      resolve();
    };
    completion = complete;
    ws.on("close", complete);
    if (ws.readyState === WebSocket.CLOSED) complete();
  });
  completion = undefined;
  cleanup();
}
