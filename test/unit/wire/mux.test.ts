// WireSession 单测（内存 loopback 成对传输 + fake timers）：并发双 id 交错保序、
// 乱序 seq 毒化、终结后丢帧、空闲计时（含 provider 首字节豁免）、队列门控与回落、
// 断连全量终结、方向矩阵、未 AUTH 计数断连、id 不复用、重组上限、schema 违例回敬、
// 版本/类型/畸形/非 aifly envelope 处置。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFrame, type DecodedFrame } from "../../../src/wire/codec.ts";
import {
  FRAME_TYPE,
  type RespChunkHeader,
  type ReqHeader,
  type ErrorHeader,
} from "../../../src/wire/frames.ts";
import {
  WireSession,
  type InboundFrame,
  type TerminateCause,
  type WireSessionOptions,
} from "../../../src/wire/mux.ts";
import { createLoopbackPair, type LoopbackTransport } from "./loopback.ts";

const ENC = new TextEncoder();

function bytes(n: number, fill = 0xab): Uint8Array {
  return Uint8Array.from({ length: n }, () => fill);
}

async function settle(ms = 5): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function isPending(p: Promise<unknown>): Promise<boolean> {
  return await Promise.race([
    p.then(
      () => false,
      () => false,
    ),
    new Promise<boolean>((resolve) => setImmediate(() => resolve(true))),
  ]);
}

interface EventLog {
  frames: InboundFrame[];
  poisons: Array<{ id: string; reason: "protocol_seq" }>;
  idles: string[];
  unauth: number[];
  disconnects: Array<string | undefined>;
  terminates: Array<{ id: string; cause: TerminateCause }>;
}

function makeEvents(): EventLog {
  return {
    frames: [],
    poisons: [],
    idles: [],
    unauth: [],
    disconnects: [],
    terminates: [],
  };
}

function hooksOf(log: EventLog) {
  return {
    onFrame: (f: InboundFrame) => log.frames.push(f),
    onPoison: (i: { id: string; reason: "protocol_seq" }) => log.poisons.push(i),
    onIdleTimeout: (id: string) => log.idles.push(id),
    onUnauthViolation: (n: number) => log.unauth.push(n),
    onDisconnect: (r?: string) => log.disconnects.push(r),
    onTerminate: (id: string, cause: TerminateCause) => log.terminates.push({ id, cause }),
  };
}

interface Harness {
  consumer: WireSession;
  provider: WireSession;
  tc: LoopbackTransport; // consumer 侧传输（其 cbs = consumer 入站）
  tp: LoopbackTransport; // provider 侧传输
  consumerEvents: EventLog;
  providerEvents: EventLog;
}

function createHarness(
  overrides: { consumer?: Partial<WireSessionOptions>; provider?: Partial<WireSessionOptions> } = {},
): Harness {
  const { a, b } = createLoopbackPair();
  const consumerEvents = makeEvents();
  const providerEvents = makeEvents();
  const consumer = new WireSession({ role: "consumer", transport: a, hooks: hooksOf(consumerEvents), ...overrides.consumer });
  const provider = new WireSession({ role: "provider", transport: b, hooks: hooksOf(providerEvents), ...overrides.provider });
  return { consumer, provider, tc: a, tp: b, consumerEvents, providerEvents };
}

function authed(h: Harness): void {
  h.consumer.markAuthed();
  h.provider.markAuthed();
}

function reqHeader(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, id, serviceId: "svc1", method: "POST", path: "/v1/x", bodyLen: 0, ...over };
}

async function sendReq(session: WireSession, id: string, over: Record<string, unknown> = {}): Promise<void> {
  await session.send(FRAME_TYPE.REQ, reqHeader(id, over));
}

/** 直接向某侧投递一帧原始编码（绕过对侧，用于注入伪造/畸形帧）。 */
function raw(target: LoopbackTransport, type: number, header: object, body: Uint8Array = bytes(0)): void {
  target.deliverRaw(encodeFrame({ type, header, body }));
}

function spyOn(target: LoopbackTransport): DecodedFrame[] {
  const seen: DecodedFrame[] = [];
  target.onFrame((f) => seen.push(f));
  return seen;
}

function errorFrames(seen: readonly DecodedFrame[]): ErrorHeader[] {
  return seen
    .filter((f): f is Extract<DecodedFrame, { kind: "frame" }> => f.kind === "frame" && f.type === FRAME_TYPE.ERROR)
    .map((f) => f.header as unknown as ErrorHeader);
}

function minimalAuthOk(): Record<string, unknown> {
  return {
    v: 1,
    alias: "box",
    relayUrls: ["https://relay.example/announce"],
    groups: [
      {
        keyId: "k1",
        group: "g1",
        limits: { maxConcurrency: 4 },
        services: [{ serviceId: "s1", name: "api", match: [{ type: "exact", value: "api.example.com" }], defaultPort: 11434 }],
      },
    ],
  };
}

function futureVersionFrame(): Uint8Array {
  const out = new Uint8Array(11);
  out.set(ENC.encode("aifly2"), 0);
  out[6] = FRAME_TYPE.REQ;
  out[7] = 0;
  out[8] = 2;
  out.set(ENC.encode("{}"), 9);
  return out;
}

function unknownTypeFrame(type = 0x55): Uint8Array {
  const json = ENC.encode("{}");
  const out = new Uint8Array(9 + json.length);
  out.set(ENC.encode("aifly1"), 0);
  out[6] = type;
  out[7] = 0;
  out[8] = json.length;
  out.set(json, 9);
  return out;
}

function malformedFrame(): Uint8Array {
  const json = ENC.encode("{nope");
  const out = new Uint8Array(9 + json.length);
  out.set(ENC.encode("aifly1"), 0);
  out[6] = FRAME_TYPE.REQ;
  out[7] = 0;
  out[8] = json.length;
  out.set(json, 9);
  return out;
}

// ---------------------------------------------------------------------------

