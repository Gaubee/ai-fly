// consumer/gateway 单测（fake ProviderRoute + 真实 127.0.0.1 监听 + 真实 ws 客户端）：
// ERROR 码→HTTP 映射表驱动、上游状态/正文/contentType 透传、SSE 逐块顺序还原、
// 请求头剥离与 WS 握手头透传构造断言、WS 升级/双向/关闭、accept 一致性校验、
// WS 握手失败 404 透传、接收缓冲兜底（ABORT + 连接错误关闭 + 记账）、离线快速失败
// （503 JSON 含别名）、目录删除服务（关端口 + 在途终结）、端口冲突 NOTICE。

import { createServer, connect as tcpConnect, type Socket } from "node:net";
import { createServer as httpServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createHash } from "node:crypto";
import type { ErrorCodeValue, RespMetaHeader, ServiceEntry } from "../../../src/wire/frames.ts";
import type { TerminateCause } from "../../../src/wire/mux.ts";
import {
  Gateway,
  filterRequestHeaders,
  type GatewayOptions,
} from "../../../src/consumer/gateway.ts";
import type { ForwardHandle, ForwardHandlers, ForwardInput, ProviderRoute, ProviderStateKind } from "../../../src/consumer/providers.ts";

// ---------------------------------------------------------------------------
// fake 路由（可编程对端）
// ---------------------------------------------------------------------------

class FakeHandle implements ForwardHandle {
  readonly id = "fake-id";
  aborted: Array<{ ws?: boolean; code?: number } | undefined> = [];
  sentData: Uint8Array[] = [];
  constructor(readonly handlers: ForwardHandlers) {}
  abort(opts?: { ws?: boolean; code?: number }): void {
    this.aborted.push(opts);
  }
  sendData(bytes: Uint8Array): Promise<void> {
    this.sentData.push(bytes);
    return Promise.resolve();
  }
}

class FakeRoute implements ProviderRoute {
  alias: string;
  state: ProviderStateKind = "direct";
  inputs: ForwardInput[] = [];
  handles: FakeHandle[] = [];
  overflows = 0;
  /** forward 时的可编程动作（默认挂起等测试驱动）。 */
  onForward: ((input: ForwardInput, handle: FakeHandle) => void) | undefined = undefined;

  constructor(alias = "prov-x") {
    this.alias = alias;
  }
  forward(input: ForwardInput, handlers: ForwardHandlers): ForwardHandle {
    if (this.state !== "direct" && this.state !== "relay") {
      const err = new Error(
        this.state === "key-all-invalid" ? `all keys for '${this.alias}' were rejected` : `provider '${this.alias}' is offline`,
      ) as Error & { code: string; alias: string };
      err.code = this.state === "key-all-invalid" ? "key_all_invalid" : "provider_offline";
      err.alias = this.alias;
      throw err;
    }
    this.inputs.push(input);
    const handle = new FakeHandle(handlers);
    this.handles.push(handle);
    this.onForward?.(input, handle);
    return handle;
  }
  noteBufferOverflow(): void {
    this.overflows++;
  }
}

// 离线快速失败需要 OfflineError 实例（providers.ts 真类型）
import { OfflineError } from "../../../src/consumer/providers.ts";

function offlineRoute(alias: string): FakeRoute {
  const r = new FakeRoute(alias);
  r.state = "offline";
  const orig = r.forward.bind(r);
  r.forward = (input, handlers) => {
    void input;
    void handlers;
    throw new OfflineError("provider_offline", alias);
  };
  void orig;
  return r;
}

// ---------------------------------------------------------------------------
// 基建
// ---------------------------------------------------------------------------

const ENC = new TextEncoder();

function svc(serviceId: string, name: string, defaultPort: number): ServiceEntry {
  return { serviceId, name, match: [], defaultPort };
}

interface GwHarness {
  gateway: Gateway;
  route: FakeRoute;
  notices: string[];
  port: number;
  stop(): Promise<void>;
}

let running: Array<() => Promise<void>> = [];

