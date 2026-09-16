// consumer/providers 单测（FakeSessionHandle + 可编程 fetchHttp 对端）：连接→
// AUTH（/_aifly/auth POST）→AUTH_OK 状态机与目录落盘、403→key_all_invalid（不
// 重建会话）、空钥环保持 connected-unauthed、relay 路径投影、catalog-watch
// refresh 目录全量替换、forward fetchHttp 投影（头构造/meta/chunk/end 白名单）、
// WS keepOpen 隧道（sendTunnel 上行 + 下行 onWsData + 关闭码）、recovering 不
// 提前 503、dead → offline 快速失败 + 会话重建重 AUTH、openSession 失败退避
// 重试、refreshRing 重授权；full jitter 退避纯函数边界。
// opendweb-kernel-migration：状态机由 SessionHandle.onState 驱动（假体手动
// emitPhase）；对端为脚本化 fetchHttp 处理器（AUTH/watch/forward 三端点）。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ErrorHeader } from "../../../src/wire/frames.ts";
import type { ServiceEntry } from "../../../src/wire/frames.ts";
import { randomZ32 } from "../../../src/wire/z32.ts";
import {
  OfflineError,
  ProviderConnection,
  ProviderManager,
  fullJitterDelayMs,
  type FabricLike,
  type FetchHttpInitLike,
  type FetchHttpResponseLike,
  type ForwardHandlers,
  type ProviderSessionFactory,
  type SessionHandleLike,
  type SessionStateLike,
} from "../../../src/consumer/providers.ts";
import { loadKeyring, saveKeyring, type Keyring } from "../../../src/consumer/store.ts";

// ---------------------------------------------------------------------------
// 测试基建：FakeSessionHandle + 可编程 fetchHttp 对端
// ---------------------------------------------------------------------------

/** fetchHttp 调用记录。 */
interface FetchCall {
  init: FetchHttpInitLike;
  /** 测试以 respond() 结算该调用。 */
  respond(resp: FakeResponse): void;
  /** 受控应答（bodyNext/sendTunnel 语义由测试驱动）。 */
  respondRaw(resp: FetchHttpResponseLike): void;
  fail(err: Error): void;
}

interface FakeResponse {
  status: number;
  headers?: Array<{ name: string; value: string }>;
  bodyChunks?: Uint8Array[];
}

function respOf(resp: FakeResponse): FetchHttpResponseLike {
  const chunks = (resp.bodyChunks ?? []).map((c) => Buffer.from(c));
  let i = 0;
  const tunnel: Buffer[] = [];
  return {
    status: resp.status,
    headers: resp.headers ?? [],
    streamId: 1,
    bodyNext: async () => (i < chunks.length ? chunks[i++]! : null),
    sendTunnel: async (data: Buffer) => {
      tunnel.push(data);
    },
  };
}

/** 受控 WS 隧道响应：deliver 推下行块；finish 结束（bodyNext → null）。 */
function liveTunnelResponse(
  status: number,
  headers: Array<{ name: string; value: string }>,
): { resp: FetchHttpResponseLike; deliver(chunks: Uint8Array[]): void; finish(): void; tunnel: Buffer[] } {
  const pending: Buffer[] = [];
  const tunnel: Buffer[] = [];
  let done = false;
  let wake: (() => void) | null = null;
  const waitNext = (): Promise<void> =>
    new Promise<void>((resolve) => {
      wake = resolve;
    });
  const resp: FetchHttpResponseLike = {
    status,
    headers,
    streamId: 1,
    bodyNext: async () => {
      for (;;) {
        if (pending.length > 0) return pending.shift()!;
        if (done) return null;
        await waitNext();
        wake = null;
      }
    },
    sendTunnel: async (data: Buffer) => {
      tunnel.push(data);
    },
  };
  return {
    resp,
    tunnel,
    deliver(chunks: Uint8Array[]): void {
      for (const c of chunks) pending.push(Buffer.from(c));
      wake?.();
    },
    finish(): void {
      done = true;
      wake?.();
    },
  };
}

