// WS 升级通道单测（本地 ws echo 上游 + ResponseSink 收集假体）：101 升级
// （meta + sec-websocket-accept 白名单）、隧道下行透传（含 >256KiB 拆分）、
// 上游 Close -> wsClose 终结、握手失败（非 101）按普通 HTTP 透传、extensions
// 不透传、closeByPeer/abort 处置。
// opendweb-kernel-migration：DATA_UP 上行经 WsRelayHandle.pushUp（隧道上行）；
// 断言面保持旧帧形（假体把 sink 回调记录回帧形事件，type 用 frames.ts 类型号）。

import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { FRAME_TYPE } from "../../../src/wire/frames.ts";
import type { ErrorHeader, ReqHeader, RespMetaHeader } from "../../../src/wire/frames.ts";
import { forwardRequest, type ResponseSink } from "../../../src/provider/upstream.ts";
import type { WsRelayHandle } from "../../../src/provider/ws-upstream.ts";
import type { ServiceConfig } from "../../../src/provider/store.ts";

const ENC = new TextEncoder();

interface WsUpstream {
  server: Server;
  port: number;
  upgradeHeaders: IncomingHttpHeaders[];
  sockets: WebSocket[];
  mode: "echo" | "reject";
}

let upstreams: WsUpstream[];

beforeEach(() => {
  upstreams = [];
});

afterEach(async () => {
  for (const u of upstreams) {
    for (const ws of u.sockets) ws.close(1000);
    await new Promise<void>((resolve) => u.server.close(() => resolve()));
  }
});