describe("WireSession 出站保序与队列", () => {
  it("并发双 id 交错出站：各自 request-id 帧序完整归位", async () => {
    const h = createHarness();
    authed(h);
    const idA = h.consumer.allocId();
    const idB = h.consumer.allocId();
    await sendReq(h.consumer, idA);
    await sendReq(h.consumer, idB);
    expect(h.providerEvents.frames.filter((f) => f.type === FRAME_TYPE.REQ).length).toBe(2);

    // 随机微延迟 + 双 id 交错入队且不逐帧 await：检验内部 promise 链的保序。
    h.tp.sendGate = () => new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 4)));
    const N = 20;
    const sends: Array<Promise<void>> = [];
    for (let i = 0; i < N; i++) {
      sends.push(h.provider.send(FRAME_TYPE.RESP_CHUNK, { id: idA, seq: i }, bytes(16)));
      sends.push(h.provider.send(FRAME_TYPE.RESP_CHUNK, { id: idB, seq: i }, bytes(16)));
    }
    await Promise.all(sends);
    await settle(20);

    const seqsOf = (id: string) =>
      h.consumerEvents.frames
        .filter((f) => f.type === FRAME_TYPE.RESP_CHUNK && (f.header as RespChunkHeader).id === id)
        .map((f) => (f.header as RespChunkHeader).seq);
    expect(seqsOf(idA)).toEqual(Array.from({ length: N }, (_, i) => i));
    expect(seqsOf(idB)).toEqual(Array.from({ length: N }, (_, i) => i));
    expect(h.consumer.stats().schemaDropped).toBe(0);
  });

  it("队列上限门控：达到上限后续 send 等待回落（cap=2 演示 64 帧同机制）", async () => {
    const h = createHarness({ provider: { maxQueuedPerId: 2 } });
    authed(h);
    const id = h.consumer.allocId();
    await sendReq(h.consumer, id);

    const gates: Array<() => void> = [];
    h.tp.sendGate = () => new Promise<void>((resolve) => gates.push(resolve));

    const p1 = h.provider.send(FRAME_TYPE.RESP_CHUNK, { id, seq: 0 }, bytes(4));
    const p2 = h.provider.send(FRAME_TYPE.RESP_CHUNK, { id, seq: 1 }, bytes(4));
    const p3 = h.provider.send(FRAME_TYPE.RESP_CHUNK, { id, seq: 2 }, bytes(4)); // 应被门控
    await flush();
    expect(h.provider.outboundQueueDepth(id)).toBe(2);
    expect(await isPending(p3)).toBe(true);
    const drained = h.provider.waitOutboundQueue(id, 0);
    expect(await isPending(drained)).toBe(true);

    // 逐个放行（放行一个会腾出槽位，p3 入队后又生成新门）。
    for (let guard = 0; guard < 10 && (gates.length > 0 || h.provider.outboundQueueDepth(id) > 0); guard++) {
      gates.shift()?.();
      await flush();
    }
    await Promise.all([p1, p2, p3, drained]);
    expect(h.provider.outboundQueueDepth(id)).toBe(0);

    const seqs = h.consumerEvents.frames
      .filter((f) => f.type === FRAME_TYPE.RESP_CHUNK)
      .map((f) => f.header.seq);
    expect(seqs).toEqual([0, 1, 2]);
  });

  it("终结唤醒等待者（复核 R2-F3）：peer ERROR 后门控 send 走 terminalDropped、waitOutboundQueue 返回", async () => {
    // 消费侧停泊（ERROR 仅提供方可出站）：REQ 同 id 超 cap 挂起。
    const h = createHarness({ consumer: { maxQueuedPerId: 1 } });
    authed(h);
    const id = h.consumer.allocId();
    h.tc.sendGate = () => new Promise<void>(() => undefined); // 永不结算
    void h.consumer.send(FRAME_TYPE.REQ, { ...reqHeader(id) });
    await flush();
    const gated = h.consumer.send(FRAME_TYPE.REQ, { ...reqHeader(id) }); // 门控挂起
    const waiting = h.consumer.waitOutboundQueue(id, 0);
    await flush();
    expect(await isPending(gated)).toBe(true);
    expect(await isPending(waiting)).toBe(true);

    // 对端 ERROR 该 id → finishId：等待者必须被唤醒（修复前永久挂起）。
    await h.provider.send(FRAME_TYPE.ERROR, { code: "idle_timeout", message: "peer gone", id });
    await flush();
    await Promise.race([
      Promise.all([waiting, gated]),
      new Promise(((_, reject) => setTimeout(() => reject(new Error("waiters not woken on terminal")), 500))),
    ]);
    expect(h.consumer.stats().terminalDropped).toBe(1); // gated 帧被丢弃而非发出
    expect(h.consumerEvents.terminates.some((t) => t.id === id)).toBe(true);
  });

  it("断连唤醒等待者（复核 R2-F3）：close 后 waitOutboundQueue 返回、门控 send 以 closed 拒绝", async () => {
    const h = createHarness({ provider: { maxQueuedPerId: 1 } });
    authed(h);
    const id = h.consumer.allocId();
    await sendReq(h.consumer, id);
    h.tp.sendGate = () => new Promise<void>(() => undefined);
    void h.provider.send(FRAME_TYPE.RESP_CHUNK, { id, seq: 0 }, bytes(4));
    await flush();
    const gated = h.provider.send(FRAME_TYPE.RESP_CHUNK, { id, seq: 1 }, bytes(4));
    const waiting = h.provider.waitOutboundQueue(id, 0);
    await flush();
    expect(await isPending(waiting)).toBe(true);

    h.tc.close("bye"); // 两侧 onClose → handleClosed（置 terminal 后唤醒）
    await Promise.race([
      waiting,
      new Promise(((_, reject) => setTimeout(() => reject(new Error("waiter not woken on close")), 500))),
    ]);
    await gated; // 唤醒后走 terminalDropped（帧被丢弃、promise 正常结算）
    expect(h.provider.stats().terminalDropped).toBe(1);
  });

  it("出站方向违规抛本地误用（ERROR 仅提供方发出等）", async () => {
    const h = createHarness();
    authed(h);
    await expect(h.consumer.send(FRAME_TYPE.ERROR, { code: "internal", message: "x" })).rejects.toThrow(/not outbound/);
    await expect(h.provider.send(FRAME_TYPE.REQ, reqHeader("x"))).rejects.toThrow(/not outbound/);
    await expect(h.consumer.send(0x7f as never, {})).rejects.toThrow();
  });
});

