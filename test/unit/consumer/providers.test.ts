// consumer/providers 单测（mock Fabric + 内存 loopback 传输，对侧用真实 WireSession
// provider 角色说话）：连接→AUTH→AUTH_OK 状态机、AUTH_ERR→key_all_invalid、refresh
// 目录全量替换（relay 变更/服务增删/落盘/密钥元数据回填）、REQ/REQ_BODY 帧构造、
// WS DATA_UP 保序、protocol_seq 毒化重建、断连退避重连、离线快速失败、linkStatus
// 轮询复核、key_all_invalid 环变化恢复；full jitter 退避纯函数边界。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FRAME_TYPE, type AuthHeader, type ErrorHeader, type ReqHeader, type ServiceEntry } from "../../../src/wire/frames.ts";
import { WireSession, type InboundFrame } from "../../../src/wire/mux.ts";
import { createLoopbackPair, type LoopbackTransport } from "../wire/loopback.ts";
import { randomZ32 } from "../../../src/wire/z32.ts";
import {
  OfflineError,
  ProviderConnection,
  ProviderManager,
  fullJitterDelayMs,
  type ForwardHandlers,
  type ProviderTransportSession,
  type ProviderTransportSessionFactory,
} from "../../../src/consumer/providers.ts";
import { loadKeyring, saveKeyring, setActualPorts, type Keyring } from "../../../src/consumer/store.ts";

// ---------------------------------------------------------------------------
// 测试基建：可控的会话工厂 + provider 侧真实 WireSession
// ---------------------------------------------------------------------------

interface FakeSession extends ProviderTransportSession {
  peerTransport: LoopbackTransport;
  linkResult: "direct" | "relay" | "unknown";
  tornDown: number;
}

function newFakeSession(): FakeSession {
  const { a, b } = createLoopbackPair();
  const s: FakeSession = {
    transport: a,
    peerTransport: b,
    linkResult: "direct",
    tornDown: 0,
    linkStatus: () => Promise.resolve(s.linkResult),
    teardown: async () => {
      s.tornDown++;
      a.close("fake-teardown");
    },
  };
  return s;
}

interface FakeFactoryHost {
  factory: ProviderTransportSessionFactory;
  /** 待决 openSession（测试手动 resolve/reject 驱动连接时序） */
  pending: Array<{ resolve: (s: FakeSession) => void; reject: (err: Error) => void }>;
  sessions: FakeSession[];
  openCalls: number;
  shutdowns: number;
  /** 下一次 openSession 自动成功的便捷开关 */
  autoConnect: boolean;
}

function fakeFactoryHost(): FakeFactoryHost {
  const host: FakeFactoryHost = {
    pending: [],
    sessions: [],
    openCalls: 0,
    shutdowns: 0,
    autoConnect: false,
    factory: {
      openSession: () => {
        host.openCalls++;
        return new Promise<FakeSession>((resolve, reject) => {
          if (host.autoConnect) {
            const s = newFakeSession();
            host.sessions.push(s);
            resolve(s);
            return;
          }
          host.pending.push({ resolve, reject });
        });
      },
      shutdown: async () => {
        host.shutdowns++;
      },
    },
  };
  return host;
}

/** 测试驱动的连接应答：把 pending 的 openSession 全部兑现。 */
function connectOk(host: FakeFactoryHost): FakeSession {
  const s = newFakeSession();
  host.sessions.push(s);
  for (const p of host.pending.splice(0)) p.resolve(s);
  return s;
}

function connectFail(host: FakeFactoryHost, err: Error): void {
  for (const p of host.pending.splice(0)) p.reject(err);
}