async function bootGateway(
  route: FakeRoute,
  service: ServiceEntry,
  opts: Partial<GatewayOptions> = {},
  ports: Record<string, number> = {},
): Promise<GwHarness> {
  const notices: string[] = [];
  const gateway = new Gateway({
    resolveRoute: () => route,
    onNotice: (l) => notices.push(l),
    ...opts,
  });
  await gateway.syncProviderServices("p1", route.alias, [service], ports);
  const info = gateway.listenerInfo().find((l) => l.serviceId === service.serviceId)!;
  const stop = async () => gateway.stop();
  running.push(stop);
  return { gateway, route, notices, port: info.port, stop };
}

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const s = createServer();
    s.listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

beforeEach(() => {
  running = [];
});

afterEach(async () => {
  for (const off of running.splice(0)) await off();
});

// ---------------------------------------------------------------------------
// ERROR 码 → HTTP 映射（表驱动）
// ---------------------------------------------------------------------------

describe("错误码 → HTTP 映射", () => {
  const table: Array<{ code: ErrorCodeValue; expect: number | "destroy" }> = [
    { code: "rate_limited", expect: 429 },
    { code: "quota_exceeded", expect: 429 },
    { code: "forbidden_method", expect: 405 },
    { code: "forbidden_header", expect: 400 },
    { code: "body_too_large", expect: 413 },
    { code: "unknown_service", expect: 404 },
    { code: "unauthorized", expect: 401 },
    { code: "key_all_invalid", expect: 503 },
    { code: "upstream_unreachable", expect: 502 },
    { code: "upstream_status", expect: 502 }, // 裸 ERROR 帧（无 status 载荷）兜底；正常上游错误走 RESP 流
    { code: "secret_missing", expect: 502 }, // 提供方密钥库缺引用：提供方配置问题，502
    { code: "protocol_error", expect: 500 },
    { code: "protocol_seq", expect: 500 },
    { code: "internal", expect: 500 },
    { code: "idle_timeout", expect: 504 }, // 等待期收到的连接类语义：504 实体（裁决见实现注释）
    { code: "buffer_overflow", expect: 504 },
  ];

  for (const { code, expect: want } of table) {
    it(`${code} -> ${want}`, async () => {
      const route = new FakeRoute();
      route.onForward = (_i, h) => h.handlers.onError({ id: "x", code, message: `boom ${code}` });
      const gw = await bootGateway(route, svc("svc-a", "a", await freePort()));
      const res = await fetch(`http://127.0.0.1:${gw.port}/v1/x`);
      const body = (await res.json()) as { error: { message: string; type: string; code: string } };
      expect(res.status).toBe(want);
      expect(body.error.code).toBe(code);
      expect(body.error.message).toContain(code);
      expect(typeof body.error.type).toBe("string");
      await gw.stop();
    });
  }

  it("openai 风格错误体形状 {error:{message,type,code}}", async () => {
    const route = new FakeRoute();
    route.onForward = (_i, h) => h.handlers.onError({ id: "x", code: "unknown_service", message: "no such service" });
    const gw = await bootGateway(route, svc("svc-a", "a", await freePort()));
    const res = await fetch(`http://127.0.0.1:${gw.port}/x`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["error"]);
    expect(Object.keys(body.error as object).sort()).toEqual(["code", "message", "type"]);
    await gw.stop();
  });
});

// ---------------------------------------------------------------------------
// 成功路径：透传与流式
// ---------------------------------------------------------------------------