function startWsUpstream(mode: "echo" | "reject" = "echo"): Promise<WsUpstream> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      // 非 101 路径：普通 404 响应
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"no websocket here"}');
    });
    const wss = new WebSocketServer({ noServer: true });
    const upgradeHeaders: IncomingHttpHeaders[] = [];
    const sockets: WebSocket[] = [];
    server.on("upgrade", (req, socket: Duplex, head: Buffer) => {
      upgradeHeaders.push(req.headers);
      if (mode === "reject" || req.url !== "/ws") {
        // 非 101：按普通 HTTP 响应回（ws 客户端 -> unexpected-response）
        const body = mode === "reject" ? "forbidden" : '{"error":"no websocket here"}';
        socket.write(
          `HTTP/1.1 ${mode === "reject" ? "403 Forbidden" : "404 Not Found"}\r\nConnection: close\r\nContent-Type: ${mode === "reject" ? "text/plain" : "application/json"}\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
        );
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        sockets.push(ws);
        ws.on("message", (data) => {
          ws.send(data); // echo（含二进制）
        });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const mock: WsUpstream = {
        server,
        port: (server.address() as AddressInfo).port,
        upgradeHeaders,
        sockets,
        mode,
      };
      upstreams.push(mock);
      resolve(mock);
    });
  });
}

/** sink 回调的帧形记录（type 用 frames.ts 类型号；断言面与旧 wire 事件同构）。 */
interface SinkFrame {
  type: number;
  header?: unknown;
  body?: Uint8Array;
}

interface Harness {
  consumerEvents: SinkFrame[];
  sink: ResponseSink;
  relay: WsRelayHandle | undefined;
  setCurrentId(id: string): void;
}

function makeHarness(): Harness {
  const consumerEvents: SinkFrame[] = [];
  let currentId = "";
  let downSeq = 0;
  const sink: ResponseSink = {
    meta: (h: RespMetaHeader) => {
      consumerEvents.push({ type: FRAME_TYPE.RESP_META, header: { ...h, id: currentId } });
    },
    chunk: (b: Uint8Array) => {
      consumerEvents.push({ type: FRAME_TYPE.RESP_CHUNK, header: { id: currentId }, body: b });
    },
    end: () => {
      consumerEvents.push({ type: FRAME_TYPE.RESP_END, header: { id: currentId } });
    },
    error: (h: ErrorHeader) => {
      consumerEvents.push({ type: FRAME_TYPE.ERROR, header: { ...h, id: h.id ?? currentId } });
    },
    wsData: (b: Uint8Array) => {
      consumerEvents.push({ type: FRAME_TYPE.DATA_DOWN, header: { v: 1, id: currentId, seq: downSeq++ }, body: b });
    },
    wsClose: (code: number | undefined) => {
      consumerEvents.push({
        type: FRAME_TYPE.CLOSE,
        header: { id: currentId, ...(code !== undefined ? { code } : {}) },
      });
    },
  };
  return {
    consumerEvents,
    sink,
    relay: undefined,
    setCurrentId: (id: string) => {
      currentId = id;
      downSeq = 0;
    },
  };
}

async function waitFor<T>(probe: () => T | undefined, ms = 3_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor: timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function of(events: SinkFrame[], type: number, id: string): SinkFrame[] {
  return events.filter((f) => f.type === type && (f.header as { id?: string }).id === id);
}

function bodyOf(f: SinkFrame): Buffer {
  return Buffer.from(f.body ?? new Uint8Array(0));
}

function wsReq(id: string, over: Partial<ReqHeader> = {}): ReqHeader {
  return {
    v: 1,
    id,
    serviceId: "svc1",
    method: "GET",
    path: "/ws",
    bodyLen: 0,
    headers: {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      ...(over.headers ?? {}),
    },
    ...over,
  };
}

function makeService(port: number): ServiceConfig {
  return {
    serviceId: "svc1",
    name: "wsapi",
    match: [{ type: "suffix", value: ".local" }],
    upstream: `http://127.0.0.1:${port}`,
    rewrite: undefined,
    defaultPort: 11434,
    enabled: true,
  };
}

function startWsForward(h: Harness, port: number, req: ReqHeader): Promise<void> {
  h.setCurrentId(req.id);
  return forwardRequest({
    sink: h.sink,
    id: req.id,
    service: makeService(port),
    req,
    body: new Uint8Array(0),
    signal: new AbortController().signal,
    keyId: "k1",
    timeouts: { connectMs: 2_000, firstByteMs: 5_000, stallMs: 5_000 },
    onWsRelay: (relay) => {
      h.relay = relay;
    },
  });
}

describe("WS 升级与双向中继", () => {
  it("101 升级：RESP_META(101, sec-websocket-accept) -> 双向 echo -> CLOSE 终结", async () => {
    const upstream = await startWsUpstream("echo");
    const h = makeHarness();
    const done = startWsForward(h, upstream.port, wsReq("w1"));
    const meta = await waitFor(() => of(h.consumerEvents, FRAME_TYPE.RESP_META, "w1")[0]);
    const metaHeader = meta.header as { status: number; headers?: Record<string, string> };
    expect(metaHeader.status).toBe(101);
    expect(metaHeader.headers?.["sec-websocket-accept"]).toMatch(/^[A-Za-z0-9+/]{27}=$/);
    expect(h.relay).toBeDefined();

    // 使用方 -> 上游（二进制透传）
    h.relay!.pushUp(ENC.encode("hello upstream"));
    await waitFor(() => of(h.consumerEvents, FRAME_TYPE.DATA_DOWN, "w1")[0]);
    const down = of(h.consumerEvents, FRAME_TYPE.DATA_DOWN, "w1");
    expect(Buffer.concat(down.map((f) => bodyOf(f))).toString()).toBe("hello upstream");
    expect((down[0]!.header as { seq: number }).seq).toBe(0);

    // 大消息（>256KiB）拆分下发、序号连续
    const big = new Uint8Array(300 * 1024).fill(0x7a);
    h.relay!.pushUp(big);
    await waitFor(() =>
      of(h.consumerEvents, FRAME_TYPE.DATA_DOWN, "w1").reduce((n, f) => n + bodyOf(f).length, 0) >= 300 * 1024 ? true : undefined,
    );
    const allDown = of(h.consumerEvents, FRAME_TYPE.DATA_DOWN, "w1");
    const totalBytes = allDown.reduce((n, f) => n + bodyOf(f).length, 0);
    expect(totalBytes).toBeGreaterThanOrEqual(300 * 1024 + "hello upstream".length);
    const seqs = allDown.map((f) => (f.header as { seq: number }).seq);
    expect(seqs).toEqual(seqs.map((_, i) => i)); // 从 0 连续递增

    // 上游关闭 -> CLOSE
    upstream.sockets[0]!.close(1000);
    await waitFor(() => of(h.consumerEvents, FRAME_TYPE.CLOSE, "w1")[0]);
    expect(of(h.consumerEvents, FRAME_TYPE.CLOSE, "w1")[0]!.header).toMatchObject({ id: "w1", code: 1000 });
    await done;
  });

  it("握手头：sec-websocket-key/version 不透传（ws 自管）；extensions 丢弃；子协议协商", async () => {
    const upstream = await startWsUpstream("echo");
    const h = makeHarness();
    const req = wsReq("w2", {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "consumer-generated-key",
        "sec-websocket-protocol": "chat, superchat",
        "sec-websocket-extensions": "permessage-deflate; client_max_window_bits",
      },
    });
    const done = startWsForward(h, upstream.port, req);
    await waitFor(() => of(h.consumerEvents, FRAME_TYPE.RESP_META, "w2")[0]);
    await waitFor(() => (upstream.sockets.length > 0 ? true : undefined));
    const seen = upstream.upgradeHeaders[0]!;
    expect(seen["sec-websocket-key"]).toBeDefined();
    expect(seen["sec-websocket-key"]).not.toBe("consumer-generated-key"); // ws 自管 key
    expect(seen["sec-websocket-extensions"]).toBeUndefined(); // 压缩协商不透传
    expect(upstream.sockets[0]!.protocol).toBe("chat"); // 子协议透传协商
    upstream.sockets[0]!.close(1000);
    await done;
  });

  it("握手失败（非 101）：按普通 HTTP 透传 404 + 正文 + RESP_END，不进入流模式", async () => {
    const upstream = await startWsUpstream("echo"); // 升级走 404 handler：/ws 无对应路由 -> 404
    // 让 server 对 /ws 返回 404：上面的 createServer handler 已统一 404（upgrade 只对 upgrade 事件生效）
    const h = makeHarness();
    const done = startWsForward(h, upstream.port, wsReq("w3", { path: "/nowsv-path" }));
    await done;
    const meta = (await waitFor(() => of(h.consumerEvents, FRAME_TYPE.RESP_META, "w3")[0])).header as { status: number; contentType: string };
    expect(meta.status).toBe(404);
    expect(meta.contentType).toBe("application/json");
    const chunks = of(h.consumerEvents, FRAME_TYPE.RESP_CHUNK, "w3");
    expect(Buffer.concat(chunks.map((f) => bodyOf(f))).toString()).toBe('{"error":"no websocket here"}');
    expect(of(h.consumerEvents, FRAME_TYPE.RESP_END, "w3")).toHaveLength(1);
    expect(of(h.consumerEvents, FRAME_TYPE.DATA_DOWN, "w3")).toHaveLength(0);
  });

  it("closeByPeer（使用方 CLOSE）：上游 WS 被关闭，不再回帧", async () => {
    const upstream = await startWsUpstream("echo");
    const h = makeHarness();
    const done = startWsForward(h, upstream.port, wsReq("w4"));
    await waitFor(() => of(h.consumerEvents, FRAME_TYPE.RESP_META, "w4")[0]);
    h.relay!.closeByPeer();
    await done;
    await waitFor(() => (upstream.sockets[0]!.readyState === WebSocket.CLOSED ? true : undefined));
    expect(of(h.consumerEvents, FRAME_TYPE.CLOSE, "w4")).toHaveLength(0); // 不回帧
  });

  it("abort（ABORT 语义）：回 ERROR(aborted) 并关闭上游", async () => {
    const upstream = await startWsUpstream("echo");
    const h = makeHarness();
    const done = startWsForward(h, upstream.port, wsReq("w5"));
    await waitFor(() => of(h.consumerEvents, FRAME_TYPE.RESP_META, "w5")[0]);
    h.relay!.abort("aborted", true);
    await waitFor(() => of(h.consumerEvents, FRAME_TYPE.ERROR, "w5")[0]);
    expect((of(h.consumerEvents, FRAME_TYPE.ERROR, "w5")[0]!.header as { code: string }).code).toBe("aborted");
    await done;
  });

  it("上游握手前连接失败 -> upstream_unreachable", async () => {
    const dead = await startWsUpstream("echo");
    const port = dead.port;
    await new Promise<void>((resolve) => dead.server.close(() => resolve()));
    const h = makeHarness();
    const done = startWsForward(h, port, wsReq("w6"));
    await done;
    const err = await waitFor(() => of(h.consumerEvents, FRAME_TYPE.ERROR, "w6")[0]);
    expect((err.header as { code: string }).code).toBe("upstream_unreachable");
  });
});