describe("WireSession seq 连续性与毒化", () => {
  it("REQ_BODY seq 缺断：provider 回 protocol_seq、毒化、终结该请求", async () => {
    const h = createHarness();
    authed(h);
    const spy = spyOn(h.tc);
    const id = "gap0000000000000000000000x";
    raw(h.tp, FRAME_TYPE.REQ, reqHeader(id, { bodyLen: 100 }));
    raw(h.tp, FRAME_TYPE.REQ_BODY, { id, seq: 0, end: false }, bytes(10));
    await settle();
    expect(h.providerEvents.frames.length).toBe(2);

    raw(h.tp, FRAME_TYPE.REQ_BODY, { id, seq: 2, end: true }, bytes(10)); // 跳过 seq 1
    await settle();
    expect(h.providerEvents.poisons).toEqual([{ id, reason: "protocol_seq" }]);
    expect(h.provider.poisoned).toBe(true);
    expect(errorFrames(spy)).toEqual([
      expect.objectContaining({ id, code: "protocol_seq", message: expect.stringMatching(/^chunk sequence gap$/) }),
    ]);
    expect(h.providerEvents.terminates.some((t) => t.id === id && t.cause.source === "protocol-seq")).toBe(true);

    // 毒化后一切入站帧静默丢弃
    raw(h.tp, FRAME_TYPE.PING, { id });
    await settle();
    expect(h.provider.stats().poisonedDropped).toBe(1);
  });

  it("DATA_UP seq 缺断同规（WS 通道）", async () => {
    const h = createHarness();
    authed(h);
    const spy = spyOn(h.tc);
    const id = "wsgap00000000000000000000z";
    raw(h.tp, FRAME_TYPE.REQ, reqHeader(id));
    raw(h.tp, FRAME_TYPE.DATA_UP, { v: 1, id, seq: 0 }, bytes(4));
    raw(h.tp, FRAME_TYPE.DATA_UP, { v: 1, id, seq: 3 }, bytes(4)); // 缺 1、2
    await settle();
    expect(h.providerEvents.poisons.map((p) => p.id)).toEqual([id]);
    expect(errorFrames(spy).map((e) => e.code)).toEqual(["protocol_seq"]);
  });

  it("consumer 侧 RESP_CHUNK 缺断：本地终结 + 毒化、不回任何帧", async () => {
    const h = createHarness();
    authed(h);
    const id = h.consumer.allocId();
    await sendReq(h.consumer, id);
    const spy = spyOn(h.tp); // 观察使用方是否发出字节（应为零；不含此前的 REQ 流量）
    raw(h.tc, FRAME_TYPE.RESP_CHUNK, { id, seq: 5 }, bytes(4));
    await settle();
    expect(h.consumerEvents.poisons).toEqual([{ id, reason: "protocol_seq" }]);
    expect(h.consumerEvents.terminates.some((t) => t.id === id && t.cause.source === "protocol-seq")).toBe(true);
    expect(spy.filter((f) => f.kind === "frame")).toEqual([]);
  });

  it("连续 seq 正常推进（RESP_CHUNK 0..N 与 WS 双向 DATA 独立计数）", async () => {
    const h = createHarness();
    authed(h);
    const id = h.consumer.allocId();
    await sendReq(h.consumer, id);
    await h.provider.send(FRAME_TYPE.RESP_META, { id, status: 101, contentType: "text/plain", headers: { "sec-websocket-accept": "abc=" } });
    for (const seq of [0, 1, 2]) {
      await h.provider.send(FRAME_TYPE.RESP_CHUNK, { id, seq }, bytes(8));
      await h.provider.send(FRAME_TYPE.DATA_DOWN, { v: 1, id, seq }, bytes(8));
      await h.consumer.send(FRAME_TYPE.DATA_UP, { v: 1, id, seq }, bytes(8));
    }
    await settle();
    const kinds = h.consumerEvents.frames.map((f) => f.type);
    expect(kinds).toContain(FRAME_TYPE.RESP_META);
    expect(h.consumerEvents.frames.filter((f) => f.type === FRAME_TYPE.RESP_CHUNK).length).toBe(3);
    expect(h.consumerEvents.frames.filter((f) => f.type === FRAME_TYPE.DATA_DOWN).length).toBe(3);
    expect(h.providerEvents.frames.filter((f) => f.type === FRAME_TYPE.DATA_UP).length).toBe(3);
    expect(h.consumer.stats().schemaDropped + h.consumer.stats().directionDropped).toBe(0);
  });
});