describe("HTTP 转发与流式还原", () => {
  it("上游 status/正文/contentType 原样透传（RESP 流路径）", async () => {
    const route = new FakeRoute();
    route.onForward = (_i, h) => {
      h.handlers.onMeta({ id: "x", status: 429, contentType: "application/problem+json" });
      h.handlers.onChunk(ENC.encode('{"limited":true}'));
      h.handlers.onEnd();
      h.handlers.onTerminate({ source: "peer", frameType: 8 });
    };
    const gw = await bootGateway(route, svc("svc-a", "a", await freePort()));
    const res = await fetch(`http://127.0.0.1:${gw.port}/v1/keys`);
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.text()).toBe('{"limited":true}');
    await gw.stop();
  });

  it("SSE 逐块顺序还原（含 data: [DONE]）", async () => {
    const chunks = ["data: {\"a\":1}\n\n", "data: {\"b\":2}\n\n", "data: [DONE]\n\n"];
    const route = new FakeRoute();
    route.onForward = (_i, h) => {
      void (async () => {
        h.handlers.onMeta({ id: "x", status: 200, contentType: "text/event-stream" });
        for (const c of chunks) {
          await delay(5);
          h.handlers.onChunk(ENC.encode(c));
        }
        await delay(5);
        h.handlers.onEnd();
        h.handlers.onTerminate({ source: "peer", frameType: 8 });
      })();
    };
    const gw = await bootGateway(route, svc("svc-a", "a", await freePort()));
    const res = await fetch(`http://127.0.0.1:${gw.port}/v1/chat/completions`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toBe(chunks.join(""));
    await gw.stop();
  });

  it("请求侧构造：凭据头剥离、contentType 独立、path 原样含查询串、正文与白名单头透传", async () => {
    const route = new FakeRoute();
    route.onForward = (_i, h) => {
      h.handlers.onMeta({ id: "x", status: 200, contentType: "application/json" });
      h.handlers.onEnd();
      h.handlers.onTerminate({ source: "peer", frameType: 8 });
    };
    const gw = await bootGateway(route, svc("svc-a", "a", await freePort()));
    const res = await fetch(`http://127.0.0.1:${gw.port}/v1/x?y=1&z=2`, {
      method: "POST",
      headers: {
        authorization: "Bearer sk-secret",
        cookie: "session=1",
        "x-custom": "keepme",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: '{"hello":"world"}',
    });
    expect(res.status).toBe(200);
    expect(route.inputs).toHaveLength(1);
    const input = route.inputs[0]!;
    expect(input.path).toBe("/v1/x?y=1&z=2");
    expect(input.method).toBe("POST");
    expect(input.contentType).toBe("application/json");
    expect(input.headers).toBeDefined();
    expect(input.headers).not.toHaveProperty("authorization");
    expect(input.headers).not.toHaveProperty("cookie");
    expect(input.headers).not.toHaveProperty("host");
    expect(input.headers).not.toHaveProperty("content-type");
    expect(input.headers).not.toHaveProperty("content-length");
    expect(input.headers).toMatchObject({ "x-custom": "keepme", "anthropic-version": "2023-06-01" });
    expect(new TextDecoder().decode(input.body)).toBe('{"hello":"world"}');
    await gw.stop();
  });

  it("RESP_META 白名单头（x-request-id / retry-after）下发", async () => {
    const route = new FakeRoute();
    route.onForward = (_i, h) => {
      h.handlers.onMeta({ id: "x", status: 429, contentType: "text/plain", headers: { "x-request-id": "req-9", "retry-after": "3" } });
      h.handlers.onEnd();
      h.handlers.onTerminate({ source: "peer", frameType: 8 });
    };
    const gw = await bootGateway(route, svc("svc-a", "a", await freePort()));
    const res = await fetch(`http://127.0.0.1:${gw.port}/x`);
    expect(res.headers.get("x-request-id")).toBe("req-9");
    expect(res.headers.get("retry-after")).toBe("3");
    await gw.stop();
  });

  it("OPTIONS（方法枚举外）本地 405 forbidden_method", async () => {
    const gw = await bootGateway(new FakeRoute(), svc("svc-a", "a", await freePort()));
    const res = await fetch(`http://127.0.0.1:${gw.port}/x`, { method: "OPTIONS" });
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status).toBe(405);
    expect(body.error.code).toBe("forbidden_method");
    expect(gw.route.inputs).toHaveLength(0);
    await gw.stop();
  });

  it("本地请求体 >8MiB：413 body_too_large（零转发）", async () => {
    const gw = await bootGateway(new FakeRoute(), svc("svc-a", "a", await freePort()));
    const big = "x".repeat(8 * 1024 * 1024 + 1);
    const res = await fetch(`http://127.0.0.1:${gw.port}/big`, { method: "POST", body: big });
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status).toBe(413);
    expect(body.error.code).toBe("body_too_large");
    expect(gw.route.inputs).toHaveLength(0);
    await gw.stop();
  });

  it("离线快速失败：503 provider_offline，错误体含提供者别名", async () => {
    const gw = await bootGateway(offlineRoute("home-box"), svc("svc-a", "a", await freePort()));
    const res = await fetch(`http://127.0.0.1:${gw.port}/x`);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(res.status).toBe(503);
    expect(body.error.code).toBe("provider_offline");
    expect(body.error.message).toContain("home-box");
    await gw.stop();
  });

  it("客户端断开（流中）→ ABORT 发出", async () => {
    const route = new FakeRoute();
    const ac = new AbortController();
    route.onForward = (_i, h) => {
      void (async () => {
        h.handlers.onMeta({ id: "x", status: 200, contentType: "text/event-stream" });
        await delay(10);
        h.handlers.onChunk(ENC.encode("data: 1\n\n"));
        await delay(300); // 客户端将在其间断开
        h.handlers.onChunk(ENC.encode("data: 2\n\n"));
      })();
    };
    const gw = await bootGateway(route, svc("svc-a", "a", await freePort()));
    const p = fetch(`http://127.0.0.1:${gw.port}/stream`, { signal: ac.signal });
    void p.catch(() => undefined);
    await delay(50);
    ac.abort();
    await delay(100);
    expect(route.handles[0]!.aborted.length).toBeGreaterThanOrEqual(1);
    await gw.stop();
  });
});