class FakeSessionHandle implements SessionHandleLike {
  readonly peerId: string;
  sessionId: string;
  phase: string = "active";
  private cb: ((s: SessionStateLike) => void) | undefined;
  /** 测试脚本：按 path 分派（缺省 404）。 */
  script: (call: FetchCall) => void = () => undefined;
  readonly calls: FetchCall[] = [];
  closed = false;

  constructor(peerId: string, sessionId: string) {
    this.peerId = peerId;
    this.sessionId = sessionId;
  }

  async state(): Promise<SessionStateLike> {
    return { peerId: this.peerId, sessionId: this.sessionId, phase: this.phase };
  }

  onState(callback: (s: SessionStateLike) => void): () => void {
    this.cb = callback;
    return () => {
      if (this.cb === callback) this.cb = undefined;
    };
  }

  emitPhase(phase: string): void {
    this.phase = phase;
    this.cb?.({ peerId: this.peerId, sessionId: this.sessionId, phase });
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  fetchHttp(init: FetchHttpInitLike): Promise<FetchHttpResponseLike> {
    return new Promise<FetchHttpResponseLike>((resolve, reject) => {
      const call: FetchCall = {
        init,
        respond: (resp) => resolve(respOf(resp)),
        respondRaw: (resp) => resolve(resp),
        fail: (err) => reject(err),
      };
      this.calls.push(call);
      this.script(call);
    });
  }
}

interface FakeFactoryHost {
  factory: ProviderSessionFactory;
  /** 待决 openSession（测试手动 resolve/reject 驱动时序）。 */
  pending: Array<{ resolve: (s: FakeSessionHandle) => void; reject: (err: Error) => void }>;
  sessions: FakeSessionHandle[];
  openCalls: number;
  shutdowns: number;
  autoConnect: boolean;
  path: "direct" | "relay" | "unknown";
  fabric: FabricLike;
}

function fakeFactoryHost(peerOf: () => FakeSessionHandle): FakeFactoryHost {
  const host = {
    pending: [] as Array<{ resolve: (s: FakeSessionHandle) => void; reject: (err: Error) => void }>,
    sessions: [] as FakeSessionHandle[],
    openCalls: 0,
    shutdowns: 0,
    autoConnect: false,
    path: "direct" as "direct" | "relay" | "unknown",
    fabric: undefined as unknown as FabricLike,
    factory: undefined as unknown as ProviderSessionFactory,
  };
  host.fabric = {
    endpointId: "self",
    connect: async () => undefined,
    disconnect: async () => undefined,
    on: () => () => undefined,
    members: async () => [],
    relayStatus: async () => ({ urls: [] }),
    shutdown: async () => undefined,
    openSession: async (_peerId: string) => {
      host.openCalls++;
      return new Promise<FakeSessionHandle>((resolve, reject) => {
        if (host.autoConnect) {
          const s = peerOf();
          host.sessions.push(s);
          resolve(s);
          return;
        }
        host.pending.push({ resolve, reject });
      });
    },
    continuitySnapshot: async () => ({ path: host.path }),
  };
  host.factory = {
    open: async () => host.fabric,
    shutdown: async () => {
      host.shutdowns++;
    },
  };
  return host;
}

/** 测试驱动的连接应答。 */
function connectOk(host: FakeFactoryHost, session?: FakeSessionHandle): FakeSessionHandle {
  const s = session ?? host.sessions[0] ?? new FakeSessionHandle("peer", `sid-${host.openCalls}`);
  if (!host.sessions.includes(s)) host.sessions.push(s);
  for (const p of host.pending.splice(0)) p.resolve(s);
  return s;
}

function connectFail(host: FakeFactoryHost, err: Error): void {
  for (const p of host.pending.splice(0)) p.reject(err);
}

async function settle(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function svc(serviceId: string, name: string, port: number): ServiceEntry {
  return { serviceId, name, match: [], defaultPort: port };
}

function epId(): string {
  return randomZ32(32);
}

function ringOf(ep: string, keys: Array<{ keyId: string; key: string; group: string }> = []): Keyring {
  return { alias: "prov", endpointId: ep, relayUrls: [], keys, services: [], ports: {}, actualPorts: {}, disabledServices: [], disabled: false };
}

const HANDLERS = (): ForwardHandlers & { events: string[] } => {
  const events: string[] = [];
  return {
    events,
    onMeta: () => events.push("meta"),
    onChunk: () => events.push("chunk"),
    onEnd: () => events.push("end"),
    onError: (h: ErrorHeader) => events.push(`error:${h.code}`),
    onWsData: () => events.push("wsdata"),
    onWsClose: () => events.push("wsclose"),
    onTerminate: (cause) => events.push(`terminate:${cause.source}`),
  };
}

let root: string;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aifly-consumer-providers-"));
});

