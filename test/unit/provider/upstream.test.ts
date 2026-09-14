// HTTP 上游转发单测（内存 loopback 成对 WireSession + 本地 mock 上游）：元信息/正文
// 透传（含白名单头与 4xx 原样）、$env 注入、路径注入零上游请求（// 与 ..）、
// 上游不可达、连接期超时（探测注入）、流停滞超时、ABORT 回 ERROR(aborted)、
// 首字节等待期 PING 节奏、用量记录。

import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FRAME_TYPE } from "../../../src/wire/frames.ts";
import type { ReqHeader } from "../../../src/wire/frames.ts";
import { WireSession, type InboundFrame } from "../../../src/wire/mux.ts";
import { createLoopbackPair } from "../wire/loopback.ts";
import { forwardRequest, UpstreamAbortError, type ForwardCtx, type UpstreamTimeouts } from "../../../src/provider/upstream.ts";
import type { ServiceConfig } from "../../../src/provider/store.ts";

const ENC = new TextEncoder();

interface UpstreamRequestLog {
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface MockUpstream {
  server: Server;
  port: number;
  requests: UpstreamRequestLog[];
  closedSockets: number;
}

let upstreams: MockUpstream[];

beforeEach(() => {
  upstreams = [];
});

afterEach(async () => {
  await Promise.all(upstreams.map((u) => new Promise<void>((resolve) => u.server.close(() => resolve()))));
});

async function startUpstream(handler: RequestListener): Promise<MockUpstream> {
  const requests: UpstreamRequestLog[] = [];
  const closedCounter = { count: 0 }; // 引用计数对象（直接存 number 会被快照冻结）
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({ url: req.url ?? "/", headers: req.headers, body: Buffer.concat(chunks) });
      handler(req, res);
    });
    res.on("close", () => {
      closedCounter.count += 1;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const mock: MockUpstream = {
    server,
    port: (server.address() as AddressInfo).port,
    requests,
    get closedSockets() {
      return closedCounter.count;
    },
  };
  upstreams.push(mock);
  return mock;
}

interface Harness {
  consumer: WireSession;
  provider: WireSession;
  consumerEvents: InboundFrame[];
}

function makeHarness(): Harness {
  const { a, b } = createLoopbackPair();
  const consumerEvents: InboundFrame[] = [];
  const consumer = new WireSession({ role: "consumer", transport: a, hooks: { onFrame: (f) => consumerEvents.push(f) } });
  const provider = new WireSession({ role: "provider", transport: b, hooks: {} });
  consumer.markAuthed();
  provider.markAuthed();
  return { consumer, provider, consumerEvents };
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

interface FrameHarness extends Harness {
  id: string;
  ctrl: AbortController;
  usage: Array<{ status: number | string; bytes: number }>;
  done: Promise<void>;
}

function forward(
  h: Harness,
  service: ServiceConfig,
  req: ReqHeader,
  body: Uint8Array = new Uint8Array(0),
  over: Partial<ForwardCtx> = {},
): FrameHarness {
  const id = req.id;
  const ctrl = new AbortController();
  const usage: Array<{ status: number | string; bytes: number }> = [];
  // 经使用方会话真实发送 REQ（在其 mux 登记 request-id；否则下行帧按未知 id 丢弃）。
  void h.consumer.send(FRAME_TYPE.REQ, req, body).catch(() => undefined);
  const done = forwardRequest({
    session: h.provider,
    id,
    service,
    req,
    body,
    signal: ctrl.signal,
    keyId: "k1",
    onUsage: (r) => usage.push({ status: r.status, bytes: r.bytes }),
    ...over,
  });
  return { ...h, id, ctrl, usage, done };
}

function of(events: InboundFrame[], type: number, id: string): InboundFrame[] {
  return events.filter((f) => f.type === type && (f.header as { id?: string }).id === id);
}

function bodyOf(f: InboundFrame): Buffer {
  return Buffer.from((f as { body?: Uint8Array }).body ?? new Uint8Array(0));
}

function makeService(port: number, over: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    serviceId: "svc1",
    name: "api",
    match: [{ type: "suffix", value: ".local" }],
    upstream: `http://127.0.0.1:${port}`,
    rewrite: undefined,
    defaultPort: 11434,
    enabled: true,
    ...over,
  };
}

function makeReq(id: string, over: Partial<ReqHeader> = {}): ReqHeader {
  return { v: 1, id, serviceId: "svc1", method: "GET", path: "/v1/x", bodyLen: 0, ...over };
}

describe("响应透传", () => {
  it("GET 200：RESP_META（白名单头）+ RESP_CHUNK + RESP_END；上游收到重写后 URL 与 Host", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "x-request-id": "req-42", "x-custom": "dropped" });
      res.end("hello world");
    });
    const h = makeHarness();
    const fh = forward(h, makeService(upstream.port), makeReq("r1", { path: "/v1/x" }));
    await fh.done;
    const meta = of(h.consumerEvents, FRAME_TYPE.RESP_META, "r1")[0]?.header as {
      status: number;
      contentType: string;
      headers?: Record<string, string>;
    };
    expect(meta.status).toBe(200);
    expect(meta.contentType).toBe("text/plain");
    expect(meta.headers).toEqual({ "x-request-id": "req-42" }); // 白名单外丢弃
    const chunks = of(h.consumerEvents, FRAME_TYPE.RESP_CHUNK, "r1");
    expect(Buffer.concat(chunks.map((c) => bodyOf(c))).toString()).toBe("hello world");
    expect(of(h.consumerEvents, FRAME_TYPE.RESP_END, "r1")).toHaveLength(1);
    expect(of(h.consumerEvents, FRAME_TYPE.ERROR, "r1")).toHaveLength(0);
    // 上游视角：URL / Host / 无凭据头
    expect(upstream.requests[0]?.url).toBe("/v1/x");
    expect(upstream.requests[0]?.headers.host).toBe(`127.0.0.1:${upstream.port}`);
    expect(upstream.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("POST：$env 注入 authorization、contentType、正文逐字节一致", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    const service = makeService(upstream.port, {
      rewrite: { headerSet: { authorization: { hook: "authHeader", args: { var: "UPSTREAM_KEY" } } } },
    });
    const h = makeHarness();
    const body = ENC.encode('{"q":"hi"}');
    const fh = forward(h, service, makeReq("r2", { method: "POST", path: "/v1/chat", contentType: "application/json", bodyLen: body.length }), body, {
      env: { UPSTREAM_KEY: "sk-env-secret-1" },
    });
    await fh.done;
    expect(of(h.consumerEvents, FRAME_TYPE.RESP_END, "r2")).toHaveLength(1);
    const seen = upstream.requests[0];
    expect(seen?.headers.authorization).toBe("sk-env-secret-1");
    expect(seen?.headers["content-type"]).toBe("application/json");
    expect(seen?.body.toString()).toBe('{"q":"hi"}');
  });

  it("env 钩子空串 -> fail-fast ERROR(secret_missing)（语义收紧：不再静默省略）", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const service = makeService(upstream.port, {
      hooks: "env",
      rewrite: { headerSet: { authorization: { hook: "authHeader", args: { var: "EMPTY_KEY" } }, "x-lit": "v" } },
    });
    const h = makeHarness();
    const fh = forward(h, service, makeReq("r3"), new Uint8Array(0), { env: { EMPTY_KEY: "" } });
    await fh.done;
    const err = of(h.consumerEvents, FRAME_TYPE.ERROR, "r3")[0]?.header as { code: string };
    expect(err.code).toBe("secret_missing");
    expect(upstream.requests).toHaveLength(0); // 零上游请求
    expect(fh.usage).toEqual([{ status: "secret_missing", bytes: 0 }]);
  });

  it("上游 404 原样透传（status + 正文 + contentType，无 ERROR 帧）", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"not found"}');
    });
    const h = makeHarness();
    const fh = forward(h, makeService(upstream.port), makeReq("r4"));
    await fh.done;
    const meta = of(h.consumerEvents, FRAME_TYPE.RESP_META, "r4")[0]?.header as { status: number };
    expect(meta.status).toBe(404);
    const chunks = of(h.consumerEvents, FRAME_TYPE.RESP_CHUNK, "r4");
    expect(Buffer.concat(chunks.map((c) => bodyOf(c))).toString()).toBe('{"error":"not found"}');
    expect(of(h.consumerEvents, FRAME_TYPE.RESP_END, "r4")).toHaveLength(1);
    expect(of(h.consumerEvents, FRAME_TYPE.ERROR, "r4")).toHaveLength(0);
  });

  it("流式逐块：SSE 事件增量到达，不为拼齐缓冲", async () => {
    // 满载事件循环下读端可能把相邻两次 write 合成一个分片（合法的到达粒度
    // 语义），判据因此取「序」而非「数」：首分片必须先于上游 res.end 抵达
    // 消费端（拼齐缓冲只会把正文积压到流结束后一次发出）。60ms 间隔为
    // 调度抖动留余量；帧经 onFrame 同步入列，事件序判据对负载免疫。
    const events: string[] = [];
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n");
      setTimeout(() => res.write("data: 2\n\n"), 60);
      setTimeout(() => {
        events.push("end");
        res.end("data: 3\n\n");
      }, 120);
    });
    const h = makeHarness();
    const origPush = h.consumerEvents.push.bind(h.consumerEvents);
    h.consumerEvents.push = (...frames: InboundFrame[]) => {
      for (const f of frames) {
        if (f.type === FRAME_TYPE.RESP_CHUNK && (f.header as { id?: string }).id === "r5") {
          events.push(`chunk:${bodyOf(f).toString()}`);
        }
      }
      return origPush(...frames);
    };
    const fh = forward(h, makeService(upstream.port), makeReq("r5"));
    await fh.done;
    const chunks = of(h.consumerEvents, FRAME_TYPE.RESP_CHUNK, "r5");
    // 反拼齐：仅含首个事件的首分片，在上游写 end 之前已转发
    expect(events.indexOf("chunk:data: 1\n\n")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("chunk:data: 1\n\n")).toBeLessThan(events.indexOf("end"));
    // 增量性：不止一个分片；首分片独立（不与后续事件合并）
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(bodyOf(chunks[0]!).toString()).toBe("data: 1\n\n");
    // 完整性与按序：拼接 == 全正文，seq 严格递增
    expect(Buffer.concat(chunks.map((c) => bodyOf(c))).toString()).toBe("data: 1\n\ndata: 2\n\ndata: 3\n\n");
    const seqs = chunks.map((c) => (c.header as { seq: number }).seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});