describe("WireSession 终结语义", () => {
  it("RESP_END 后：双向迟到帧均静默丢弃", async () => {
    const h = createHarness();
    authed(h);
    const id = h.consumer.allocId();
    await sendReq(h.consumer, id);
    await h.provider.send(FRAME_TYPE.RESP_CHUNK, { id, seq: 0 }, bytes(4));
    await h.provider.send(FRAME_TYPE.RESP_END, { id });
    await settle();

    // provider 侧终结后再出站：本地丢弃（send 静默返回）
    await h.provider.send(FRAME_TYPE.RESP_CHUNK, { id, seq: 1 }, bytes(4));
    // consumer 侧迟到帧：静默丢弃
    raw(h.tc, FRAME_TYPE.RESP_CHUNK, { id, seq: 1 }, bytes(4));
    await settle();

    const chunks = h.consumerEvents.frames.filter((f) => f.type === FRAME_TYPE.RESP_CHUNK).length;
    expect(chunks).toBe(1);
    expect(h.consumerEvents.frames.filter((f) => f.type === FRAME_TYPE.RESP_END).length).toBe(1);
    expect(h.provider.stats().terminalDropped).toBe(1);
    expect(h.consumer.stats().terminalDropped).toBe(1);
    expect(h.providerEvents.terminates.some((t) => t.id === id && t.cause.source === "local")).toBe(true);
    expect(h.consumerEvents.terminates.some((t) => t.id === id && t.cause.source === "peer")).toBe(true);
  });

  it("CLOSE 为 WS 终结帧：接收方终结、其后同 id 出站被丢弃", async () => {
    const h = createHarness();
    authed(h);
    const id = h.consumer.allocId();
    await sendReq(h.consumer, id);
    await h.provider.send(FRAME_TYPE.CLOSE, { id, code: 1000 });
    await settle();
    expect(h.consumerEvents.terminates.some((t) => t.id === id && t.cause.source === "peer")).toBe(true);
    // 使用方终结后再发 DATA_UP：静默丢弃
    await h.consumer.send(FRAME_TYPE.DATA_UP, { v: 1, id, seq: 0 }, bytes(2));
    expect(h.providerEvents.frames.filter((f) => f.type === FRAME_TYPE.DATA_UP).length).toBe(0);
    expect(h.consumer.stats().terminalDropped).toBe(1);
  });

  it("ERROR 终结（provider→consumer）与 ABORT→ERROR(aborted) 流程", async () => {
    const h = createHarness();
    authed(h);
    const id = h.consumer.allocId();
    await sendReq(h.consumer, id);
    raw(h.tp, FRAME_TYPE.ABORT, { id }); // 使用方本地断开 → ABORT
    await settle();
    const aborts = h.providerEvents.frames.filter((f) => f.type === FRAME_TYPE.ABORT);
    expect(aborts.length).toBe(1);
    expect(h.providerEvents.terminates.some((t) => t.id === id)).toBe(false); // ABORT 本身不终结

    await h.provider.send(FRAME_TYPE.ERROR, { id, code: "aborted", message: "client aborted" });
    await settle();
    const errs = h.consumerEvents.frames.filter((f) => f.type === FRAME_TYPE.ERROR).map((f) => f.header as unknown as ErrorHeader);
    expect(errs).toEqual([expect.objectContaining({ id, code: "aborted" })]);
    expect(h.consumerEvents.terminates.some((t) => t.id === id && t.cause.source === "peer")).toBe(true);
    // provider 侧发送终结帧后同样终结
    expect(h.providerEvents.terminates.some((t) => t.id === id && t.cause.source === "local")).toBe(true);
  });

  it("terminal(id) 本地终结：迟到帧丢弃、不再重复触发 onTerminate", async () => {
    const h = createHarness();
    authed(h);
    const id = h.consumer.allocId();
    await sendReq(h.consumer, id);
    h.consumer.terminal(id);
    raw(h.tc, FRAME_TYPE.RESP_CHUNK, { id, seq: 0 }, bytes(4));
    await settle();
    expect(h.consumerEvents.frames.length).toBe(0);
    expect(h.consumer.stats().terminalDropped).toBe(1);
    const count = h.consumerEvents.terminates.filter((t) => t.id === id).length;
    h.consumer.terminal(id); // 幂等
    expect(h.consumerEvents.terminates.filter((t) => t.id === id).length).toBe(count);
  });

  it("peer 断开：全部在途 id 以 disconnected 终结 + onDisconnect；计时器停摆", async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({ consumer: { idleTimeoutMs: 1000 } });
      authed(h);
      const id1 = h.consumer.allocId();
      const id2 = h.consumer.allocId();
      await sendReq(h.consumer, id1);
      await sendReq(h.consumer, id2);

      h.tc.close("peer-gone");
      expect(h.consumerEvents.disconnects).toEqual(["peer-gone"]);
      const terminated = h.consumerEvents.terminates.filter((t) => t.cause.source === "disconnected");
      expect(terminated.map((t) => t.id).sort()).toEqual([id1, id2].sort());
      expect(terminated.every((t) => t.cause.source === "disconnected" && t.cause.reason === "peer-gone")).toBe(true);
      // provider 侧同样全量终结
      expect(h.providerEvents.terminates.filter((t) => t.cause.source === "disconnected").length).toBe(2);
      // 关闭后不再触发空闲计时，也不重复终结
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.consumerEvents.idles).toEqual([]);
      expect(h.consumerEvents.terminates.length).toBe(2);
      h.tc.close("again");
      expect(h.consumerEvents.terminates.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WireSession 空闲计时", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("consumer：窗口内无帧触发回调；PING 重置窗口", async () => {
    const h = createHarness({ consumer: { idleTimeoutMs: 1000 } });
    authed(h);
    const id = h.consumer.allocId();
    await sendReq(h.consumer, id);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.consumerEvents.idles).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.consumerEvents.idles).toEqual([id]);

    // PING 重置：半程收到 PING 后再走满整窗才触发
    const id2 = h.consumer.allocId();
    await sendReq(h.consumer, id2);
    await vi.advanceTimersByTimeAsync(500);
    await h.provider.send(FRAME_TYPE.PING, { id: id2 });
    await vi.advanceTimersByTimeAsync(999);
    expect(h.consumerEvents.idles).toEqual([id]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.consumerEvents.idles).toEqual([id, id2]);

    // 上层本地终结后计时停摆
    const id3 = h.consumer.allocId();
    await sendReq(h.consumer, id3);
    h.consumer.terminal(id3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.consumerEvents.idles).toEqual([id, id2]);
  });

  it("consumer 空闲后上层发 ABORT/清理（本地动作）仍可用，迟到帧丢弃", async () => {
    const h = createHarness({ consumer: { idleTimeoutMs: 1000 } });
    authed(h);
    const id = h.consumer.allocId();
    await sendReq(h.consumer, id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.consumerEvents.idles).toEqual([id]);
    await h.consumer.send(FRAME_TYPE.ABORT, { id }); // 使用方本地终结动作
    h.consumer.terminal(id);
    raw(h.tc, FRAME_TYPE.RESP_CHUNK, { id, seq: 0 }, bytes(2));
    await vi.advanceTimersByTimeAsync(10);
    expect(h.consumer.stats().terminalDropped).toBe(1);
  });

  it("provider：未挂起时照常空闲触发，可回送 ERROR(idle_timeout)", async () => {
    const h = createHarness({ provider: { idleTimeoutMs: 1000 } });
    authed(h);
    const id = h.consumer.allocId();
    await sendReq(h.consumer, id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.providerEvents.idles).toEqual([id]);
    await h.provider.send(FRAME_TYPE.ERROR, { id, code: "idle_timeout", message: "request idle timeout" });
    await vi.advanceTimersByTimeAsync(10);
    const errs = h.consumerEvents.frames.filter((f) => f.type === FRAME_TYPE.ERROR);
    expect(errs.length).toBe(1);
    expect((errs[0]!.header as unknown as ErrorHeader).code).toBe("idle_timeout");
  });

  it("provider 首字节等待期豁免：挂起后不自杀，首个 RESP_META 恢复计时", async () => {
    const h = createHarness({ provider: { idleTimeoutMs: 1000 } });
    authed(h);
    const id = h.consumer.allocId();
    await sendReq(h.consumer, id);
    h.provider.suspendProviderIdle(id);

    await vi.advanceTimersByTimeAsync(10_000); // 远超窗口：不触发
    expect(h.providerEvents.idles).toEqual([]);
    await h.provider.send(FRAME_TYPE.PING, { id }); // 挂起期 PING 出站不恢复计时
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.providerEvents.idles).toEqual([]);

    await h.provider.send(FRAME_TYPE.RESP_META, { id, status: 200, contentType: "application/json" }); // 首字节：恢复
    await vi.advanceTimersByTimeAsync(999);
    expect(h.providerEvents.idles).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.providerEvents.idles).toEqual([id]);
  });
});