/** provider 侧真实 WireSession（协议级对端）。 */
class ProviderSide {
  session: WireSession;
  frames: InboundFrame[] = [];
  constructor(transport: LoopbackTransport) {
    this.session = new WireSession({
      role: "provider",
      transport,
      hooks: { onFrame: (f) => this.frames.push(f) },
    });
  }
  last<T extends InboundFrame>(type: number): T | undefined {
    const hit = [...this.frames].reverse().find((f) => f.type === type);
    return hit as T | undefined;
  }
  async authOk(groups: Array<{ keyId: string; group: string; services: ServiceEntry[] }>, opts: { relayUrls?: string[]; alias?: string; refresh?: boolean } = {}): Promise<void> {
    await this.session.send(FRAME_TYPE.AUTH_OK, {
      v: 1,
      alias: opts.alias ?? "prov",
      relayUrls: opts.relayUrls ?? ["http://relay:1"],
      groups: groups.map((g) => ({ keyId: g.keyId, group: g.group, limits: {}, services: g.services })),
      ...(opts.refresh === true ? { refresh: true } : {}),
    });
    this.session.markAuthed();
  }
  async authErr(): Promise<void> {
    await this.session.send(FRAME_TYPE.AUTH_ERR, { v: 1, code: "key_all_invalid" });
  }
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
};

let root: string;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aifly-consumer-providers-"));
});

afterEach(async () => {
  for (const off of cleanups.splice(0)) await off();
  rmSync(root, { recursive: true, force: true });
});

function makeConnection(ring: Keyring, host = fakeFactoryHost(), opts: { pollIntervalMs?: number } = {}): ProviderConnection {
  const conn = new ProviderConnection({
    ring,
    root,
    factory: host.factory,
    ...(opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {}),
    backoff: { baseMs: 5, capMs: 25 },
  });
  cleanups.push(() => conn.stop());
  return conn;
}

// ---------------------------------------------------------------------------
// 状态机与 AUTH
// ---------------------------------------------------------------------------