describe("错误与超时族", () => {
  it("上游不可达（连接拒绝）-> ERROR(upstream_unreachable)", async () => {
    const dead = await startUpstream((_req, res) => res.end());
    const port = dead.port;
    await new Promise<void>((resolve) => dead.server.close(() => resolve()));
    const h = makeHarness();
    const fh = forward(h, makeService(port), makeReq("r6"));
    await fh.done;
    const err = of(h.consumerEvents, FRAME_TYPE.ERROR, "r6")[0]?.header as { code: string };
    expect(err.code).toBe("upstream_unreachable");
    expect(fh.usage).toEqual([{ status: "upstream_unreachable", bytes: 0 }]);
  });

  it("连接期超时（探测注入）-> upstream_unreachable 且零 fetch", async () => {
    const upstream = await startUpstream((_req, res) => res.end("never"));
    let fetchCalls = 0;
    const h = makeHarness();
    const fh = forward(
      h,
      makeService(upstream.port),
      makeReq("r7"),
      new Uint8Array(0),
      {
        timeouts: { connectMs: 30, firstByteMs: 5_000, stallMs: 5_000, pingMs: 0 },
        probeConnect: (_url, ms) =>
          new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("connect timeout")), ms)),
        fetchImpl: (async (...args: Parameters<typeof fetch>) => {
          fetchCalls += 1;
          return fetch(...args);
        }) as typeof fetch,
      },
    );
    await fh.done;
    const err = of(h.consumerEvents, FRAME_TYPE.ERROR, "r7")[0]?.header as { code: string };
    expect(err.code).toBe("upstream_unreachable");
    expect(fetchCalls).toBe(0);
  });

  it("路径注入零上游请求：/../../admin -> ERROR(protocol_error)", async () => {
    const upstream = await startUpstream((_req, res) => res.end("never"));
    const h = makeHarness();
    const fh = forward(h, makeService(upstream.port), makeReq("r8", { path: "/../../admin" }));
    await fh.done;
    const err = of(h.consumerEvents, FRAME_TYPE.ERROR, "r8")[0]?.header as { code: string };
    expect(err.code).toBe("protocol_error");
    expect(upstream.requests).toHaveLength(0);
  });

  it("路径注入零上游请求：//evil.com -> ERROR(protocol_error)", async () => {
    const upstream = await startUpstream((_req, res) => res.end("never"));
    const h = makeHarness();
    const fh = forward(h, makeService(upstream.port), makeReq("r9", { path: "//evil.com/v1/keys" }));
    await fh.done;
    expect((of(h.consumerEvents, FRAME_TYPE.ERROR, "r9")[0]?.header as { code: string }).code).toBe("protocol_error");
    expect(upstream.requests).toHaveLength(0);
  });

  it("GET 携带正文 -> protocol_error", async () => {
    const upstream = await startUpstream((_req, res) => res.end("never"));
    const h = makeHarness();
    const fh = forward(h, makeService(upstream.port), makeReq("r10", { bodyLen: 4 }), ENC.encode("abcd"));
    await fh.done;
    expect((of(h.consumerEvents, FRAME_TYPE.ERROR, "r10")[0]?.header as { code: string }).code).toBe("protocol_error");
    expect(upstream.requests).toHaveLength(0);
  });

  it("$secret 命中：上游收到密钥库完整头值", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const h = makeHarness();
    const service = makeService(upstream.port, {
      rewrite: { headerSet: { authorization: { hook: "authHeader", args: { name: "openai" } }, "x-env": { hook: "authHeader", args: { var: "SOME_VAR" } } } },
    });
    const fh = forward(h, service, makeReq("rs1", { method: "POST" }), new Uint8Array(0), {
      secrets: (name) => (name === "openai" ? "Bearer sk-lib-9" : undefined),
      env: { SOME_VAR: "env-val" },
    });
    await fh.done;
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]!.headers["authorization"]).toBe("Bearer sk-lib-9");
    expect(upstream.requests[0]!.headers["x-env"]).toBe("env-val");
    expect(of(h.consumerEvents, FRAME_TYPE.RESP_END, "rs1")).toHaveLength(1);
  });

  it("$secret 未命中 -> ERROR(secret_missing)，零上游请求，错误信息不含名字", async () => {
    const upstream = await startUpstream((_req, res) => res.end("never"));
    const h = makeHarness();
    const service = makeService(upstream.port, {
      rewrite: { headerSet: { authorization: { hook: "authHeader", args: { name: "openai" } } } },
    });
    const fh = forward(h, service, makeReq("rs2", { method: "POST" }), new Uint8Array(0), {
      secrets: () => undefined,
    });
    await fh.done;
    const err = of(h.consumerEvents, FRAME_TYPE.ERROR, "rs2")[0]?.header as {
      code: string;
      message: string;
    };
    expect(err.code).toBe("secret_missing");
    expect(err.message).not.toContain("openai");
    expect(upstream.requests).toHaveLength(0);
    expect(fh.usage).toEqual([{ status: "secret_missing", bytes: 0 }]);
  });

  it("流中途停滞（120s 可配 -> 60ms）-> ERROR(idle_timeout) 且中止上游", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("first\n");
      // 之后停滞不发
    });
    const h = makeHarness();
    const fh = forward(h, makeService(upstream.port), makeReq("r11"), new Uint8Array(0), {
      timeouts: { connectMs: 1_000, firstByteMs: 5_000, stallMs: 60, pingMs: 0 },
    });
    await fh.done;
    const chunks = of(h.consumerEvents, FRAME_TYPE.RESP_CHUNK, "r11");
    expect(Buffer.concat(chunks.map((c) => bodyOf(c))).toString()).toBe("first\n");
    expect((of(h.consumerEvents, FRAME_TYPE.ERROR, "r11")[0]?.header as { code: string }).code).toBe("idle_timeout");
    await waitFor(() => (upstream.closedSockets > 0 ? true : undefined), 6_000);
  });

  it("ABORT -> 中止上游并回 ERROR(aborted)", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("part1\n");
    });
    const h = makeHarness();
    const fh = forward(h, makeService(upstream.port), makeReq("r12"), new Uint8Array(0), {
      timeouts: { connectMs: 1_000, firstByteMs: 30_000, stallMs: 30_000, pingMs: 0 },
    });
    await waitFor(() => (of(h.consumerEvents, FRAME_TYPE.RESP_CHUNK, "r12").length > 0 ? true : undefined));
    fh.ctrl.abort(new UpstreamAbortError("aborted", true));
    await waitFor(() => (of(h.consumerEvents, FRAME_TYPE.ERROR, "r12").length > 0 ? true : undefined));
    expect((of(h.consumerEvents, FRAME_TYPE.ERROR, "r12")[0]?.header as { code: string }).code).toBe("aborted");
    await waitFor(() => (upstream.closedSockets > 0 ? true : undefined), 6_000);
    await fh.done;
  });
});

describe("首字节等待期心跳与用量", () => {
  it("上游迟滞 100ms：等待期按 25ms 节奏收到 >=3 次 PING，随后正常完成", async () => {
    const upstream = await startUpstream((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("done");
      }, 100);
    });
    const h = makeHarness();
    const fh = forward(h, makeService(upstream.port), makeReq("r13"), new Uint8Array(0), {
      timeouts: { connectMs: 1_000, firstByteMs: 5_000, stallMs: 5_000, pingMs: 25 },
    });
    await fh.done;
    expect(of(h.consumerEvents, FRAME_TYPE.PING, "r13").length).toBeGreaterThanOrEqual(3);
    expect(of(h.consumerEvents, FRAME_TYPE.RESP_END, "r13")).toHaveLength(1);
    expect(fh.usage).toEqual([{ status: 200, bytes: 4 }]);
  });

  it("用量记录：成功记 status+bytes；失败记错误码", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("12345");
    });
    const h = makeHarness();
    const fh = forward(h, makeService(upstream.port), makeReq("r14"));
    await fh.done;
    expect(fh.usage).toEqual([{ status: 200, bytes: 5 }]);
  });
});