afterEach(async () => {
  for (const off of cleanups.splice(0)) await off();
  rmSync(root, { recursive: true, force: true });
});

function makeConnection(ring: Keyring, host: FakeFactoryHost): ProviderConnection {
  const conn = new ProviderConnection({
    ring,
    root,
    factory: host.factory,
    backoff: { baseMs: 5, capMs: 25 },
  });
  cleanups.push(() => conn.stop());
  return conn;
}

/** AUTH_OK 载荷构造（对端脚本用）。 */
function authOkBody(groups: Array<{ keyId: string; group: string; services: ServiceEntry[] }>, opts: { alias?: string; relayUrls?: string[]; refresh?: boolean } = {}): Uint8Array {
  const header = {
    v: 1,
    alias: opts.alias ?? "prov",
    relayUrls: opts.relayUrls ?? ["http://relay:1"],
    groups: groups.map((g) => ({ keyId: g.keyId, group: g.group, limits: {}, services: g.services })),
    ...(opts.refresh === true ? { refresh: true } : {}),
  };
  return new TextEncoder().encode(JSON.stringify(header));
}

/** 对端脚本：AUTH（记录 keys）/watch/forward 三端点。 */
interface ProviderScript {
  keysSeen: string[] | undefined;
  authStatus: number;
  watchCalls: FetchCall[];
  forwardCalls: Array<FetchHttpInitLike>;
  forwardRespond: (call: FetchCall) => void;
}

function scriptProvider(session: FakeSessionHandle, script: Partial<ProviderScript> = {}): ProviderScript {
  const s: ProviderScript = {
    keysSeen: undefined,
    authStatus: 200,
    watchCalls: [],
    forwardCalls: [],
    forwardRespond: script.forwardRespond ?? ((call) => call.respond({ status: 200, headers: [{ name: "content-type", value: "text/plain" }], bodyChunks: [new TextEncoder().encode("ok")] })),
    ...script,
  };
  session.script = (call) => {
    const path = call.init.path.split("?", 1)[0]!;
    if (path === "/_aifly/auth") {
      const body = call.init.body ? Buffer.concat(call.init.body.map((b) => Buffer.from(b))) : Buffer.alloc(0);
      s.keysSeen = (JSON.parse(body.toString("utf8")) as { keys: string[] }).keys;
      if (s.authStatus === 200) {
        call.respond({
          status: 200,
          headers: [
            { name: "content-type", value: "application/json" },
            { name: "x-aifly-catalog-seq", value: "0" },
          ],
          bodyChunks: [authOkBody([{ keyId: "k", group: "g", services: [svc("svc-a", "ollama", 11434)] }])],
        });
      } else {
        call.respond({ status: 403, bodyChunks: [new TextEncoder().encode(JSON.stringify({ v: 1, code: "key_all_invalid" }))] });
      }
      return;
    }
    if (path === "/_aifly/catalog-watch") {
      // 挂起（测试手动结算）：watch 调用由测试经 watchCalls 驱动
      s.watchCalls.push(call);
      return;
    }
    s.forwardCalls.push(call.init);
    s.forwardRespond(call);
  };
  return s;
}

