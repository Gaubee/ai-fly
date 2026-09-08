// codec 单测：往返（全帧型 × 正文尺寸）、字节布局、非 magic 静默忽略、
// unknown-version / unknown-type 标记、畸形帧、超限拒绝、splitBody 拆分。

import { describe, expect, it } from "vitest";
import {
  DEFAULT_BODY_CHUNK_BYTES,
  MAX_CONFIGURABLE_BODY_CHUNK_BYTES,
  MAX_JSON_HEADER_BYTES,
  WireEncodeError,
  decodeFrame,
  encodeFrame,
  splitBody,
} from "../../../src/wire/codec.ts";
import { FRAME_TYPE } from "../../../src/wire/frames.ts";

const ENC = new TextEncoder();

function bytes(n: number, fill = 0xab): Uint8Array {
  return Uint8Array.from({ length: n }, () => fill);
}

function hex(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/** 手工拼帧（绕过 encodeFrame 的类型/长度断言，用于畸形与标记用例）。 */
function craft(type: number, json: string, body = ""): Uint8Array {
  const jsonBytes = ENC.encode(json);
  const out = new Uint8Array(9 + jsonBytes.length + body.length);
  out.set(ENC.encode("aifly1"), 0);
  out[6] = type;
  out[7] = (jsonBytes.length >> 8) & 0xff;
  out[8] = jsonBytes.length & 0xff;
  out.set(jsonBytes, 9);
  out.set(ENC.encode(body), 9 + jsonBytes.length);
  return out;
}

describe("encodeFrame / decodeFrame roundtrip", () => {
  const samples: Array<{ type: number; header: object }> = [
    { type: FRAME_TYPE.AUTH, header: { v: 1, keys: ["sk-aifly-xyz"] } },
    { type: FRAME_TYPE.AUTH_OK, header: { v: 1, alias: "a", relayUrls: [], groups: [{ keyId: "k", group: "g", limits: {}, services: [] }] } },
    { type: FRAME_TYPE.REQ, header: { v: 1, id: "r1", serviceId: "s1", method: "GET", path: "/x", bodyLen: 0 } },
    { type: FRAME_TYPE.REQ_BODY, header: { id: "r1", seq: 3, end: true } },
    { type: FRAME_TYPE.RESP_META, header: { id: "r1", status: 200, contentType: "application/json" } },
    { type: FRAME_TYPE.RESP_CHUNK, header: { id: "r1", seq: 7 } },
    { type: FRAME_TYPE.RESP_END, header: { id: "r1" } },
    { type: FRAME_TYPE.ERROR, header: { id: "r1", code: "internal", message: "boom" } },
    { type: FRAME_TYPE.ABORT, header: { id: "r1" } },
    { type: FRAME_TYPE.PING, header: { id: "r1" } },
    { type: FRAME_TYPE.DATA_UP, header: { v: 1, id: "r1", seq: 1 } },
    { type: FRAME_TYPE.DATA_DOWN, header: { v: 1, id: "r1", seq: 2 } },
    { type: FRAME_TYPE.CLOSE, header: { id: "r1", code: 1000 } },
  ];

  it("roundtrips every frame type with empty/small/large bodies", () => {
    for (const sample of samples) {
      for (const bodySize of [0, 1, 1000]) {
        const body = bytes(bodySize);
        const wire = encodeFrame({ type: sample.type, header: sample.header, body });
        const decoded = decodeFrame(wire);
        expect(decoded).not.toBeNull();
        expect(decoded!.kind).toBe("frame");
        if (decoded!.kind === "frame") {
          expect(decoded!.type).toBe(sample.type);
          expect(decoded!.header).toEqual(sample.header);
          expect([...decoded!.body]).toEqual([...body]);
        }
      }
    }
  });

  it("wire layout: magic(6) | type(1) | jsonLen u16BE | json | body", () => {
    const header = { id: "abc" };
    const body = bytes(5, 0x11);
    const wire = encodeFrame({ type: FRAME_TYPE.PING, header, body });
    expect([...wire.subarray(0, 6)]).toEqual([...ENC.encode("aifly1")]);
    expect(wire[6]).toBe(FRAME_TYPE.PING);
    const jsonBytes = ENC.encode(JSON.stringify(header));
    expect(wire[7]).toBe((jsonBytes.length >> 8) & 0xff);
    expect(wire[8]).toBe(jsonBytes.length & 0xff);
    expect(wire.length).toBe(9 + jsonBytes.length + 5);
  });

  it("body optional defaults to empty; explicit undefined accepted", () => {
    const noBody = encodeFrame({ type: FRAME_TYPE.PING, header: { id: "x" } });
    const undefinedBody = encodeFrame({ type: FRAME_TYPE.PING, header: { id: "x" }, body: undefined });
    expect(noBody.length).toBe(9 + ENC.encode('{"id":"x"}').length);
    expect(undefinedBody.length).toBe(noBody.length);
  });
});

describe("decodeFrame 分类", () => {
  it("non-aifly envelopes -> null（混流共存）", () => {
    expect(decodeFrame(ENC.encode("hello world, not ours"))).toBeNull();
    expect(decodeFrame(new Uint8Array(0))).toBeNull();
    expect(decodeFrame(ENC.encode("dweb1-something"))).toBeNull();
    // 恰好 5 字节 "aifly"：家族前缀匹配但无版本位/帧头 —— 视为家族内残缺帧（malformed）。
    expect(decodeFrame(ENC.encode("aifly"))).toEqual({ kind: "malformed", reason: "truncated_header" });
  });

  it("aifly family with version digit != 1 -> unknown-version", () => {
    const v2 = new Uint8Array(11);
    v2.set(ENC.encode("aifly2"), 0);
    v2[6] = FRAME_TYPE.REQ;
    v2[7] = 0;
    v2[8] = 2;
    v2.set(ENC.encode("{}"), 9);
    expect(decodeFrame(v2)).toEqual({ kind: "unknown-version" });
    // 家族前缀 + 任意非 '1' 版本位（即使帧体残缺）同样按版本位判定。
    expect(decodeFrame(v2.subarray(0, 7))).toEqual({ kind: "unknown-version" });
  });

  it("JSON header v != 1 -> unknown-version（可回送 protocol_version）", () => {
    expect(decodeFrame(craft(FRAME_TYPE.REQ, '{"v":2,"id":"x"}'))).toEqual({ kind: "unknown-version" });
    expect(decodeFrame(craft(FRAME_TYPE.REQ, '{"v":"1"}'))).toEqual({ kind: "unknown-version" }); // 版本必须是数字 1
  });

  it("known version but unknown type -> unknown-type（忽略不终止）", () => {
    expect(decodeFrame(craft(0x7f, '{"v":1,"id":"x"}'))).toEqual({ kind: "unknown-type", type: 0x7f });
    // 未知类型帧之后的正常帧不受影响（解码器无连接状态，逐帧独立判定）。
    expect(decodeFrame(craft(FRAME_TYPE.PING, '{"id":"x"}'))?.kind).toBe("frame");
  });

  it("malformed: truncated header / truncated json / invalid json / non-object json / oversize json", () => {
    expect(decodeFrame(ENC.encode("aifly1"))).toEqual({ kind: "malformed", reason: "truncated_header" });
    const truncated = craft(FRAME_TYPE.REQ, '{"id":"x"}').subarray(0, 12);
    expect(decodeFrame(truncated)?.kind).toBe("malformed");
    expect(decodeFrame(craft(FRAME_TYPE.REQ, "{nope"))?.kind).toBe("malformed");
    expect(decodeFrame(craft(FRAME_TYPE.REQ, "[1,2]"))).toEqual({ kind: "malformed", reason: "header_not_object" });
    expect(decodeFrame(craft(FRAME_TYPE.REQ, "42"))).toEqual({ kind: "malformed", reason: "header_not_object" });
    expect(decodeFrame(craft(FRAME_TYPE.REQ, '"str"'))).toEqual({ kind: "malformed", reason: "header_not_object" });
    // jsonLen 声称 16385 > 16KiB 上限。
    const oversize = new Uint8Array(11);
    oversize.set(ENC.encode("aifly1"), 0);
    oversize[6] = FRAME_TYPE.REQ;
    oversize[7] = 0x40;
    oversize[8] = 0x01;
    oversize.set(ENC.encode("{}"), 9);
    expect(decodeFrame(oversize)).toEqual({ kind: "malformed", reason: "json_header_too_large" });
    // jsonLen 声称 16384（恰好上限）但 buffer 不足 → 截断。
    const shortJson = new Uint8Array(9);
    shortJson.set(ENC.encode("aifly1"), 0);
    shortJson[6] = FRAME_TYPE.REQ;
    shortJson[7] = 0x40;
    shortJson[8] = 0x00;
    expect(decodeFrame(shortJson)).toEqual({ kind: "malformed", reason: "truncated_json" });
  });
});

describe("encodeFrame 断言", () => {
  it("rejects json header > 16KiB", () => {
    const fat = { id: "x".repeat(MAX_JSON_HEADER_BYTES) };
    expect(() => encodeFrame({ type: FRAME_TYPE.PING, header: fat })).toThrowError(WireEncodeError);
    try {
      encodeFrame({ type: FRAME_TYPE.PING, header: fat });
      expect.unreachable();
    } catch (err) {
      expect((err as WireEncodeError).code).toBe("json_header_too_large");
    }
  });

  it("rejects body above chunk limit (default 256KiB; configurable up to 960KiB)", () => {
    try {
      encodeFrame({ type: FRAME_TYPE.REQ_BODY, header: { id: "x", seq: 0, end: false }, body: bytes(DEFAULT_BODY_CHUNK_BYTES + 1) });
      expect.unreachable();
    } catch (err) {
      expect((err as WireEncodeError).code).toBe("body_chunk_too_large");
    }
    const big = bytes(MAX_CONFIGURABLE_BODY_CHUNK_BYTES);
    expect(() => encodeFrame({ type: FRAME_TYPE.REQ_BODY, header: { id: "x", seq: 0, end: false }, body: big }, { bodyChunkLimitBytes: MAX_CONFIGURABLE_BODY_CHUNK_BYTES })).not.toThrow();
  });

  it("rejects invalid chunk limit configuration", () => {
    for (const badLimit of [0, -1, MAX_CONFIGURABLE_BODY_CHUNK_BYTES + 1, 1024.5]) {
      expect(() => encodeFrame({ type: FRAME_TYPE.PING, header: { id: "x" } }, { bodyChunkLimitBytes: badLimit })).toThrowError(WireEncodeError);
    }
  });

  it("rejects unknown frame type", () => {
    try {
      encodeFrame({ type: 0x7f, header: {} });
      expect.unreachable();
    } catch (err) {
      expect((err as WireEncodeError).code).toBe("unknown_frame_type");
    }
  });
});

describe("splitBody", () => {
  it("inline when body fits (including empty and exactly-at-limit)", () => {
    for (const size of [0, 1, DEFAULT_BODY_CHUNK_BYTES]) {
      const plan = splitBody(bytes(size));
      expect(plan.firstInline).toBe(true);
      expect(plan.inlineBody.length).toBe(size);
      expect(plan.chunks).toEqual([]);
    }
  });

  it("REQ carries no inline body when over limit; REQ_BODY chunks cover all bytes from seq 0", () => {
    const body = bytes(DEFAULT_BODY_CHUNK_BYTES + 1);
    const plan = splitBody(body);
    expect(plan.firstInline).toBe(false);
    expect(plan.inlineBody.length).toBe(0);
    expect(plan.chunks.length).toBe(2);
    expect(plan.chunks[0]).toMatchObject({ seq: 0, end: false });
    expect(plan.chunks[0]!.data.length).toBe(DEFAULT_BODY_CHUNK_BYTES);
    expect(plan.chunks[1]).toMatchObject({ seq: 1, end: true });
    expect(plan.chunks[1]!.data.length).toBe(1);
    const rejoined = plan.chunks.flatMap((c) => [...c.data]);
    expect(rejoined).toEqual([...body]);
  });

  it("respects custom limit and validates it", () => {
    const plan = splitBody(bytes(1000), 400);
    expect(plan.firstInline).toBe(false);
    expect(plan.chunks.map((c) => [c.seq, c.data.length, c.end])).toEqual([
      [0, 400, false],
      [1, 400, false],
      [2, 200, true],
    ]);
    expect(() => splitBody(bytes(10), MAX_CONFIGURABLE_BODY_CHUNK_BYTES + 1)).toThrowError(WireEncodeError);
  });

  it("exact multiples put end only on the last chunk", () => {
    const plan = splitBody(bytes(800), 400);
    expect(plan.chunks.length).toBe(2);
    expect(plan.chunks[1]!.end).toBe(true);
    expect(plan.chunks[0]!.end).toBe(false);
  });
});

describe("misc", () => {
  it("hex helper sanity (documents u16 BE expectations)", () => {
    expect(hex(0x0a)).toBe("0a");
    expect(hex(0xff)).toBe("ff");
  });
});