describe("WireSession 方向与门控", () => {
  it("consumer 侧反向帧（c2p 帧入站）静默计数、不回帧", async () => {
    const h = createHarness();
    authed(h);
    const id = h.consumer.allocId();
    await sendReq(h.consumer, id); // 登记 id
    const spy = spyOn(h.tp); // 登记于 setup 流量之后：此后使用方不应发出任何字节
    raw(h.tc, FRAME_TYPE.AUTH, { v: 1, keys: ["sk-aifly-abcdefgh"] });
    raw(h.tc, FRAME_TYPE.REQ, reqHeader("evil-req-000000000000000a"));
    raw(h.tc, FRAME_TYPE.REQ_BODY, { id, seq: 0, end: true });
    raw(h.tc, FRAME_TYPE.DATA_UP, { v: 1, id, seq: 0 });
    raw(h.tc, FRAME_TYPE.ABORT, { id });
    await settle();
    expect(h.consumer.stats().directionDropped).toBe(5);
    expect(h.consumerEvents.frames.length).toBe(0);
    expect(spy.filter((f) => f.kind === "frame")).toEqual([]);
  });

  it("provider 侧反向帧（p2c 帧入站）回敬 protocol_error、其它请求不受影响", async () => {
    const h = createHarness();
    authed(h);
    const spy = spyOn(h.tc);
    const id = "dir00000000000000000000000b";
    raw(h.tp, FRAME_TYPE.REQ, reqHeader(id)); // 先登记 id，使违规帧可定位
    await settle();
    const violations: Array<[number, Record<string, unknown>]> = [
      [FRAME_TYPE.AUTH_OK, minimalAuthOk()],
      [FRAME_TYPE.AUTH_ERR, { v: 1, code: "key_all_invalid" }],
      [FRAME_TYPE.RESP_META, { id, status: 200, contentType: "a" }],
      [FRAME_TYPE.RESP_CHUNK, { id, seq: 0 }],
      [FRAME_TYPE.RESP_END, { id }],
      [FRAME_TYPE.ERROR, { id, code: "internal", message: "x" }],
      [FRAME_TYPE.PING, { id }],
      [FRAME_TYPE.DATA_DOWN, { v: 1, id, seq: 0 }],
    ];
    for (const [type, header] of violations) raw(h.tp, type, header);
    await settle();
    expect(h.provider.stats().directionDropped).toBe(8);
    const errs = errorFrames(spy);
    expect(errs.length).toBe(8);
    expect(errs.every((e) => e.code === "protocol_error")).toBe(true);
    expect(errs.filter((e) => e.id === id).length).toBe(6); // 带 id 的 6 帧（无 id 帧 ERROR 不带 id）
    expect(h.providerEvents.terminates.some((t) => t.id === id && t.cause.source === "local")).toBe(true);
    // 连接与其它请求不受影响
    raw(h.tp, FRAME_TYPE.REQ, reqHeader("other0000000000000000000000c"));
    await settle();
    const reqs = h.providerEvents.frames.filter((f) => f.type === FRAME_TYPE.REQ);
    expect(reqs.map((f) => (f.header as ReqHeader).id)).toEqual([id, "other0000000000000000000000c"]);
  });

  it("CLOSE 双向均可入站（both 方向）", async () => {
    const h = createHarness();
    authed(h);
    const id = h.consumer.allocId();
    await sendReq(h.consumer, id);
    raw(h.tc, FRAME_TYPE.CLOSE, { id, code: 1001 }); // consumer 收到 CLOSE（provider 发出）
    await settle();
    expect(h.consumerEvents.frames.filter((f) => f.type === FRAME_TYPE.CLOSE).length).toBe(1);
    const id2 = "close2000000000000000000000d";
    raw(h.tp, FRAME_TYPE.REQ, reqHeader(id2));
    raw(h.tp, FRAME_TYPE.CLOSE, { id: id2 }); // provider 收到 CLOSE（consumer 发出）
    await settle();
    expect(h.providerEvents.frames.filter((f) => f.type === FRAME_TYPE.CLOSE).length).toBe(1);
  });

  it("provider 未 AUTH：非 AUTH 帧静默计数，累计超过 32 帧断连（含方向违规帧）", async () => {
    const h = createHarness(); // 不 markAuthed
    for (let i = 0; i < 32; i++) {
      raw(h.tp, FRAME_TYPE.PING, { id: `pre${i}` }); // PING 为 p2c：同时验证方向违规按未授权计数
    }
    await settle();
    expect(h.provider.stats().unauthDropped).toBe(32);
    expect(h.providerEvents.unauth).toEqual([]);
    expect(h.provider.dead).toBe(false);

    raw(h.tp, FRAME_TYPE.PING, { id: "pre33" });
    await settle();
    expect(h.providerEvents.unauth).toEqual([33]);
    expect(h.provider.dead).toBe(true);
    expect(h.tc.closed).toBe(true);
    // 断连时在途请求（无）——AUTH 帧本身此前应照常交付：
  });

  it("未 AUTH 时 AUTH 帧照常交付（不被计数）", async () => {
    const h = createHarness();
    raw(h.tp, FRAME_TYPE.AUTH, { v: 1, keys: ["sk-aifly-aaaaaaaa", "sk-aifly-bbbbbbbb"] });
    await settle();
    expect(h.providerEvents.frames.length).toBe(1);
    expect(h.provider.stats().unauthDropped).toBe(0);
  });

  it("consumer：未发出 AUTH 前收 AUTH_OK 静默丢弃；发出后放行；authed 后 refresh 照常", async () => {
    const h = createHarness();
    await h.provider.send(FRAME_TYPE.AUTH_OK, minimalAuthOk());
    await settle();
    expect(h.consumer.stats().unauthDropped).toBe(1);
    expect(h.consumerEvents.frames.length).toBe(0);

    await h.consumer.send(FRAME_TYPE.AUTH, { v: 1, keys: ["sk-aifly-" + "a".repeat(52)] });
    await h.provider.send(FRAME_TYPE.AUTH_OK, minimalAuthOk());
    await settle();
    expect(h.consumer.stats().unauthDropped).toBe(1);
    expect(h.consumerEvents.frames.length).toBe(1);

    h.consumer.markAuthed();
    await h.provider.send(FRAME_TYPE.AUTH_OK, { ...minimalAuthOk(), refresh: true });
    await settle();
    expect(h.consumerEvents.frames.length).toBe(2);
  });
});