// ---------------------------------------------------------------------------
// 状态机与 AUTH
// ---------------------------------------------------------------------------

describe("连接状态机", () => {
  it("连接 → AUTH（/_aifly/auth POST 钥环全量呈交）→ AUTH_OK → direct + 目录落盘", async () => {
    const ep = epId();
    const ring = ringOf(ep, [
      { keyId: "kid1", key: "sk-aifly-key-one-11111111", group: "g1" },
      { keyId: "kid2", key: "sk-aifly-key-two-22222222", group: "g2" },
    ]);
    saveKeyring(root, ring);
    const host = fakeFactoryHost(() => new FakeSessionHandle(ep, "sid-1"));
    const script: { keysSeen?: string[] } = {};
    const conn = makeConnection(ring, host);
    conn.start();
    expect(conn.state).toBe("not-connected");
    await settle();
    const session = connectOk(host);
    session.script = (call) => {
      if (call.init.path === "/_aifly/auth") {
        const body = call.init.body ? Buffer.concat(call.init.body.map((b) => Buffer.from(b))) : Buffer.alloc(0);
        script.keysSeen = (JSON.parse(body.toString("utf8")) as { keys: string[] }).keys;
        call.respond({
          status: 200,
          headers: [
            { name: "content-type", value: "application/json" },
            { name: "x-aifly-catalog-seq", value: "0" },
          ],
          bodyChunks: [authOkBody([{ keyId: "kid1", group: "g1", services: [svc("svc-a", "ollama", 11434)] }])],
        });
        return;
      }
      // catalog-watch 等端点：挂起（避免假体同步应答驱动 watch 热循环）
    };
    await settle(30);
    expect(script.keysSeen?.sort()).toEqual([...ring.keys.map((k) => k.key)].sort());
    expect(conn.state).toBe("direct"); // continuitySnapshot path=direct
    // 目录已落盘
    const persisted = loadKeyring(root, ep);
    expect(persisted?.services.map((s) => s.serviceId)).toEqual(["svc-a"]);
    expect(persisted?.relayUrls).toEqual(["http://relay:1"]);
    expect(persisted?.alias).toBe("prov");
    await conn.stop();
  });

  it("continuitySnapshot path=relay → relay 状态", async () => {
    const ep = epId();
    const ring = ringOf(ep, [{ keyId: "k", key: "sk-aifly-relay-key-000001", group: "g" }]);
    const host = fakeFactoryHost(() => new FakeSessionHandle(ep, "sid-r"));
    host.path = "relay";
    const conn = makeConnection(ring, host);
    conn.start();
    await settle();
    const session = connectOk(host);
    scriptProvider(session);
    await settle(30);
    expect(conn.state).toBe("relay");
    await conn.stop();
  });

  it("AUTH 403 → key_all_invalid，不重建会话（无新 openSession）", async () => {
    const ep = epId();
    const ring = ringOf(ep, [{ keyId: "k", key: "sk-aifly-rejected-0000001", group: "g" }]);
    const host = fakeFactoryHost(() => new FakeSessionHandle(ep, "sid-e"));
    const conn = makeConnection(ring, host);
    conn.start();
    await settle();
    const session = connectOk(host);
    const script = scriptProvider(session);
    await settle(30);
    expect(conn.state).toBe("direct");
    // 置 403 后经 refreshRing（钥变化）重呈 → key_all_invalid
    script.authStatus = 403;
    conn.refreshRing({ ...ring, keys: [{ keyId: "k2", key: "sk-aifly-still-bad-00001", group: "g" }] });
    await settle(30);
    expect(conn.state).toBe("key-all-invalid");
    expect(host.openCalls).toBe(1); // 会话不重建
    // 快速失败：key_all_invalid 含别名
    expect(() => conn.forward({ serviceId: "s", method: "GET", path: "/", body: new Uint8Array(0), upgrade: false }, HANDLERS())).toThrowError(OfflineError);
    try {
      conn.forward({ serviceId: "s", method: "GET", path: "/", body: new Uint8Array(0), upgrade: false }, HANDLERS());
    } catch (err) {
      expect((err as OfflineError).code).toBe("key_all_invalid");
      expect((err as OfflineError).alias).toBe("prov");
    }
    await conn.stop();
  });

  it("空钥环：保持 connected-unauthed，不发起 AUTH", async () => {
    const ep = epId();
    const host = fakeFactoryHost(() => new FakeSessionHandle(ep, "sid-u"));
    const conn = makeConnection(ringOf(ep), host);
    conn.start();
    await settle();
    const session = connectOk(host);
    let authCalls = 0;
    session.script = (call) => {
      if (call.init.path === "/_aifly/auth") authCalls++;
    };
    await settle(20);
    expect(conn.state).toBe("connected-unauthed");
    expect(authCalls).toBe(0);
    await conn.stop();
  });

  it("未连接/离线：forward 快速失败 provider_offline", async () => {
    const conn = makeConnection(ringOf(epId()), fakeFactoryHost(() => new FakeSessionHandle("p", "s")));
    expect(() =>
      conn.forward({ serviceId: "s", method: "GET", path: "/", body: new Uint8Array(0), upgrade: false }, HANDLERS()),
    ).toThrowError(/offline/);
    const host = fakeFactoryHost(() => new FakeSessionHandle("p", "s"));
    const conn2 = makeConnection(ringOf(epId(), [{ keyId: "k", key: "sk-aifly-x-key-000000001", group: "g" }]), host);
    conn2.start();
    await settle();
    connectFail(host, new Error("dial failed"));
    await settle();
    expect(conn2.state).toBe("offline");
    expect(() =>
      conn2.forward({ serviceId: "s", method: "GET", path: "/", body: new Uint8Array(0), upgrade: false }, HANDLERS()),
    ).toThrowError(OfflineError);
  });

  it("openSession 失败 → 退避重试 → 成功后 AUTH", async () => {
    const ep = epId();
    const ring = ringOf(ep, [{ keyId: "k", key: "sk-aifly-retry-key-000001", group: "g" }]);
    const host = fakeFactoryHost(() => new FakeSessionHandle(ep, "sid-x"));
    const conn = makeConnection(ring, host);
    conn.start();
    await settle();
    connectFail(host, new Error("peer away"));
    await settle(5);
    expect(conn.state).toBe("offline");
    expect(host.openCalls).toBeGreaterThanOrEqual(1);
    // 退避窗口（baseMs=5/cap=25）后重试（openSession 挂起等待应答）
    await settle(60);
    const session = connectOk(host);
    scriptProvider(session);
    await settle(30);
    expect(host.openCalls).toBeGreaterThanOrEqual(2);
    expect(conn.state).toBe("direct");
    await conn.stop();
  });
});