describe("连接状态机", () => {
  it("连接 → AUTH（钥环全量呈交）→ AUTH_OK → direct + 目录落盘", async () => {
    const ep = epId();
    const ring = ringOf(ep, [
      { keyId: "kid1", key: "sk-aifly-key-one-11111111", group: "g1" },
      { keyId: "kid2", key: "sk-aifly-key-two-22222222", group: "g2" },
    ]);
    saveKeyring(root, ring);
    const host = fakeFactoryHost();
    const conn = makeConnection(ring, host);
    conn.start();
    expect(conn.state).toBe("not-connected");
    const session = connectOk(host);
    const provider = new ProviderSide(session.peerTransport);
    await settle();
    // 连接后立即 AUTH，呈交全部密钥
    const auth = provider.last<Extract<InboundFrame, { type: typeof FRAME_TYPE.AUTH }>>(FRAME_TYPE.AUTH);
    expect(auth?.header.keys.sort()).toEqual([...ring.keys.map((k) => k.key)].sort());
    expect(conn.state).toBe("connected-unauthed");
    const services = [svc("svc-a", "ollama", 11434)];
    await provider.authOk([{ keyId: "kid1", group: "g1", services }]);
    await settle();
    expect(conn.state).toBe("direct"); // fake linkStatus = direct
    // 目录已落盘（含 detail 与端口记录基础）
    const persisted = loadKeyring(root, ep);
    expect(persisted?.services.map((s) => s.serviceId)).toEqual(["svc-a"]);
    expect(persisted?.relayUrls).toEqual(["http://relay:1"]);
    expect(persisted?.alias).toBe("prov");
    await conn.stop();
  });

  it("linkStatus=relay → relay 状态", async () => {
    const ep = epId();
    const ring = ringOf(ep, [{ keyId: "k", key: "sk-aifly-relay-key-000001", group: "g" }]);
    const host = fakeFactoryHost();
    const conn = makeConnection(ring, host);
    conn.start();
    const session = connectOk(host);
    session.linkResult = "relay";
    const provider = new ProviderSide(session.peerTransport);
    await settle();
    await provider.authOk([{ keyId: "k", group: "g", services: [] }]);
    await settle(30);
    expect(conn.state).toBe("relay");
    await conn.stop();
  });

  it("AUTH_ERR → key_all_invalid，不再自动重连（无新 openSession）", async () => {
    const ep = epId();
    const ring = ringOf(ep, [{ keyId: "k", key: "sk-aifly-rejected-0000001", group: "g" }]);
    const host = fakeFactoryHost();
    const conn = makeConnection(ring, host);
    conn.start();
    const session = connectOk(host);
    const provider = new ProviderSide(session.peerTransport);
    await settle();
    await provider.authErr();
    await settle(60); // 超过若干退避窗口
    expect(conn.state).toBe("key-all-invalid");
    expect(host.openCalls).toBe(1);
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

  it("未连接/离线：forward 快速失败 provider_offline", async () => {
    const conn = makeConnection(ringOf(epId()));
    expect(() =>
      conn.forward({ serviceId: "s", method: "GET", path: "/", body: new Uint8Array(0), upgrade: false }, HANDLERS()),
    ).toThrowError(/offline/);
    const host = fakeFactoryHost();
    const conn2 = makeConnection(ringOf(epId()), host);
    conn2.start();
    connectFail(host, new Error("dial failed"));
    await settle();
    expect(conn2.state).toBe("offline");
    expect(() =>
      conn2.forward({ serviceId: "s", method: "GET", path: "/", body: new Uint8Array(0), upgrade: false }, HANDLERS()),
    ).toThrowError(OfflineError);
  });
});

// ---------------------------------------------------------------------------
// 请求转发帧构造
// ---------------------------------------------------------------------------

describe("forward 帧构造", () => {
  async function authedConn(): Promise<{ conn: ProviderConnection; provider: ProviderSide; host: FakeFactoryHost; ep: string }> {
    const ep = epId();
    const ring = ringOf(ep, [{ keyId: "k", key: "sk-aifly-forward-key-0001", group: "g" }]);
    const host = fakeFactoryHost();
    const conn = makeConnection(ring, host);
    conn.start();
    const session = connectOk(host);
    const provider = new ProviderSide(session.peerTransport);
    await settle();
    await provider.authOk([{ keyId: "k", group: "g", services: [svc("svc-a", "ollama", 11434)] }]);
    await settle();
    return { conn, provider, host, ep };
  }

  it("小请求单帧 REQ（头/正文/方法/路径/查询串）", async () => {
    const { conn, provider } = await authedConn();
    const body = new TextEncoder().encode('{"q":1}');
    conn.forward(
      {
        serviceId: "svc-a",
        method: "POST",
        path: "/v1/chat/completions?stream=1",
        headers: { "x-custom": "v", "anthropic-version": "2023-06-01" },
        contentType: "application/json",
        body,
        upgrade: false,
      },
      HANDLERS(),
    );
    await settle();
    const req = provider.last<Extract<InboundFrame, { type: typeof FRAME_TYPE.REQ }>>(FRAME_TYPE.REQ);
    expect(req?.header.serviceId).toBe("svc-a");
    expect(req?.header.method).toBe("POST");
    expect(req?.header.path).toBe("/v1/chat/completions?stream=1");
    expect(req?.header.contentType).toBe("application/json");
    expect(req?.header.headers).toMatchObject({ "x-custom": "v", "anthropic-version": "2023-06-01" });
    expect(req?.header.bodyLen).toBe(body.byteLength);
    expect(new Uint8Array(req!.body)).toEqual(body);
  });

  it("大正文 >256KiB：REQ 空体 + REQ_BODY 分片（seq 0..n 递增、end 收尾）", async () => {
    const { conn, provider } = await authedConn();
    const big = new Uint8Array(600 * 1024).fill(0x61);
    conn.forward({ serviceId: "svc-a", method: "POST", path: "/big", body: big, upgrade: false }, HANDLERS());
    await settle();
    const req = provider.last<Extract<InboundFrame, { type: typeof FRAME_TYPE.REQ }>>(FRAME_TYPE.REQ);
    expect(req?.header.bodyLen).toBe(big.byteLength);
    expect(req?.body.length).toBe(0); // 超限正文全部走续帧
    const bodies = provider.frames.filter((f) => f.type === FRAME_TYPE.REQ_BODY);
    expect(bodies.length).toBe(3);
    expect(bodies.map((f) => (f.header as { seq: number }).seq)).toEqual([0, 1, 2]);
    expect(bodies.map((f) => (f.header as { end: boolean }).end)).toEqual([false, false, true]);
    const total = bodies.reduce((n, f) => n + f.body.length, 0);
    expect(total).toBe(big.byteLength);
  });

  it("响应帧路由到 handlers：META → CHUNK → END", async () => {
    const { conn, provider } = await authedConn();
    const h = HANDLERS();
    conn.forward({ serviceId: "svc-a", method: "GET", path: "/x", body: new Uint8Array(0), upgrade: false }, h);
    await settle();
    const id = provider.last<Extract<InboundFrame, { type: typeof FRAME_TYPE.REQ }>>(FRAME_TYPE.REQ)!.header.id;
    await provider.session.send(FRAME_TYPE.RESP_META, { id, status: 200, contentType: "text/event-stream" });
    await provider.session.send(FRAME_TYPE.RESP_CHUNK, { id, seq: 0 }, new TextEncoder().encode("data: 1\n\n"));
    await provider.session.send(FRAME_TYPE.RESP_CHUNK, { id, seq: 1 }, new TextEncoder().encode("data: [DONE]\n\n"));
    await provider.session.send(FRAME_TYPE.RESP_END, { id });
    await settle();
    expect(h.events).toEqual(["meta", "chunk", "chunk", "end", "terminate:peer"]);
  });

  it("WS：DATA_UP 保序（seq 连续）+ CLOSE 终结", async () => {
    const { conn, provider } = await authedConn();
    const h = HANDLERS();
    const handle = conn.forward({ serviceId: "svc-a", method: "GET", path: "/ws", headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "k1", "sec-websocket-version": "13" }, body: new Uint8Array(0), upgrade: true }, h);
    await settle();
    void handle.sendData(new TextEncoder().encode("hello"));
    void handle.sendData(new TextEncoder().encode("world"));
    await settle();
    const ups = provider.frames.filter((f) => f.type === FRAME_TYPE.DATA_UP);
    expect(ups.map((f) => (f.header as { seq: number }).seq)).toEqual([0, 1]);
    const id = provider.last<Extract<InboundFrame, { type: typeof FRAME_TYPE.REQ }>>(FRAME_TYPE.REQ)!.header.id;
    await provider.session.send(FRAME_TYPE.DATA_DOWN, { v: 1, id, seq: 0 }, new TextEncoder().encode("echo"));
    await provider.session.send(FRAME_TYPE.CLOSE, { id, code: 1000 });
    await settle();
    expect(h.events).toContain("wsdata");
    expect(h.events).toContain("wsclose");
    expect(h.events).toContain("terminate:peer");
  });

  it("客户端 ABORT（本地终结）→ 提供方收到 ABORT 帧", async () => {
    const { conn, provider } = await authedConn();
    const h = HANDLERS();
    const handle = conn.forward({ serviceId: "svc-a", method: "GET", path: "/x", body: new Uint8Array(0), upgrade: false }, h);
    await settle();
    handle.abort();
    await settle();
    expect(provider.frames.some((f) => f.type === FRAME_TYPE.ABORT)).toBe(true);
    expect(h.events).toContain("terminate:local");
  });
});

// ---------------------------------------------------------------------------
// 目录同步（refresh 全量替换）
// ---------------------------------------------------------------------------

describe("refresh 目录同步", () => {
  it("全量替换：新增/删除/relay 变更落盘 + onCatalog 回调 + 裸密钥元数据回填", async () => {
    const ep = epId();
    const ring = ringOf(ep, [{ keyId: "kid1", key: "sk-aifly-refresh-key-001", group: "g1" }]);
    saveKeyring(root, ring);
    const host = fakeFactoryHost();
    const catalogs: Array<{ services: readonly ServiceEntry[]; ports: Readonly<Record<string, number>> }> = [];
    const conn = new ProviderConnection({
      ring,
      root,
      factory: host.factory,
      backoff: { baseMs: 5, capMs: 25 },
      onCatalog: (_c, updated) => catalogs.push({ services: updated.services, ports: updated.ports }),
    });
    cleanups.push(() => conn.stop());
    conn.start();
    const session = connectOk(host);
    const provider = new ProviderSide(session.peerTransport);
    await settle();
    await provider.authOk([{ keyId: "kid1", group: "g1", services: [svc("svc-a", "a", 1), svc("svc-del", "del", 2)] }]);
    await settle();
    expect(catalogs[0]!.services.map((s) => s.serviceId).sort()).toEqual(["svc-a", "svc-del"]);
    // refresh：删 svc-del、加 svc-new、relay 变更；同时回填一枚新裸钥（kid-fresh）
    const withBare = { ...loadKeyring(root, ep)!, keys: [...loadKeyring(root, ep)!.keys, { keyId: "", key: "sk-aifly-bare-refill-001", group: "" }] };
    saveKeyring(root, withBare);
    conn.refreshRing(withBare); // 在线追加密钥路径下 re-AUTH 由实现触发，此处只刷环
    await provider.authOk(
      [
        { keyId: "kid1", group: "g1", services: [svc("svc-a", "a", 1), svc("svc-new", "new", 3)] },
        { keyId: "kid-fresh", group: "g9", services: [] },
      ],
      { relayUrls: ["http://new-relay:2"], refresh: true },
    );
    await settle();
    const persisted = loadKeyring(root, ep)!;
    expect(persisted.services.map((s) => s.serviceId).sort()).toEqual(["svc-a", "svc-new"]);
    expect(persisted.relayUrls).toEqual(["http://new-relay:2"]);
    expect(persisted.keys.find((k) => k.key === "sk-aifly-bare-refill-001")).toEqual({ keyId: "kid-fresh", key: "sk-aifly-bare-refill-001", group: "g9" });
    expect(catalogs[1]!.services.map((s) => s.serviceId).sort()).toEqual(["svc-a", "svc-new"]);
    await conn.stop();
  });
});

// ---------------------------------------------------------------------------
// 毒化 / 断连重连 / 轮询复核 / 环变化恢复
// ---------------------------------------------------------------------------

describe("毒化与重连", () => {
  async function connected(host: FakeFactoryHost): Promise<{ conn: ProviderConnection; provider: ProviderSide; session: FakeSession }> {
    const ring = ringOf(epId(), [{ keyId: "k", key: "sk-aifly-poison-key-00001", group: "g" }]);
    const conn = makeConnection(ring, host);
    conn.start();
    const session = connectOk(host);
    const provider = new ProviderSide(session.peerTransport);
    await settle();
    await provider.authOk([{ keyId: "k", group: "g", services: [svc("svc-a", "a", 1)] }]);
    await settle();
    return { conn, provider, session };
  }

  it("RESP_CHUNK 序号缺断 → 毒化 → 重建（teardown + 新 openSession）", async () => {
    const host = fakeFactoryHost();
    const { conn, provider } = await connected(host);
    const h = HANDLERS();
    conn.forward({ serviceId: "svc-a", method: "GET", path: "/x", body: new Uint8Array(0), upgrade: false }, h);
    await settle();
    const id = provider.last<Extract<InboundFrame, { type: typeof FRAME_TYPE.REQ }>>(FRAME_TYPE.REQ)!.header.id;
    await provider.session.send(FRAME_TYPE.RESP_META, { id, status: 200, contentType: "application/json" });
    await provider.session.send(FRAME_TYPE.RESP_CHUNK, { id, seq: 0 }, new Uint8Array(1));
    await provider.session.send(FRAME_TYPE.RESP_CHUNK, { id, seq: 2 }, new Uint8Array(1)); // 缺断
    await settle(50);
    expect(h.events).toContain("terminate:protocol-seq");
    // 重建：旧会话 teardown、新 openSession 发起
    expect(host.sessions[0]!.tornDown).toBeGreaterThanOrEqual(1);
    expect(host.openCalls).toBe(2);
    expect(conn.state === "offline" || conn.state === "not-connected" || conn.state === "connected-unauthed").toBe(true);
    await conn.stop();
  });

  it("对端断连 → offline + 退避重连（full jitter base 5ms cap 25ms）→ 恢复续用", async () => {
    const host = fakeFactoryHost();
    const { conn, provider } = await connected(host);
    const h = HANDLERS();
    conn.forward({ serviceId: "svc-a", method: "GET", path: "/x", body: new Uint8Array(0), upgrade: false }, h);
    await settle();
    provider.session.dispose("peer gone"); // 对端断开
    await settle();
    expect(conn.state).toBe("offline");
    expect(h.events).toContain("terminate:disconnected");
    // 退避窗口（≤25ms + 余量）后自动重连成功并恢复 AUTH
    await settle(80);
    const session2 = connectOk(host);
    const provider2 = new ProviderSide(session2.peerTransport);
    await settle();
    await provider2.authOk([{ keyId: "k", group: "g", services: [svc("svc-a", "a", 1)] }]);
    await settle();
    expect(conn.state).toBe("direct");
    await conn.stop();
  });

  it("linkStatus 轮询：unknown → 事件丢失兜底重建", async () => {
    const host = fakeFactoryHost();
    const { conn, session } = await connected(host);
    session.linkResult = "unknown";
    const before = host.openCalls;
    await settle(80); // pollInterval 默认 30s——此处用短轮询构建
    expect(host.openCalls).toBe(before); // 默认 30s 不触发；换短轮询重验
    await conn.stop();
    // 显式短轮询验证
    const host2 = fakeFactoryHost();
    const ring = ringOf(epId(), [{ keyId: "k", key: "sk-aifly-poll-key-0000001", group: "g" }]);
    const conn2 = new ProviderConnection({ ring, root, factory: host2.factory, pollIntervalMs: 15, backoff: { baseMs: 5, capMs: 25 } });
    cleanups.push(() => conn2.stop());
    conn2.start();
    const s2 = connectOk(host2);
    const p2 = new ProviderSide(s2.peerTransport);
    await settle();
    await p2.authOk([{ keyId: "k", group: "g", services: [] }]);
    await settle();
    expect(conn2.state).toBe("direct");
    s2.linkResult = "unknown";
    await settle(60);
    expect(s2.tornDown).toBeGreaterThanOrEqual(1);
    expect(host2.openCalls).toBe(2);
    await conn2.stop();
  });

  it("key_all_invalid 后 key add（环文件变化）→ 轮询重载 → 重连重 AUTH", async () => {
    const ep = epId();
    const ring = ringOf(ep, [{ keyId: "k1", key: "sk-aifly-allinvalid-0001", group: "g" }]);
    saveKeyring(root, ring);
    const host = fakeFactoryHost();
    const conn = new ProviderConnection({
      ring,
      root,
      factory: host.factory,
      pollIntervalMs: 15,
      backoff: { baseMs: 5, capMs: 25 },
      reloadRing: (endpointId) => loadKeyring(root, endpointId),
    });
    cleanups.push(() => conn.stop());
    conn.start();
    const session = connectOk(host);
    const provider = new ProviderSide(session.peerTransport);
    await settle();
    await provider.authErr();
    await settle();
    expect(conn.state).toBe("key-all-invalid");
    // 另一进程 key add：环文件新增密钥
    const updated = loadKeyring(root, ep)!;
    updated.keys.push({ keyId: "", key: "sk-aifly-fresh-added-000001", group: "" });
    saveKeyring(root, updated);
    await settle(60);
    expect(conn.state).not.toBe("key-all-invalid"); // 已发起重连
    expect(host.openCalls).toBe(2);
    const session2 = connectOk(host);
    const provider2 = new ProviderSide(session2.peerTransport);
    await settle();
    const auth = provider2.last<InboundFrame & { header: AuthHeader }>(FRAME_TYPE.AUTH);
    expect(auth?.header.keys).toContain("sk-aifly-fresh-added-000001");
    await conn.stop();
  });
});

// ---------------------------------------------------------------------------
// 多提供者并存（管理器层）
// ---------------------------------------------------------------------------

describe("ProviderManager 多提供者并存", () => {
  it("P1 断连不影响 P2 路由", async () => {
    const ep1 = epId();
    const ep2 = epId();
    const hosts = [fakeFactoryHost(), fakeFactoryHost()];
    let i = 0;
    const manager = new ProviderManager({
      rings: [ringOf(ep1, [{ keyId: "k", key: "sk-aifly-p1-key-0000000001", group: "g" }]), ringOf(ep2, [{ keyId: "k", key: "sk-aifly-p2-key-0000000001", group: "g" }])],
      root,
      sessionFactory: () => hosts[i++]!.factory,
      backoff: { baseMs: 5, capMs: 25 },
    });
    cleanups.push(() => manager.stop());
    manager.start();
    const s1 = connectOk(hosts[0]!);
    const s2 = connectOk(hosts[1]!);
    const p1 = new ProviderSide(s1.peerTransport);
    const p2 = new ProviderSide(s2.peerTransport);
    await settle();
    await p1.authOk([{ keyId: "k", group: "g", services: [svc("svc-p1", "p1", 1)] }]);
    await p2.authOk([{ keyId: "k", group: "g", services: [svc("svc-p2", "p2", 2)] }]);
    await settle();
    expect(manager.routeFor(ep1)?.state).toBe("direct");
    expect(manager.routeFor(ep2)?.state).toBe("direct");
    p1.session.dispose("p1 gone");
    await settle();
    expect(manager.routeFor(ep1)?.state).toBe("offline");
    expect(manager.routeFor(ep2)?.state).toBe("direct");
    await manager.stop();
  });
});

// ---------------------------------------------------------------------------
// full jitter 退避纯函数（1s→60s 边界）
// ---------------------------------------------------------------------------

describe("fullJitterDelayMs", () => {
  it("attempt 0：窗口 [0, base]", () => {
    expect(fullJitterDelayMs(0, { baseMs: 1000, capMs: 60000, random: () => 0 })).toBe(0);
    const hi = fullJitterDelayMs(0, { baseMs: 1000, capMs: 60000, random: () => 0.999999 });
    expect(hi).toBeLessThanOrEqual(1000);
    expect(fullJitterDelayMs(0, { baseMs: 1000, capMs: 60000, random: () => 1 })).toBe(1000);
  });

  it("指数增长到 cap 后恒为 [0, cap]", () => {
    expect(fullJitterDelayMs(5, { baseMs: 1000, capMs: 60000, random: () => 1 })).toBe(32000);
    expect(fullJitterDelayMs(6, { baseMs: 1000, capMs: 60000, random: () => 1 })).toBe(60000);
    expect(fullJitterDelayMs(20, { baseMs: 1000, capMs: 60000, random: () => 1 })).toBe(60000);
    expect(fullJitterDelayMs(20, { baseMs: 1000, capMs: 60000, random: () => 0 })).toBe(0);
    const mid = fullJitterDelayMs(9, { baseMs: 1000, capMs: 60000, random: () => 0.5 });
    expect(mid).toBe(30000);
  });

  it("默认参数 1s→60s", () => {
    expect(fullJitterDelayMs(0, { random: () => 1 })).toBe(1000);
    expect(fullJitterDelayMs(7, { random: () => 1 })).toBe(60000);
  });
});

// ---------------------------------------------------------------------------
// 目录同步 × actualPorts 回写共存（cli-hardening 修复的回归锚点）
// ---------------------------------------------------------------------------
describe("目录同步与 actualPorts 回写共存", () => {
  it("AUTH_OK refresh 不覆写磁盘侧 actualPorts（引擎回写的错开端口保留）", async () => {
    const ep = epId();
    const ring = ringOf(ep, [{ keyId: "k", key: "sk-aifly-test-000000000001", group: "g" }]);
    saveKeyring(root, ring);
    const host = fakeFactoryHost();
    const conn = makeConnection(ring, host);
    conn.start();
    const session = connectOk(host);
    const provider = new ProviderSide(session.peerTransport);
    await settle();
    await provider.authOk([{ keyId: "k", group: "g", services: [svc("s1", "s1", 4481)] }]);
    await settle();
    // 引擎监听回写：端口 4481 被占，实际落在 53001
    setActualPorts(root, ep, { s1: 53001 });
    // 目录 refresh 到达——必须保留磁盘侧 actualPorts，不得用构造期内存快照清空
    await provider.authOk([{ keyId: "k", group: "g", services: [svc("s1", "s1", 4481)] }]);
    await settle();
    expect(loadKeyring(root, ep)?.actualPorts).toEqual({ s1: 53001 });
    await conn.stop();
  });
});