describe("WireSession 重组上限与 schema 违例", () => {
  it("REQ 声明正文超限：立即 body_too_large、不交付、不毒化", async () => {
    const h = createHarness({ provider: { reassemblyLimitBytes: 64 } });
    authed(h);
    const spy = spyOn(h.tc);
    raw(h.tp, FRAME_TYPE.REQ, reqHeader("big1000000000000000000000e", { bodyLen: 100 }));
    await settle();
    expect(h.providerEvents.frames.length).toBe(0);
    expect(errorFrames(spy)).toEqual([expect.objectContaining({ id: "big1000000000000000000000e", code: "body_too_large" })]);
    expect(h.providerEvents.terminates.some((t) => t.id === "big1000000000000000000000e" && t.cause.source === "body-too-large")).toBe(true);
    expect(h.provider.poisoned).toBe(false);
    // 连接继续服务其它请求
    raw(h.tp, FRAME_TYPE.REQ, reqHeader("ok20000000000000000000000f"));
    await settle();
    expect(h.providerEvents.frames.filter((f) => f.type === FRAME_TYPE.REQ).length).toBe(1);
  });

  it("REQ_BODY 累计超限：终结该请求并丢弃剩余分片，连接不毒化", async () => {
    const h = createHarness({ provider: { reassemblyLimitBytes: 64 } });
    authed(h);
    const spy = spyOn(h.tc);
    const id = "big3000000000000000000010";
    // 声明 bodyLen 在限内（入口检查通过），实际分片累计超限：由重组计数兜底。
    raw(h.tp, FRAME_TYPE.REQ, reqHeader(id, { bodyLen: 10 }));
    raw(h.tp, FRAME_TYPE.REQ_BODY, { id, seq: 0, end: false }, bytes(60));
    await settle();
    expect(h.providerEvents.frames.length).toBe(2);
    raw(h.tp, FRAME_TYPE.REQ_BODY, { id, seq: 1, end: true }, bytes(60)); // 120 > 64
    await settle();
    expect(h.providerEvents.frames.length).toBe(2); // seq 1 未交付
    expect(errorFrames(spy)).toEqual([expect.objectContaining({ id, code: "body_too_large" })]);
    raw(h.tp, FRAME_TYPE.REQ_BODY, { id, seq: 2, end: true }, bytes(1));
    await settle();
    expect(h.provider.stats().terminalDropped).toBe(1);
    expect(h.provider.poisoned).toBe(false);
  });

  it("REQ schema 违例：forbidden_method / forbidden_header / protocol_error 自动回敬", async () => {
    const h = createHarness();
    authed(h);
    const spy = spyOn(h.tc);
    raw(h.tp, FRAME_TYPE.REQ, reqHeader("m100000000000000000000001", { method: "TRACE" }));
    raw(h.tp, FRAME_TYPE.REQ, { ...reqHeader("m200000000000000000000002"), headers: { authorization: "Bearer x" } });
    raw(h.tp, FRAME_TYPE.REQ, { ...reqHeader("m300000000000000000000003"), unknownField: 1 });
    await settle();
    const errs = errorFrames(spy);
    expect(errs.map((e) => [e.id, e.code])).toEqual([
      ["m100000000000000000000001", "forbidden_method"],
      ["m200000000000000000000002", "forbidden_header"],
      ["m300000000000000000000003", "protocol_error"],
    ]);
    expect(h.providerEvents.frames.length).toBe(0);
    expect(h.provider.stats().schemaDropped).toBe(3);
  });

  it("consumer 收到畸形响应帧：静默计数、不回帧", async () => {
    const h = createHarness();
    authed(h);
    const id = h.consumer.allocId();
    await sendReq(h.consumer, id);
    const spy = spyOn(h.tp); // setup 之后：使用方不应回任何帧
    raw(h.tc, FRAME_TYPE.RESP_META, { id, status: 999, contentType: "a" }); // status 越界
    raw(h.tc, FRAME_TYPE.RESP_CHUNK, { id, seq: 0, extra: 1 }); // 未知字段
    await settle();
    expect(h.consumer.stats().schemaDropped).toBe(2);
    expect(h.consumerEvents.frames.length).toBe(0);
    expect(spy.filter((f) => f.kind === "frame")).toEqual([]);
  });

  it("重复 REQ（同 id）静默丢弃", async () => {
    const h = createHarness();
    authed(h);
    const id = "dup00000000000000000000011";
    raw(h.tp, FRAME_TYPE.REQ, reqHeader(id));
    raw(h.tp, FRAME_TYPE.REQ, reqHeader(id));
    await settle();
    expect(h.providerEvents.frames.length).toBe(1);
    expect(h.provider.stats().unknownIdDropped).toBe(1);
  });

  it("未知 id 的续帧静默丢弃（不回帧、不放大流量）", async () => {
    const h = createHarness();
    authed(h);
    const spyP = spyOn(h.tc); // provider 是否回帧
    const spyC = spyOn(h.tp); // consumer 是否回帧
    raw(h.tp, FRAME_TYPE.REQ_BODY, { id: "ghost000000000000000000012", seq: 0, end: true }, bytes(4));
    raw(h.tc, FRAME_TYPE.RESP_CHUNK, { id: "ghost000000000000000000012", seq: 0 }, bytes(4));
    await settle();
    expect(h.provider.stats().unknownIdDropped).toBe(1);
    expect(h.consumer.stats().unknownIdDropped).toBe(1);
    // 不回帧、不放大流量：双侧零 ERROR 回帧、零交付（注入帧本身除外）。
    expect(errorFrames(spyP)).toEqual([]);
    expect(errorFrames(spyC)).toEqual([]);
    expect(h.providerEvents.frames.length + h.consumerEvents.frames.length).toBe(0);
  });
});