// ---------------------------------------------------------------------------
// forward 投影（fetchHttp）
// ---------------------------------------------------------------------------

describe("forward 投影", () => {
  async function authedConn(): Promise<{ conn: ProviderConnection; session: FakeSessionHandle; script: ProviderScript; ep: string }> {
    const ep = epId();
    const ring = ringOf(ep, [{ keyId: "k", key: "sk-aifly-forward-key-0001", group: "g" }]);
    const host = fakeFactoryHost(() => new FakeSessionHandle(ep, "sid-f"));
    const conn = makeConnection(ring, host);
    conn.start();
    await settle();
    const session = connectOk(host);
    const script = scriptProvider(session);
    await settle(30);
    expect(conn.state).toBe("direct");
    return { conn, session, script, ep };
  }

  it("HTTP：fetchHttp 入参（方法/路径/头集/content-type/service 路由头）与 meta/chunk/end 投影", async () => {
    const { conn, script } = await authedConn();
    const events = HANDLERS();
    const metaHeader = { status: 200, contentType: "application/json" };
    script.forwardRespond = (call) =>
      call.respond({
        status: 200,
        headers: [
          { name: "content-type", value: "application/json" },
          { name: "x-request-id", value: "req-9" },
          { name: "x-dropped", value: "no" },
        ],
        bodyChunks: [new TextEncoder().encode('{"a":1}')],
      });
    const body = new TextEncoder().encode('{"q":1}');
    const handle = conn.forward(
      {
        serviceId: "svc-a",
        method: "POST",
        path: "/v1/chat/completions?stream=1",
        headers: { "x-custom": "v", "anthropic-version": "2023-06-01" },
        contentType: "application/json",
        body,
        upgrade: false,
      },
      { ...events, onMeta: (h) => { events.events.push("meta"); metaHeader.status = h.status; metaHeader.contentType = h.contentType; (metaHeader as { headers?: Record<string, string> | undefined }).headers = h.headers; } },
    );
    await settle(20);
    expect(script.forwardCalls).toHaveLength(1);
    const init = script.forwardCalls[0]!;
    expect(init.method).toBe("POST");
    expect(init.path).toBe("/v1/chat/completions?stream=1");
    const headerMap = Object.fromEntries((init.headers ?? []).map((h) => [h.name, h.value]));
    expect(headerMap["x-aifly-service"]).toBe("svc-a");
    expect(headerMap["content-type"]).toBe("application/json");
    expect(headerMap["x-custom"]).toBe("v");
    expect(headerMap["anthropic-version"]).toBe("2023-06-01");
    expect(Buffer.concat((init.body ?? []).map((b) => Buffer.from(b))).toString()).toBe('{"q":1}');
    // 投影：meta（白名单三头）+ chunk + end + terminate(peer)
    expect(metaHeader.status).toBe(200);
    expect(metaHeader.contentType).toBe("application/json");
    expect((metaHeader as { headers?: Record<string, string> }).headers).toEqual({ "x-request-id": "req-9" });
    expect(events.events).toEqual(["meta", "chunk", "end", "terminate:peer"]);
    void handle;
  });

  it("WS：keepOpen + 101 → onWsData/onWsClose（关闭码头透传）+ sendData 走 sendTunnel", async () => {
    const { conn, script } = await authedConn();
    const events = HANDLERS();
    const live = liveTunnelResponse(101, [
      { name: "sec-websocket-accept", value: "accept-value" },
      { name: "x-aifly-ws-close", value: "1000" },
    ]);
    script.forwardRespond = (call) => call.respondRaw(live.resp);
    const handle = conn.forward(
      {
        serviceId: "svc-a",
        method: "GET",
        path: "/ws",
        headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "k==" },
        upgrade: true,
        body: new Uint8Array(0),
      },
      events,
    );
    await settle(10);
    expect((script.forwardCalls[0] as { keepOpen?: boolean } | undefined)?.keepOpen).toBe(true);
    // 上行 → sendTunnel
    await handle.sendData(new TextEncoder().encode("up-1"));
    await handle.sendData(new TextEncoder().encode("up-2"));
    await settle(5);
    expect(live.tunnel.map((b) => b.toString())).toEqual(["up-1", "up-2"]);
    // 下行投递 → onWsData；finish → onWsClose（关闭码经响应头透传）+ terminate(peer)
    live.deliver([new TextEncoder().encode("down-1"), new TextEncoder().encode("down-2")]);
    await settle(10);
    expect(events.events.filter((e) => e === "meta")).toHaveLength(1); // 101 meta 一次
    expect(events.events.filter((e) => e === "wsdata")).toHaveLength(2);
    live.finish();
    await settle(10);
    expect(events.events).toContain("wsclose");
    expect(events.events).toContain("terminate:peer");
  });

  it("会话终态在途：onError(session_lost)（504 语义）", async () => {
    const { conn, script } = await authedConn();
    const events = HANDLERS();
    script.forwardRespond = (call) => call.fail(new Error("[session] stream ended"));
    conn.forward({ serviceId: "svc-a", method: "GET", path: "/x", body: new Uint8Array(0), upgrade: false }, events);
    await settle(10);
    expect(events.events).toContain("error:session_lost");
    expect(events.events).toContain("terminate:disconnected");
  });
});

