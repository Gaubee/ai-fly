// WebSocket 升级通道：识别 WS 升级请求（由 upstream.ts 分流）-> `ws` 客户端对重写后
// 的上游 URL 执行握手 -> 101 经 meta 投影（sec-websocket-accept 白名单透传）->
// 隧道下行字节 / 上行路由双向中继 -> 关闭终结。
// opendweb-kernel-migration：承载面自 DATA_UP/DATA_DOWN/CLOSE 帧改为 ResponseSink
// （wsData/wsClose/meta/error）+ 引擎侧隧道上行句柄（WsRelayHandle.pushUp 消费
// keepOpen 隧道字节）；报文级中继语义不变（每条 ws message -> 一段隧道字节；
// >256KiB 才拆分，超限报文的消息边界有损，v1 已知限制）。本阶段 NAPI 承载面为
// 静态 chunks：下行报文由载体聚齐后在握手/会话终结时一次性 resolve（见
// provider/engine.ts 载体与任务报告的 SDK 限制记录）。
// hooks-lifecycle 约束：WS 共享 rewrite 出站 plan——① auth 与 ② headers 阶段对
// WS 生效（头链在 buildUpstreamRequest 内完成）；③ onRequest 接管**不适用于 WS**
// （Owner Non-goal 裁决：出站仍原生 WebSocket，不进 request 阶段）；④ onResponse
// 同样不进 WS 路径（meta(101) 由握手产物直接下发）。
// 正交意图（本文件不实现）：
// - HTTP 普通转发（upstream.ts）；
// - 授权/限额（引擎）。
// 实现裁决（ws 库行为约束，见任务报告）：
// - ws 客户端总是生成自己的 Sec-WebSocket-Key 并按该 key 校验 accept，因此
//   key 不透传；上游真实 sec-websocket-accept 从 'upgrade' 事件捕获并经白名单下发；
// - sec-websocket-extensions 不透传（ws 库按未协商压缩处理，保证隧道字节为
//   未压缩 payload；压缩由使用方本地 WS 服务与其客户端自行协商）；

import type { IncomingMessage } from "node:http";
import WebSocket from "ws";
import type { ErrorCodeValue, ErrorHeader, RespMetaHeader } from "../wire/frames.ts";
import { ERROR_CODE } from "../wire/frames.ts";
import type {
  ResponseSink,
  ForwardCtx,
  UpstreamTimeouts,
} from "./upstream.ts";
import { abortCodeOf, pickResponseWhitelist, splitBodyChunks } from "./upstream.ts";
import type { UpstreamPlan } from "./rewrite.ts";

/** 引擎侧隧道上行路由句柄（keepOpen 隧道字节 → 上游）。 */
export interface WsRelayHandle {
  /** 隧道上行字节 -> 上游（二进制透传，不解析帧）。 */
  pushUp(data: Uint8Array): void;
  /** 使用方关闭隧道：本地终结，不再回帧（请求已终结）。
   *  语义承接旧 CLOSE 帧（本阶段 NAPI 无 per-request cancel 通道——客户端侧
   *  隧道 EOF 后由载体收尾；此处保留给引擎本地收尾路径）。 */
  closeByPeer(): void;
  /** 引擎侧中止（错误投影；本地收尾静默）。 */
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
  const { sink, id } = ctx;
  let settled = false; // 终结投影已发（或本地终结）
  let opened = false;
  let bytes = 0;
  let acceptHeader: string | null = null;
  /** 完成回调（await 完成Promise 的 resolve；close 与非 101 中继任一触发）。 */
  let completion: (() => void) | undefined;
  // 出站投影链：保证下行拆片与控制投影的本地顺序（载体侧另有字节序保证）。
  let sendChain: Promise<void> = Promise.resolve();

