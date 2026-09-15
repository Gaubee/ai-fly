// HTTP 上游转发单测（内存 loopback 成对 WireSession + 本地 mock 上游）：元信息/正文
// 透传（含白名单头与 4xx 原样）、$env 注入、路径注入零上游请求（// 与 ..）、
// 上游不可达、连接期超时（探测注入）、流停滞超时、ABORT 回 ERROR(aborted)、
// 首字节等待期 PING 节奏、用量记录；hooks-lifecycle 4.2/4.3 出站归一层（③ 接管/
// probeConnect 跳过/SSE 逐块/abort cancel 传播/③头投影、④ 变换、hook_failed 分族）。

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
      // hooks-lifecycle v2：$env 字面量间接引用（headers.set）。
      headers: { set: { authorization: "$env:UPSTREAM_KEY" } },
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

  it("$env 空串/未设置 -> 该头省略（v2 语义：不静默注入、也不拒绝）", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const service = makeService(upstream.port, {
      headers: { set: { authorization: "$env:EMPTY_KEY", "x-lit": "v" } },
    });
    const h = makeHarness();
    const fh = forward(h, service, makeReq("r3"), new Uint8Array(0), { env: { EMPTY_KEY: "" } });
    await fh.done;
    // 空 $env 头省略；其余字面量照常（hooks-lifecycle「字面量间接引用语义平移」）。
    expect(of(h.consumerEvents, FRAME_TYPE.RESP_END, "r3")).toHaveLength(1);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]!.headers["authorization"]).toBeUndefined();
    expect(upstream.requests[0]!.headers["x-lit"]).toBe("v");
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

  it("初始失败路径解绑外部 abort 监听（复核 R2-F4）：③构造/probe/fetch 三类失败 adds=removes", async () => {
    const countingSignal = (): { signal: AbortSignal; stats: () => { adds: number; removes: number } } => {
      const ctrl = new AbortController();
      let adds = 0;
      let removes = 0;
      const sig = ctrl.signal as AbortSignal & {
        addEventListener: typeof ctrl.signal.addEventListener;
        removeEventListener: typeof ctrl.signal.removeEventListener;
      };
      const origAdd = sig.addEventListener.bind(sig);
      const origRemove = sig.removeEventListener.bind(sig);
      sig.addEventListener = ((...args: Parameters<typeof origAdd>) => {
        adds += 1;
        return origAdd(...args);
      }) as typeof origAdd;
      sig.removeEventListener = ((...args: Parameters<typeof origRemove>) => {
        removes += 1;
        return origRemove(...args);
      }) as typeof origRemove;
      return { signal: ctrl.signal, stats: () => ({ adds, removes }) };
    };

    // a) ③ 脚本构造失败（HookStageError 路径）
    {
      const c = countingSignal();
      const upstream = await startUpstream((_req, res) => res.end("never"));
      const h = makeHarness();
      const fh = forward(
        h,
        makeService(upstream.port, { request: { script: "boom" } }),
        makeReq("f4a"),
        new Uint8Array(0),
        {
          signal: c.signal,
          loader: (name) => (name === "boom" ? { onRequest: () => { throw new Error("script blew up"); } } : undefined),
        },
      );
      await fh.done;
      expect((of(h.consumerEvents, FRAME_TYPE.ERROR, "f4a")[0]?.header as { code: string }).code).toBe("hook_failed");
      expect(c.stats()).toEqual({ adds: 1, removes: 1 });
    }
    // b) probe 失败（ProbeFailedError 路径，零 fetch）
    {
      const c = countingSignal();
      const upstream = await startUpstream((_req, res) => res.end("never"));
      const h = makeHarness();
      const fh = forward(h, makeService(upstream.port), makeReq("f4b"), new Uint8Array(0), {
        signal: c.signal,
        timeouts: { connectMs: 30, firstByteMs: 5_000, stallMs: 5_000, pingMs: 0 },
        probeConnect: () => Promise.reject(new Error("probe refused")),
        fetchImpl: (async () => {
          throw new Error("fetch must not run");
        }) as typeof fetch,
      });
      await fh.done;
      expect((of(h.consumerEvents, FRAME_TYPE.ERROR, "f4b")[0]?.header as { code: string }).code).toBe("upstream_unreachable");
      expect(c.stats()).toEqual({ adds: 1, removes: 1 });
    }
    // c) 原生 fetch 失败（ECONNREFUSED 路径）
    {
      const c = countingSignal();
      const dead = await startUpstream((_req, res) => res.end());
      const port = dead.port;
      await new Promise<void>((resolve) => dead.server.close(() => resolve()));
      const h = makeHarness();
      const fh = forward(h, makeService(port), makeReq("f4c"), new Uint8Array(0), { signal: c.signal });
      await fh.done;
      expect((of(h.consumerEvents, FRAME_TYPE.ERROR, "f4c")[0]?.header as { code: string }).code).toBe("upstream_unreachable");
      expect(c.stats()).toEqual({ adds: 1, removes: 1 });
    }
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
      headers: { set: { authorization: "$secret:openai", "x-env": "$env:SOME_VAR" } },
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
      headers: { set: { authorization: "$secret:openai" } },
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

// ---------------------------------------------------------------------------
// hooks-lifecycle 4.2/4.3：出站归一层（③ onRequest 接管 / ④ onResponse 插入）
// ---------------------------------------------------------------------------

const loaderOf = (mods: Record<string, Record<string, unknown>>) =>
  (name: string): Record<string, unknown> | undefined => mods[name];

describe("③ onRequest 接管出站（归一层）", () => {
  it("预设模式整段接管（rust-fetch-sidecar）：①②③ 均由整段脚本导出驱动、跳过 probe、零原生 fetch", async () => {
    const upstream = await startUpstream((_req, res) => res.end("never"));
    const mods = {
      full3: {
        onRequestBearerAuthentication: () => "tok-preset",
        onRequestHeaders: () => ({ set: { "x-from-preset": "yes" } }),
        onRequest: async () => ({
          status: 202,
          headers: { "content-type": "text/plain" },
          body: (async function* () {
            yield ENC.encode("pre");
            yield ENC.encode("set");
          })(),
        }),
        // 无 onResponse 导出：④ 走缺省直通
      },
    };
    let probeCalls = 0;
    let fetchCalls = 0;
    const h = makeHarness();
    const service = makeService(upstream.port, { hooks: { script: "full3" } });
    const fh = forward(h, service, makeReq("rp1"), new Uint8Array(0), {
      loader: loaderOf(mods),
      probeConnect: (_url, _ms) => {
        probeCalls += 1;
        return Promise.resolve();
      },
      fetchImpl: (async (...args: Parameters<typeof fetch>) => {
        fetchCalls += 1;
        return fetch(...args);
      }) as typeof fetch,
    });
    await fh.done;
    expect(probeCalls).toBe(0); // ③ 由整段脚本接管 → 跳过连接期探测
    expect(fetchCalls).toBe(0); // 零原生 fetch
    const meta = h.consumerEvents.find((f) => f.type === FRAME_TYPE.RESP_META);
    expect((meta?.header as { status?: number }).status).toBe(202);
    expect(fh.usage).toEqual([{ status: 202, bytes: 6 }]);
    // 上游 mock 未被触达（无真实出站）
    expect(upstream.requests).toHaveLength(0);
    void probeCalls;
  });

  it("预设模式部分覆盖：仅 ①② 导出时 ③ 回退 js-backend-fetch（含探测）", async () => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`auth=${req.headers.authorization ?? "?"}`);
    });
    const mods = {
      authOnly: {
        onRequestBearerAuthentication: () => "tok-custom",
        onRequestHeaders: () => ({ set: { "x-h": "1" } }),
      },
    };
    let probeCalls = 0;
    const h = makeHarness();
    const service = makeService(upstream.port, { hooks: { script: "authOnly" } });
    const fh = forward(h, service, makeReq("rp2"), new Uint8Array(0), {
      loader: loaderOf(mods),
      probeConnect: (_url, _ms) => {
        probeCalls += 1;
        return Promise.resolve();
      },
    });
    await fh.done;
    expect(probeCalls).toBe(1); // ③ 无导出 → 原生路径含探测
    expect(upstream.requests[0]?.headers.authorization).toBe("Bearer tok-custom"); // ① 生效
  });

  it("整体接管：跳过 probeConnect、零原生 fetch；脚本收 ctx{url,method,headers,body,signal}；③ 头小写化白名单投影", async () => {
    const upstream = await startUpstream((_req, res) => res.end("never"));
    let seen: Record<string, unknown> = {};
    const mods = {
      r: {
        onRequest: (ctx: Record<string, unknown>) => {
          seen = ctx;
          return {
            status: 201,
            headers: { "X-Request-Id": "rid-7", "X-Custom": "dropped", "Content-Type": "application/json" },
            body: (async function* () {
              yield ENC.encode('{"ok":');
              yield ENC.encode("true}");
            })(),
          };
        },
      },
    };
    let probeCalls = 0;
    let fetchCalls = 0;
    const h = makeHarness();
    const service = makeService(upstream.port, { request: { script: "r" } });
    const fh = forward(h, service, makeReq("q1", { method: "POST", bodyLen: 9 }), ENC.encode('{"q":1}'), {
      loader: loaderOf(mods),
      probeConnect: async () => {
        probeCalls += 1;
      },
      fetchImpl: (async (...args: Parameters<typeof fetch>) => {
        fetchCalls += 1;
        return fetch(...args);
      }) as typeof fetch,
    });
    await fh.done;
    // 归一产出：RESP_META（③ 头投影——白名单挑选 + content-type 独立字段）
    const meta = of(h.consumerEvents, FRAME_TYPE.RESP_META, "q1")[0]?.header as {
      status: number;
      contentType: string;
      headers?: Record<string, string>;
    };
    expect(meta.status).toBe(201);
    expect(meta.contentType).toBe("application/json");
    expect(meta.headers).toEqual({ "x-request-id": "rid-7" }); // 白名单外忽略（X-Custom）
    const chunks = of(h.consumerEvents, FRAME_TYPE.RESP_CHUNK, "q1");
    expect(Buffer.concat(chunks.map((c) => bodyOf(c))).toString()).toBe('{"ok":true}');
    expect(of(h.consumerEvents, FRAME_TYPE.RESP_END, "q1")).toHaveLength(1);
    // 连接语义归脚本：probeConnect 与原生 fetch 均零调用；上游零请求。
    expect(probeCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(upstream.requests).toHaveLength(0);
    // ctx 超集：url/method/headers（① 头链产物 + host）/body/signal。
    expect(seen.url).toBe(`http://127.0.0.1:${upstream.port}/v1/x`);
    expect(seen.method).toBe("POST");
    expect((seen.headers as Record<string, string>).host).toBe(`127.0.0.1:${upstream.port}`);
    expect(seen.body).toBeInstanceOf(Uint8Array);
    expect(seen.signal).toBeInstanceOf(AbortSignal);
    expect(fh.usage).toEqual([{ status: 201, bytes: 11 }]);
  });

  it("③ 构造期失效（绑定缺席）-> ERROR(hook_failed)，消息固定脱敏，零 probe 零 fetch", async () => {
    const upstream = await startUpstream((_req, res) => res.end("never"));
    let probeCalls = 0;
    let fetchCalls = 0;
    const h = makeHarness();
    const service = makeService(upstream.port, { request: { script: "missing-export" } });
    const fh = forward(h, service, makeReq("q2"), new Uint8Array(0), {
      probeConnect: async () => {
        probeCalls += 1;
      },
      fetchImpl: (async (...args: Parameters<typeof fetch>) => {
        fetchCalls += 1;
        return fetch(...args);
      }) as typeof fetch,
    });
    await fh.done;
    const err = of(h.consumerEvents, FRAME_TYPE.ERROR, "q2")[0]?.header as { code: string; message: string };
    expect(err.code).toBe("hook_failed");
    expect(err.message).toBe("hook stage failed");
    expect(probeCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(upstream.requests).toHaveLength(0);
    expect(fh.usage).toEqual([{ status: "hook_failed", bytes: 0 }]);
  });

  it("③ 流中途失败 -> RESP_META 已发后回 ERROR(hook_failed)（分族：非 upstream_unreachable）", async () => {
    const upstream = await startUpstream((_req, res) => res.end("never"));
    const mods = {
      r: {
        onRequest: () => ({
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
          body: (async function* () {
            yield ENC.encode("data: 1\n\n");
            throw new Error("script stream exploded");
          })(),
        }),
      },
    };
    const h = makeHarness();
    const fh = forward(h, makeService(upstream.port, { request: { script: "r" } }), makeReq("q3"), new Uint8Array(0), {
      loader: loaderOf(mods),
    });
    await fh.done;
    expect(of(h.consumerEvents, FRAME_TYPE.RESP_META, "q3")).toHaveLength(1);
    const chunks = of(h.consumerEvents, FRAME_TYPE.RESP_CHUNK, "q3");
    expect(Buffer.concat(chunks.map((c) => bodyOf(c))).toString()).toBe("data: 1\n\n");
    const err = of(h.consumerEvents, FRAME_TYPE.ERROR, "q3")[0]?.header as { code: string; message: string };
    expect(err.code).toBe("hook_failed");
    expect(err.message).toBe("hook stage failed"); // 脱敏：不含脚本抛错细节
    expect(of(h.consumerEvents, FRAME_TYPE.RESP_END, "q3")).toHaveLength(0);
  });

  it("③ SSE 逐块 + abort cancel 传播：中止即回 ERROR(aborted)，脚本流被取消（finally 观察）", async () => {
    let cancelled = false;
    const mods = {
      r: {
        onRequest: (ctx: Record<string, unknown>) => ({
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
          body: (async function* () {
            try {
              yield ENC.encode("part1\n");
              // 信号感知的挂起（契约：脚本流自担 signal 语义）
              await new Promise<void>((resolve) =>
                (ctx.signal as AbortSignal).addEventListener("abort", () => resolve(), { once: true }),
              );
              yield ENC.encode("part2-never\n");
            } finally {
              cancelled = true; // return() 传播证据
            }
          })(),
        }),
      },
    };
    const h = makeHarness();
    const fh = forward(h, makeService(65534, { request: { script: "r" } }), makeReq("q4"), new Uint8Array(0), {
      loader: loaderOf(mods),
      timeouts: { connectMs: 1_000, firstByteMs: 30_000, stallMs: 30_000, pingMs: 0 },
    });
    await waitFor(() => (of(h.consumerEvents, FRAME_TYPE.RESP_CHUNK, "q4").length > 0 ? true : undefined));
    fh.ctrl.abort(new UpstreamAbortError("aborted", true));
    await waitFor(() => (of(h.consumerEvents, FRAME_TYPE.ERROR, "q4").length > 0 ? true : undefined));
    expect((of(h.consumerEvents, FRAME_TYPE.ERROR, "q4")[0]?.header as { code: string }).code).toBe("aborted");
    await waitFor(() => (cancelled ? true : undefined), 3_000);
    expect(Buffer.concat(of(h.consumerEvents, FRAME_TYPE.RESP_CHUNK, "q4").map((c) => bodyOf(c))).toString()).toBe("part1\n");
    await fh.done;
  });
});