describe("WireSession envelope 标记处置", () => {
  it("unknown-version：provider 回 protocol_version（无 id）、consumer 静默计数", async () => {
    const h = createHarness();
    authed(h);
    const spy = spyOn(h.tc);
    h.tp.deliverRaw(futureVersionFrame());
    await settle();
    expect(h.provider.stats().unknownVersionDropped).toBe(1);
    expect(errorFrames(spy)).toEqual([expect.objectContaining({ code: "protocol_version" })]);

    h.tc.deliverRaw(futureVersionFrame());
    await settle();
    expect(h.consumer.stats().unknownVersionDropped).toBe(1);
    expect(h.tp.closed).toBe(false);
    // consumer 不回帧
    const spyP = spyOn(h.tp);
    h.tc.deliverRaw(futureVersionFrame());
    await settle();
    expect(spyP.filter((f) => f.kind === "frame")).toEqual([]);
  });

  it("未知帧类型：记录忽略、不回帧、后续帧正常处理（前向兼容）", async () => {
    const h = createHarness();
    authed(h);
    const spy = spyOn(h.tc);
    h.tp.deliverRaw(unknownTypeFrame(0x55));
    h.tp.deliverRaw(unknownTypeFrame(0x0f));
    await settle();
    expect(h.provider.stats().unknownTypeIgnored).toBe(2);
    expect(spy.filter((f) => f.kind === "frame")).toEqual([]);
    raw(h.tp, FRAME_TYPE.REQ, reqHeader("after-unknown-0000000000013"));
    await settle();
    expect(h.providerEvents.frames.filter((f) => f.type === FRAME_TYPE.REQ).length).toBe(1);
  });

  it("畸形帧（JSON 非法）静默计数、不回帧", async () => {
    const h = createHarness();
    authed(h);
    const spy = spyOn(h.tc);
    h.tp.deliverRaw(malformedFrame());
    await settle();
    expect(h.provider.stats().malformedDropped).toBe(1);
    expect(spy.filter((f) => f.kind === "frame")).toEqual([]);
  });

  it("非 aifly envelope 静默蒸发：session 层零副作用", async () => {
    const h = createHarness();
    authed(h);
    h.tp.deliverRaw(ENC.encode("someone-elses-envelope-payload"));
    h.tc.deliverRaw(ENC.encode("dweb1-hello"));
    await settle();
    const p = h.provider.stats();
    const c = h.consumer.stats();
    expect(p.malformedDropped + p.unknownTypeIgnored + p.unknownVersionDropped + p.unauthDropped).toBe(0);
    expect(c.malformedDropped + c.unknownTypeIgnored + c.unknownVersionDropped + c.unauthDropped).toBe(0);
    expect(h.provider.dead).toBe(false);
  });
});