  const recordUsage = (status: number | string): void => {
    ctx.onUsage?.({ ts: Date.now(), keyId: ctx.keyId, serviceId: ctx.service.serviceId, status, bytes });
  };
  const enqueue = (task: () => Promise<void>): void => {
    sendChain = sendChain.then(task).catch(() => undefined);
  };
  const sendErrorProjection = (code: ErrorCodeValue, message: string): void => {
    if (settled) return;
    settled = true; // 调用即置位：'close' 事件可能先于入队任务执行（事件顺序竞态）
    enqueue(async () => {
      try {
        await sink.error({ id, code, message } satisfies ErrorHeader);
      } catch {
        // 承载面已坏：关闭路径处置
      }
    });
  };

  const cleanup = (): void => {
    // 正常完成同样解除引擎 abort 监听（复核 R1-F7）：once 监听器在连接正常
    // 关闭路径不触发，不解除则随 ctx.signal 泄漏 relay 闭包。
    ctx.signal.removeEventListener("abort", onExternalAbort);
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
      if (reply) sendErrorProjection(code, `websocket relay aborted (${code})`);
      else settled = true;
      cleanup();
      teardown();
    },
  };
  ctx.onWsRelay?.(relay);

  // 引擎信号（中止 / 断连）。
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

  // 非 101：按普通 HTTP 响应原样回送（upstream_status 语义：meta + 正文 + end）。
  ws.on("unexpected-response", (_req, res) => {
    if (settled) return;
    settled = true; // 占位终结权：随后的 close/error 不得再发终结投影
    const status = res.statusCode ?? 500;
    const contentType = headerGet(res.headers, "content-type") ?? "";
    enqueue(async () => {
      const meta: RespMetaHeader = { id, status, contentType };
      const picked = pickResponseWhitelist((name) => headerGet(res.headers, name));
      if (picked !== undefined) meta.headers = picked;
      try {
        await sink.meta(meta);
      } catch {
        return;
      }
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        enqueue(async () => {
          for (const piece of splitBodyChunks(new Uint8Array(chunk))) {
            await sink.chunk(piece);
          }
        });
      });
      res.on("end", () => {
        enqueue(async () => {
          try {
            await sink.end();
          } finally {
            completion?.();
          }
          recordUsage(status);
        });
      });
      res.on("error", () => {
        enqueue(async () => {
          try {
            await sink.error({ id, code: ERROR_CODE.upstream_unreachable, message: "upstream error response stream failed" });
          } catch {
            // 承载面已坏
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
      const meta: RespMetaHeader = { id, status: 101, contentType: "" };
      if (acceptHeader !== null) meta.headers = { "sec-websocket-accept": acceptHeader };
      try {
        await sink.meta(meta);
      } catch {
        return;
      }
      recordUsage(101); // 升级成功先记一次；关闭时补记终结状态
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
    enqueue(async () => {
      for (const piece of pieces) {
        await sink.wsData?.(piece); // 隧道下行（载体聚齐；内核字节序保证）
      }
    });
  });

  ws.on("close", (code) => {
    cleanup();
    if (settled) return;
    settled = true;
    enqueue(async () => {
      try {
        await sink.wsClose?.(code >= 1000 && code <= 65535 ? code : undefined);
      } catch {
        // 承载面已坏
      }
      recordUsage(opened ? "ws-closed" : ERROR_CODE.upstream_unreachable);
    });
  });

  ws.on("error", (err) => {
    cleanup();
    if (settled) return;
    if (!opened) {
      // 握手期传输失败（连接拒绝/超时/TLS 等）。注意顺序：sendErrorProjection 自身
      // 在发送任务内置 settled（先置位会让该任务被守卫跳过）。
      sendErrorProjection(ERROR_CODE.upstream_unreachable, `websocket handshake failed: ${err.message}`);
      recordUsage(ERROR_CODE.upstream_unreachable);
      return;
    }
    // 中途传输错误：按异常关闭终结（1011 = internal error）。
    settled = true;
    enqueue(async () => {
      try {
        await sink.wsClose?.(1011);
      } catch {
        // 承载面已坏
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