// ---------------------------------------------------------------------------
// recovering / dead 会话语义
// ---------------------------------------------------------------------------

describe("会话状态语义", () => {
  it("recovering：状态 offline 但 forward 不快速失败（挂起）", async () => {
    const ep = epId();
    const ring = ringOf(ep, [{ keyId: "k", key: "sk-aifly-rec-key-00000001", group: "g" }]);
    const host = fakeFactoryHost(() => new FakeSessionHandle(ep, "sid-rec"));
    const conn = makeConnection(ring, host);
    conn.start();
    await settle();
    const session = connectOk(host);
    scriptProvider(session);
    await settle(30);
    expect(conn.state).toBe("direct");
    session.emitPhase("recovering");
    expect(conn.state).toBe("offline");
    // 不提前 503：forward 正常入队（fetchHttp 挂起）
    const events = HANDLERS();
    let resolved = false;
    session.script = (call) => {
      if (call.init.path === "/v1/x") void call; // 挂起不结算
    };
    const handle = conn.forward({ serviceId: "svc-a", method: "GET", path: "/v1/x", body: new Uint8Array(0), upgrade: false }, events);
    void handle;
    await settle(10);
    resolved = events.events.length === 0;
    expect(resolved).toBe(true); // 无错误直达
    await conn.stop();
  });

  it("dead：状态 offline + forward 快速失败 provider_offline + 会话重建重 AUTH", async () => {
    const ep = epId();
    const ring = ringOf(ep, [{ keyId: "k", key: "sk-aifly-dead-key-00000001", group: "g" }]);
    const host = fakeFactoryHost(() => new FakeSessionHandle(ep, "sid-d"));
    const conn = makeConnection(ring, host);
    conn.start();
    await settle();
    const session = connectOk(host);
    const script = scriptProvider(session);
    await settle(30);
    expect(conn.state).toBe("direct");
    expect(script.keysSeen).toBeDefined();
    session.emitPhase("dead");
    await settle(5);
    expect(conn.state).toBe("offline");
    expect(() => conn.forward({ serviceId: "s", method: "GET", path: "/", body: new Uint8Array(0), upgrade: false }, HANDLERS())).toThrowError(OfflineError);
    // 重建：ensureSession 再次 openSession（autoConnect 关闭 → 手动应答第二个会话）
    await settle(10);
    expect(host.openCalls).toBeGreaterThanOrEqual(2);
    const session2 = new FakeSessionHandle(ep, "sid-d2");
    const script2 = scriptProvider(session2);
    connectOk(host, session2);
    await settle(30);
    expect(conn.state).toBe("direct"); // 新会话重 AUTH 后恢复
    expect(script2.keysSeen).toBeDefined();
    await conn.stop();
  });

  it("catalog-watch refresh：目录全量替换（服务增删）", async () => {
    const ep = epId();
    const ring = ringOf(ep, [{ keyId: "k", key: "sk-aifly-watch-key-000001", group: "g" }]);
    const host = fakeFactoryHost(() => new FakeSessionHandle(ep, "sid-w"));
    const conn = makeConnection(ring, host);
    conn.start();
    await settle();
    const session = connectOk(host);
    const script = scriptProvider(session);
    await settle(30);
    // 等待 watch 调用出现
    await settle(20);
    expect(script.watchCalls.length).toBeGreaterThanOrEqual(1);
    script.watchCalls[0]!.respond({
      status: 200,
      headers: [
        { name: "content-type", value: "application/json" },
        { name: "x-aifly-catalog-seq", value: "5" },
      ],
      bodyChunks: [authOkBody([{ keyId: "k", group: "g", services: [svc("svc-a", "ollama", 11434), svc("svc-b", "extra", 8081)] }], { refresh: true })],
    });
    await settle(20);
    const persisted = loadKeyring(root, ep);
    expect(persisted?.services.map((s) => s.serviceId).sort()).toEqual(["svc-a", "svc-b"]);
    await conn.stop();
  });

  it("refreshRing：钥变化在线重呈 AUTH（重授权）", async () => {
    const ep = epId();
    const ring = ringOf(ep, [{ keyId: "k1", key: "sk-aifly-ring-key-00000001", group: "g" }]);
    const host = fakeFactoryHost(() => new FakeSessionHandle(ep, "sid-rr"));
    const conn = makeConnection(ring, host);
    conn.start();
    await settle();
    const session = connectOk(host);
    const script = scriptProvider(session);
    await settle(30);
    expect(script.keysSeen).toEqual([ring.keys[0]!.key]);
    const newKey = "sk-aifly-ring-key-00000002";
    conn.refreshRing({ ...ring, keys: [{ keyId: "k2", key: newKey, group: "g" }] });
    await settle(30);
    expect(script.keysSeen).toEqual([newKey]);
    await conn.stop();
  });
});