// ---------------------------------------------------------------------------
// 接收缓冲兜底（4MiB 语义，测试用小限额）
// ---------------------------------------------------------------------------

describe("接收侧兜底（buffer_overflow）", () => {
  it("待消费缓冲超限 → ABORT + 记账 + 连接错误关闭", async () => {
    const route = new FakeRoute();
    const limit = 4 * 1024;
    route.onForward = (_i, h) => {
      // 同步连发：客户端尚未消费任何字节（fetch 未返回）。首个 chunk 会被 pump
      // 漏进流内部队列（HWM=1 计数，内存上界 = limit + 单 chunk），第二块起全部
      // 计入待消费缓冲 → 第三块触发超限。
      h.handlers.onMeta({ id: "x", status: 200, contentType: "application/octet-stream" });
      h.handlers.onChunk(new Uint8Array(limit)); // 漏入流内部队列（desiredSize 归零）
      h.handlers.onChunk(new Uint8Array(limit)); // 待消费 = limit（恰好到达）
      h.handlers.onChunk(new Uint8Array(1)); // 再来 1 字节 → 超限
    };
    const gw = await bootGateway(route, svc("svc-a", "a", await freePort()), { receiveBufferLimitBytes: limit });
    const res = await fetch(`http://127.0.0.1:${gw.port}/big`); // 头已到达（meta 先行）
    await expect(res.arrayBuffer()).rejects.toThrow(); // 流中途错误关闭（连接错误语义）
    expect(route.handles[0]!.aborted.length).toBe(1);
    expect(route.overflows).toBe(1);
    await gw.stop();
  });

  it("限额内正常消费（不误伤）", async () => {
    const route = new FakeRoute();
    const limit = 64 * 1024;
    route.onForward = (_i, h) => {
      void (async () => {
        h.handlers.onMeta({ id: "x", status: 200, contentType: "application/octet-stream" });
        for (let i = 0; i < 8; i++) {
          h.handlers.onChunk(new Uint8Array(1024));
          await delay(2); // 客户端持续消费
        }
        h.handlers.onEnd();
        h.handlers.onTerminate({ source: "peer", frameType: 8 });
      })();
    };
    const gw = await bootGateway(route, svc("svc-a", "a", await freePort()), { receiveBufferLimitBytes: limit });
    const res = await fetch(`http://127.0.0.1:${gw.port}/ok`);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(8 * 1024);
    expect(route.overflows).toBe(0);
    await gw.stop();
  });
});

// ---------------------------------------------------------------------------
// WS 中继
// ---------------------------------------------------------------------------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function acceptFor(key: string): string {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