describe("④ onResponse 插入（归一后、RESP_META 前）", () => {
  it("局部覆盖：status/白名单内头生效、白名单外忽略、body 变换流式生效", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "x-request-id": "orig-rid", "x-custom": "orig" });
      res.end("hello ");
    });
    let ctxSeen: Record<string, unknown> = {};
    const mods = {
      t: {
        onResponse: async (ctx: Record<string, unknown>) => {
          ctxSeen = ctx;
          const original = ctx.body as AsyncIterable<Uint8Array>;
          return {
            status: 201,
            headers: { "x-request-id": "rid-9", "x-custom": "dropped", "content-type": "application/json" },
            body: (async function* () {
              for await (const chunk of original) {
                yield ENC.encode(Buffer.from(chunk).toString("utf8").toUpperCase());
              }
              yield ENC.encode("!");
            })(),
          };
        },
      },
    };
    const h = makeHarness();
    const fh = forward(h, makeService(upstream.port, { response: { script: "t" } }), makeReq("p1"), new Uint8Array(0), {
      loader: loaderOf(mods),
    });
    await fh.done;
    const meta = of(h.consumerEvents, FRAME_TYPE.RESP_META, "p1")[0]?.header as {
      status: number;
      contentType: string;
      headers?: Record<string, string>;
    };
    expect(meta.status).toBe(201);
    expect(meta.contentType).toBe("application/json");
    expect(meta.headers).toEqual({ "x-request-id": "rid-9" }); // 白名单外（x-custom）忽略
    const chunks = of(h.consumerEvents, FRAME_TYPE.RESP_CHUNK, "p1");
    expect(Buffer.concat(chunks.map((c) => bodyOf(c))).toString()).toBe("HELLO !");
    expect(of(h.consumerEvents, FRAME_TYPE.RESP_END, "p1")).toHaveLength(1);
    // ctx 超集：status/headers（归一后头态）/body/signal。
    expect(ctxSeen.status).toBe(200);
    expect((ctxSeen.headers as Record<string, string>)["x-request-id"]).toBe("orig-rid");
    expect(typeof (ctxSeen.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]).toBe("function");
    expect(fh.usage).toEqual([{ status: 201, bytes: 7 }]);
  });

  it("{} 返回 = 透传原归一流（status/头/body 原样）", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "x-request-id": "rid-keep" });
      res.end("passthrough");
    });
    const mods = { t: { onResponse: () => ({}) } };
    const h = makeHarness();
    const fh = forward(h, makeService(upstream.port, { response: { script: "t" } }), makeReq("p2"), new Uint8Array(0), {
      loader: loaderOf(mods),
    });
    await fh.done;
    const meta = of(h.consumerEvents, FRAME_TYPE.RESP_META, "p2")[0]?.header as {
      status: number;
      contentType: string;
      headers?: Record<string, string>;
    };
    expect(meta.status).toBe(200);
    expect(meta.contentType).toBe("text/plain");
    expect(meta.headers).toEqual({ "x-request-id": "rid-keep" });
    expect(Buffer.concat(of(h.consumerEvents, FRAME_TYPE.RESP_CHUNK, "p2").map((c) => bodyOf(c))).toString()).toBe("passthrough");
    expect(of(h.consumerEvents, FRAME_TYPE.RESP_END, "p2")).toHaveLength(1);
  });

  it("status 204 覆盖 -> contentType 归一为空（无正文语义投影）", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"x":1}');
    });
    const mods = { t: { onResponse: () => ({ status: 204, headers: { "content-type": "application/json" } }) } };
    const h = makeHarness();
    const fh = forward(h, makeService(upstream.port, { response: { script: "t" } }), makeReq("p3"), new Uint8Array(0), {
      loader: loaderOf(mods),
    });
    await fh.done;
    const meta = of(h.consumerEvents, FRAME_TYPE.RESP_META, "p3")[0]?.header as { status: number; contentType: string };
    expect(meta.status).toBe(204);
    expect(meta.contentType).toBe("");
  });

  it("④ 失效（抛错）-> ERROR(hook_failed)（RESP_META 未发，零正文）", async () => {
    const upstream = await startUpstream((_req, res) => res.end("never"));
    const mods = {
      t: {
        onResponse: () => {
          throw new Error("boom-secret");
        },
      },
    };
    const h = makeHarness();
    const fh = forward(h, makeService(upstream.port, { response: { script: "t" } }), makeReq("p4"), new Uint8Array(0), {
      loader: loaderOf(mods),
    });
    await fh.done;
    expect(of(h.consumerEvents, FRAME_TYPE.RESP_META, "p4")).toHaveLength(0);
    const err = of(h.consumerEvents, FRAME_TYPE.ERROR, "p4")[0]?.header as { code: string; message: string };
    expect(err.code).toBe("hook_failed");
    expect(err.message).toBe("hook stage failed");
  });

  it("④ 流式变换：上游 SSE 逐块到达即变换转发（不为拼齐缓冲）", async () => {
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
    const mods = {
      t: {
        onResponse: (ctx: Record<string, unknown>) => ({
          headers: { "content-type": "text/event-stream" },
          body: (async function* () {
            for await (const chunk of ctx.body as AsyncIterable<Uint8Array>) {
              yield ENC.encode(`[${Buffer.from(chunk).toString("utf8")}]`);
            }
          })(),
        }),
      },
    };
    const h = makeHarness();
    const origPush = h.consumerEvents.push.bind(h.consumerEvents);
    h.consumerEvents.push = (...frames: InboundFrame[]) => {
      for (const f of frames) {
        if (f.type === FRAME_TYPE.RESP_CHUNK && (f.header as { id?: string }).id === "p5") {
          events.push(`chunk:${bodyOf(f).toString()}`);
        }
      }
      return origPush(...frames);
    };
    const fh = forward(h, makeService(upstream.port, { response: { script: "t" } }), makeReq("p5"), new Uint8Array(0), {
      loader: loaderOf(mods),
    });
    await fh.done;
    const chunks = of(h.consumerEvents, FRAME_TYPE.RESP_CHUNK, "p5");
    // 反拼齐：首个变换分片先于上游 end；完整性与增量性。
    expect(events.indexOf("chunk:[data: 1\n\n]")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("chunk:[data: 1\n\n]")).toBeLessThan(events.indexOf("end"));
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(Buffer.concat(chunks.map((c) => bodyOf(c))).toString()).toBe(
      "[data: 1\n\n][data: 2\n\n][data: 3\n\n]",
    );
  });
});