// ---------------------------------------------------------------------------
// full jitter 纯函数（边界）
// ---------------------------------------------------------------------------

describe("fullJitterDelayMs", () => {
  it("attempt 0：窗口 [0, base]；封顶后窗口 [0, cap]", () => {
    expect(fullJitterDelayMs(0, { baseMs: 100, capMs: 60_000, random: () => 0 })).toBe(0);
    expect(fullJitterDelayMs(0, { baseMs: 100, capMs: 60_000, random: () => 0.999 })).toBe(99);
    expect(fullJitterDelayMs(30, { baseMs: 1_000, capMs: 2_000, random: () => 0.5 })).toBe(1_000);
    expect(fullJitterDelayMs(-5, { baseMs: 100, capMs: 200, random: () => 0.5 })).toBe(50); // 负 attempt 按 0
  });
});

// ---------------------------------------------------------------------------
// ProviderManager 装配
// ---------------------------------------------------------------------------

describe("ProviderManager", () => {
  it("多提供者并存：P1 离线不影响 P2 路由", async () => {
    const ep1 = epId();
    const ep2 = epId();
    const host1 = fakeFactoryHost(() => new FakeSessionHandle(ep1, "m1"));
    const host2 = fakeFactoryHost(() => new FakeSessionHandle(ep2, "m2"));
    const rings = [
      ringOf(ep1, [{ keyId: "a", key: "sk-aifly-mgr-key-00000001", group: "g" }]),
      ringOf(ep2, [{ keyId: "b", key: "sk-aifly-mgr-key-00000002", group: "g" }]),
    ];
    const conns: ProviderConnection[] = [];
    const manager = new ProviderManager({
      rings,
      root,
      sessionFactory: (ring) => {
        const host = ring.endpointId === ep1 ? host1 : host2;
        return host.factory;
      },
    });
    cleanups.push(() => void manager.stop());
    manager.start();
    await settle();
    connectFail(host1, new Error("p1 away"));
    const s2 = connectOk(host2);
    scriptProvider(s2);
    await settle(30);
    expect(manager.routeFor(ep1)?.state).toBe("offline");
    expect(manager.routeFor(ep2)?.state).toBe("direct");
    expect(manager.snapshot()).toHaveLength(2);
    void conns;
  });
});