describe("WS 中继", () => {
  it("升级成功：握手头端到端透传构造 + 双向消息 + 关闭 CLOSE", async () => {
    const route = new FakeRoute();
    const gw = await bootGateway(route, svc("svc-a", "a", await freePort()));
    // 先编程对端行为，再发起客户端连接（避免升级请求先于 onForward 就绪）
    const seen: Array<{ key: string | undefined; upgrade: string | undefined; hasHost: boolean }> = [];
    route.onForward = (input, handle) => {
      seen.push({
        key: input.headers?.["sec-websocket-key"],
        upgrade: input.headers?.upgrade,
        hasHost: input.headers?.host !== undefined,
      });
      // 按“端到端透传的客户端 key”计算 accept（协议一致性：key 原样进帧 → accept 恒等）
      const clientKey = input.headers?.["sec-websocket-key"] ?? "";
      const meta: RespMetaHeader = {
        id: "w",
        status: 101,
        contentType: "text/plain",
        headers: { "sec-websocket-accept": acceptFor(clientKey) },
      };
      handle.handlers.onMeta(meta);
      void handle.handlers.onWsData(ENC.encode("hi from upstream"));
    };
    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/v1/ws`);
    const opened = new Promise<void>((r) => ws.once("open", () => r()));
    // 下行消息随 open 同 tick 冲刷——监听必须在 await open 之前注册
    const msgPromise = new Promise<string>((r) => ws.once("message", (d) => r(d.toString())));
    await opened;
    // WS 握手头透传构造断言（本地客户端的 key 原样进帧；host/cookie 不进帧）
    expect(seen[0]!.key).toBeTruthy();
    expect(seen[0]!.key!.length).toBeGreaterThanOrEqual(16);
    expect(seen[0]!.upgrade?.toLowerCase()).toBe("websocket");
    expect(seen[0]!.hasHost).toBe(false);
    expect(route.inputs[0]!.upgrade).toBe(true);
    expect(route.inputs[0]!.method).toBe("GET");
    // 下行消息可能随 open 立即冲刷——先注册监听再触发上行
    ws.send("hello up");
    await delay(30);
    expect(route.handles[0]!.sentData.length).toBe(1);
    expect(Buffer.from(route.handles[0]!.sentData[0]!).toString()).toBe("hello up");
    // 服务端消息到达客户端
    expect(await msgPromise).toBe("hi from upstream");
    // 客户端关闭 → CLOSE 语义（abort ws）
    ws.close(1000);
    await delay(50);
    expect(route.handles[0]!.aborted.length).toBe(1);
    expect(route.handles[0]!.aborted[0]?.ws).toBe(true);
    await gw.stop();
  });

  it("上游 accept 与本地计算不一致 → 升级照常成立（上游 ws 库自管 key，不做恒等校验）", async () => {
    const route = new FakeRoute();
    const gw = await bootGateway(route, svc("svc-a", "a", await freePort()));
    route.onForward = (_i, handle) => {
      handle.handlers.onMeta({
        id: "w",
        status: 101,
        contentType: "text/plain",
        headers: { "sec-websocket-accept": "upstream-lib-managed-accept" },
      });
    };
    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/ws`);
    // open 即证明本地 accept（ws 库按客户端 key 自算）校验通过，上游 accept 仅参考
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (e) => reject(new Error(`upgrade failed: ${e.message}`)));
      setTimeout(() => reject(new Error("upgrade timeout")), 3000).unref?.();
    });
    ws.close();
    await gw.stop();
  });

  it("上游握手失败（404）：原样 status + 正文回写升级前 socket", async () => {
    const route = new FakeRoute();
    const gw = await bootGateway(route, svc("svc-a", "a", await freePort()));
    route.onForward = (_i, handle) => {
      handle.handlers.onMeta({ id: "w", status: 404, contentType: "application/json" });
      handle.handlers.onChunk(ENC.encode('{"error":"no ws here"}'));
      handle.handlers.onEnd();
      handle.handlers.onTerminate({ source: "peer", frameType: 8 });
    };
    // 裸 socket 发升级请求，读回原始 HTTP 响应
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = tcpConnect({ host: "127.0.0.1", port: gw.port });
      sock.once("connect", () => {
        sock.write(`GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: k\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      let data = "";
      sock.once("error", reject);
      sock.on("data", (d) => {
        data += d.toString();
        if (data.includes('{"error":"no ws here"}')) resolve(data);
      });
      setTimeout(() => reject(new Error(`timeout: ${data}`)), 3000).unref?.();
    });
    expect(raw).toContain("HTTP/1.1 404");
    expect(raw).toContain('{"error":"no ws here"}');
    await gw.stop();
  });
});

// ---------------------------------------------------------------------------
// 目录同步与端口行为
// ---------------------------------------------------------------------------

describe("目录同步与端口", () => {
  it("服务删除：关端口 + 终结在途（fetch 拒绝 / ABORT）", async () => {
    const route = new FakeRoute();
    const service = svc("svc-a", "a", await freePort());
    const gw = await bootGateway(route, service);
    const port = gw.port;
    // 在途请求（挂起不回）
    const pending = fetch(`http://127.0.0.1:${port}/slow`);
    void pending.catch(() => undefined);
    await delay(30);
    expect(route.handles).toHaveLength(1);
    // refresh 移除该服务
    await gw.gateway.syncProviderServices("p1", route.alias, [svc("svc-b", "b", await freePort())], {});
    await delay(50);
    expect(route.handles[0]!.aborted.length).toBe(1);
    // 端口已关：连接拒绝
    const probe = await new Promise<string>((resolve) => {
      const s = tcpConnect({ host: "127.0.0.1", port });
      s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
      s.once("connect", () => {
        s.destroy();
        resolve("connected");
      });
    });
    expect(probe).toBe("ECONNREFUSED");
    await gw.stop();
  });

  it("setServiceEnabled 热启停：stop 关端口（幂等）、start 按端口偏好恢复", async () => {
    const route = new FakeRoute();
    const port = await freePort();
    const service = svc("svc-a", "a", port);
    const gw = await bootGateway(route, service, {}, { "svc-a": port });
    expect(gw.gateway.listenerInfo()).toHaveLength(1);

    // stop：监听关闭，连接拒绝
    await gw.gateway.setServiceEnabled("p1", route.alias, service, { "svc-a": port }, false);
    expect(gw.gateway.listenerInfo()).toHaveLength(0);
    const probe = await new Promise<string>((resolve) => {
      const s = tcpConnect({ host: "127.0.0.1", port });
      s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
      s.once("connect", () => {
        s.destroy();
        resolve("connected");
      });
    });
    expect(probe).toBe("ECONNREFUSED");

    // 重复 stop 幂等
    await gw.gateway.setServiceEnabled("p1", route.alias, service, { "svc-a": port }, false);
    expect(gw.gateway.listenerInfo()).toHaveLength(0);

    // start：按端口偏好恢复同端口；重复 start 幂等不重建
    await gw.gateway.setServiceEnabled("p1", route.alias, service, { "svc-a": port }, true);
    const info = gw.gateway.listenerInfo();
    expect(info).toHaveLength(1);
    expect(info[0]!.port).toBe(port);
    await gw.gateway.setServiceEnabled("p1", route.alias, service, { "svc-a": port }, true);
    expect(gw.gateway.listenerInfo()).toHaveLength(1);
    await gw.stop();
  });

  it("端口被占自动错开：NOTICE 显著标注实际端口", async () => {
    const occupied = await new Promise<{ server: Server; port: number }>((resolve) => {
      const server = httpServer();
      server.listen({ host: "127.0.0.1", port: 0 }, () => {
        resolve({ server, port: (server.address() as { port: number }).port });
      });
    });
    try {
      const route = new FakeRoute();
      const notices: string[] = [];
      const gateway = new Gateway({ resolveRoute: () => route, onNotice: (l) => notices.push(l) });
      running.push(() => gateway.stop());
      await gateway.syncProviderServices("p1", route.alias, [svc("svc-a", "ollama", occupied.port)], {});
      const info = gateway.listenerInfo()[0]!;
      expect(info.port).not.toBe(occupied.port);
      expect(info.autoAssigned).toBe(true);
      expect(notices.join("\n")).toContain("NOTICE");
      expect(notices.join("\n")).toContain(String(occupied.port));
      expect(notices.join("\n")).toContain(String(info.port));
    } finally {
      await new Promise<void>((r) => occupied.server.close(() => r()));
    }
  });

  it("strict-ports：冲突即报错", async () => {
    const occupied = await new Promise<{ server: Server; port: number }>((resolve) => {
      const server = httpServer();
      server.listen({ host: "127.0.0.1", port: 0 }, () => {
        resolve({ server, port: (server.address() as { port: number }).port });
      });
    });
    try {
      const route = new FakeRoute();
      const gateway = new Gateway({ resolveRoute: () => route, strictPorts: true });
      running.push(() => gateway.stop());
      await expect(
        gateway.syncProviderServices("p1", route.alias, [svc("svc-a", "a", occupied.port)], {}),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((r) => occupied.server.close(() => r()));
    }
  });

  it("pinned 端口生效（ports 记录优先于 defaultPort）", async () => {
    const port = await freePort();
    const route = new FakeRoute();
    const gateway = new Gateway({ resolveRoute: () => route });
    running.push(() => gateway.stop());
    await gateway.syncProviderServices("p1", route.alias, [svc("svc-a", "a", 1)], { "svc-a": port });
    expect(gateway.listenerInfo()[0]!.port).toBe(port);
  });

  it("仅绑定 127.0.0.1：非回环接口连接被拒（spec「不监听外网」）", async () => {
    const { networkInterfaces } = await import("node:os");
    const nonLoopback = Object.values(networkInterfaces())
      .flat()
      .find((n) => n !== undefined && n.family === "IPv4" && n.address !== "127.0.0.1");
    if (nonLoopback === undefined) return;
    const route = new FakeRoute();
    const port = await freePort();
    const gateway = new Gateway({ resolveRoute: () => route });
    running.push(() => gateway.stop());
    await gateway.syncProviderServices("p1", route.alias, [svc("svc-a", "a", port)], {});
    expect(gateway.listenerInfo()[0]!.port).toBe(port);
    const probe = await new Promise<string>((resolve) => {
      const s = tcpConnect({ host: nonLoopback.address, port });
      s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
      s.once("connect", () => {
        s.destroy();
        resolve("connected");
      });
      setTimeout(() => resolve("timeout"), 2000).unref?.();
    });
    expect(probe).toBe("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// 头过滤纯函数（WS 握手头集合断言）
// ---------------------------------------------------------------------------

describe("filterRequestHeaders", () => {
  it("普通请求：剥凭据/归属/逐跳，保留业务头", () => {
    const f = filterRequestHeaders(
      {
        authorization: "Bearer x",
        "proxy-authorization": "Basic y",
        cookie: "a=1",
        host: "127.0.0.1:1",
        "content-type": "application/json",
        "content-length": "3",
        "transfer-encoding": "chunked",
        connection: "keep-alive",
        upgrade: "h2c",
        "x-api-key": "k",
        accept: "text/event-stream",
      },
      false,
    );
    expect(f.headers).toEqual({ "x-api-key": "k", accept: "text/event-stream" });
    expect(f.contentType).toBe("application/json");
  });

  it("升级请求：connection/upgrade/sec-websocket-* 透传", () => {
    const f = filterRequestHeaders(
      {
        host: "127.0.0.1:1",
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "k",
        "sec-websocket-version": "13",
        "sec-websocket-protocol": "chat",
        "sec-websocket-extensions": "permessage-deflate",
        "user-agent": "ws-test",
        cookie: "leak=1",
      },
      true,
    );
    expect(f.headers).toMatchObject({
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": "k",
      "sec-websocket-version": "13",
      "sec-websocket-protocol": "chat",
      "sec-websocket-extensions": "permessage-deflate",
      "user-agent": "ws-test",
    });
    expect(f.headers).not.toHaveProperty("cookie");
    expect(f.headers).not.toHaveProperty("host");
  });
});