describe("WireSession request-id", () => {
  it("allocId：26 字符 z32、批量唯一（不复用基础）", () => {
    const { a } = createLoopbackPair();
    const session = new WireSession({ role: "consumer", transport: a });
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const id = session.allocId();
      expect(id.length).toBe(26);
      seen.add(id);
    }
    expect(seen.size).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// AUTH_OK 二阶段目录投影（hooks-lifecycle v2：帧级宽松 → detail 严格复核）
// ---------------------------------------------------------------------------

describe("AUTH_OK 二阶段目录投影", () => {
  const MASK = "\u25cf";

  function authOkWithDetail(detail: unknown): Record<string, unknown> {
    return {
      v: 1,
      alias: "box",
      relayUrls: ["https://relay.example/announce"],
      groups: [
        {
          keyId: "k1",
          group: "g1",
          limits: {},
          services: [
            { serviceId: "s1", name: "api", match: [{ type: "exact", value: "api.example.com" }], defaultPort: 11434, ...(detail === undefined ? {} : { detail }) },
          ],
        },
      ],
    };
  }

  /** v1 时期 detail 形状（rewrite.headerSet——v2 已退役）。 */
  const v1Detail = {
    upstream: "https://api.upstream/v1",
    match: [],
    rewrite: { host: "h", prefix: "/p", headerSet: [{ name: "authorization", value: MASK }] },
  };

  /** v2 合法 detail（掩码位 ●）。 */
  const v2Detail = {
    upstream: "https://api.upstream/v1",
    match: [],
    rewrite: {},
    auth: { secret: MASK },
    headers: { set: { "x-a": MASK, "x-literal": "keep" } },
    request: { script: MASK },
    response: { script: MASK },
  };

  interface CatalogHarness {
    consumer: WireSession;
    provider: WireSession;
    ta: LoopbackTransport; // consumer 侧传输（注入伪造帧用）
    tb: LoopbackTransport; // provider 侧传输
    events: EventLog;
    catalogErrors: Array<{ providerId: string; message: string }>;
  }

  function createCatalogHarness(peerEndpointId?: string): CatalogHarness {
    const { a, b } = createLoopbackPair();
    const events = makeEvents();
    const catalogErrors: CatalogHarness["catalogErrors"] = [];
    const consumer = new WireSession({
      role: "consumer",
      transport: a,
      ...(peerEndpointId !== undefined ? { peerEndpointId } : {}),
      hooks: {
        ...hooksOf(events),
        onCatalogError: (providerId, message) => catalogErrors.push({ providerId, message }),
      },
    });
    const provider = new WireSession({ role: "provider", transport: b, hooks: hooksOf(makeEvents()) });
    return { consumer, provider, ta: a, tb: b, events, catalogErrors };
  }

  it("detail 不合 v2：帧照常交付（catalogError 标注）、onCatalogError 携对端身份、不经 schemaDropped", async () => {
    const h = createCatalogHarness("prov-ep-z32-1");
    await h.consumer.send(FRAME_TYPE.AUTH, { v: 1, keys: ["sk-aifly-" + "a".repeat(52)] });
    await h.provider.send(FRAME_TYPE.AUTH_OK, authOkWithDetail(v1Detail));
    await settle();
    const stats = h.consumer.stats();
    expect(stats.schemaDropped).toBe(0); // 不触发普通帧丢弃路径
    expect(stats.catalogDropped).toBe(1);
    expect(h.catalogErrors).toEqual([
      { providerId: "prov-ep-z32-1", message: "provider catalog detail failed validation (provider/consumer version mismatch?)" },
    ]);
    const frames = h.events.frames.filter((f) => f.type === FRAME_TYPE.AUTH_OK);
    expect(frames).toHaveLength(1); // 帧本身交付（上层完成 AUTH 记账，会话保持 authed）
    expect((frames[0] as { catalogError?: string }).catalogError).toBeDefined();
    // 连接继续可用：后续正常帧照常处理
    await h.provider.send(FRAME_TYPE.AUTH_OK, authOkWithDetail(v2Detail));
    await settle();
    expect(h.consumer.stats().catalogDropped).toBe(1); // 成功同步不计数
    expect(h.events.frames.filter((f) => f.type === FRAME_TYPE.AUTH_OK)).toHaveLength(2);
  });

  it("detail 非对象垃圾同样归目录失败（不毒化、不断连）", async () => {
    const h = createCatalogHarness("prov-ep");
    await h.consumer.send(FRAME_TYPE.AUTH, { v: 1, keys: ["sk-aifly-" + "a".repeat(52)] });
    await h.provider.send(FRAME_TYPE.AUTH_OK, authOkWithDetail(42));
    await settle();
    expect(h.consumer.stats().catalogDropped).toBe(1);
    expect(h.consumer.poisoned).toBe(false);
    expect(h.consumer.dead).toBe(false);
  });

  it("无 detail 的条目不受二阶段影响（合法目录照常交付）", async () => {
    const h = createCatalogHarness("prov-ep");
    await h.consumer.send(FRAME_TYPE.AUTH, { v: 1, keys: ["sk-aifly-" + "a".repeat(52)] });
    await h.provider.send(FRAME_TYPE.AUTH_OK, authOkWithDetail(undefined));
    await settle();
    expect(h.consumer.stats().catalogDropped).toBe(0);
    expect(h.catalogErrors).toEqual([]);
    expect(h.events.frames.filter((f) => f.type === FRAME_TYPE.AUTH_OK)).toHaveLength(1);
  });

  it("未配置 peerEndpointId 时 providerId 为空串（对端身份未知）", async () => {
    const h = createCatalogHarness();
    await h.consumer.send(FRAME_TYPE.AUTH, { v: 1, keys: ["sk-aifly-" + "a".repeat(52)] });
    await h.provider.send(FRAME_TYPE.AUTH_OK, authOkWithDetail(v1Detail));
    await settle();
    expect(h.catalogErrors.map((e) => e.providerId)).toEqual([""]);
  });

  it("其它帧 schema 失败仍走既有丢弃计数（二阶段只管 AUTH_OK detail）", async () => {
    const h = createCatalogHarness("prov-ep");
    h.consumer.markAuthed();
    h.provider.markAuthed();
    const id = h.consumer.allocId();
    await h.consumer.send(FRAME_TYPE.REQ, reqHeader(id));
    raw(h.ta, FRAME_TYPE.RESP_META, { id, status: 999, contentType: "a" }); // status 越界 → consumer 入站
    await settle();
    expect(h.consumer.stats().schemaDropped).toBe(1);
    expect(h.consumer.stats().catalogDropped).toBe(0);
    expect(h.catalogErrors).toEqual([]);
  });
});
