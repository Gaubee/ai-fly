// aifly1 envelope 编解码：`"aifly1"(6B) | type(1B) | jsonLen(u16 BE) | json(UTF-8)
// | body(剩余字节)`（design A3）。
// 正交意图：
// - 纯结构层：只管字节布局与长度上限，不做 schema 校验（frames.ts）、不做会话语义
//   （mux.ts）；
// - 混流共存：非 "aifly" 家族的 envelope 一律返回 null（静默忽略，同一 fabric 可并存
//   其它应用）；"aifly" 家族但版本位非 '1' 返回 unknown-version 标记（可回送
//   protocol_version）；版本匹配但类型未知返回 unknown-type 标记（记录并忽略）；
// - 版本的唯一权威是 magic 内嵌的版本位（aifly1 = v1）；JSON 头中的 v 字段（≥1 的
//   冗余版本标记）若存在且 ≠1，同样按 unknown-version 上报；
// - encode 是本地断言（超限抛 WireEncodeError，属编程/配置错误），decode 是远端数据
//   分类（畸形返回 malformed 标记，由 mux 决定处置）。

import { FRAME_TYPE_NAME, isKnownFrameType } from "./frames.ts";

export const WIRE_MAGIC_PREFIX = "aifly"; // 家族前缀（版本位前一字节起）
export const WIRE_MAGIC = "aifly1"; // 当前协议版本（内嵌版本位 '1'）
export const PROTOCOL_VERSION = 1;

/** 会话层帧上限（fabric MAX_FRAME 同值；含 9 字节本协议帧头）。 */
export const MAX_FRAME_BYTES = 1 << 20; // 1 MiB
/** JSON 头结构上限（spec「帧资源上限」）。 */
export const MAX_JSON_HEADER_BYTES = 16 * 1024;
/** 正文分片默认上限（队头阻塞实证 → 远小于帧上限）。 */
export const DEFAULT_BODY_CHUNK_BYTES = 256 * 1024;
/** 正文分片可配置上限的硬顶（spec：MUST ≤ 960 KiB）。 */
export const MAX_CONFIGURABLE_BODY_CHUNK_BYTES = 960 * 1024;
/** 最小完整帧：magic(6) + type(1) + jsonLen(2)。 */
export const MIN_ENVELOPE_BYTES = 9;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const MAGIC_PREFIX_BYTES = TEXT_ENCODER.encode(WIRE_MAGIC_PREFIX);
const MAGIC_BYTES = TEXT_ENCODER.encode(WIRE_MAGIC);
const EMPTY_BODY = new Uint8Array(0);

/** 本地编码断言失败（编程 / 配置错误，非对端可观测事件）。 */
export class WireEncodeError extends Error {
  readonly code:
    | "json_header_too_large"
    | "body_chunk_too_large"
    | "frame_too_large"
    | "invalid_chunk_config"
    | "unknown_frame_type";

  constructor(
    code: WireEncodeError["code"],
    message: string,
  ) {
    super(message);
    this.name = "WireEncodeError";
    this.code = code;
  }
}

export interface EncodableFrame {
  type: number;
  header: object;
  /** 允许显式 undefined（缺省即空正文）。 */
  body?: Uint8Array | undefined;
}

export interface EncodeOptions {
  /** 正文分片上限（默认 256 KiB；MUST ≤ 960 KiB）。 */
  bodyChunkLimitBytes?: number;
}

function assertChunkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_CONFIGURABLE_BODY_CHUNK_BYTES) {
    throw new WireEncodeError(
      "invalid_chunk_config",
      `body chunk limit must be an integer in (0, ${MAX_CONFIGURABLE_BODY_CHUNK_BYTES}], got ${limit}`,
    );
  }
}

/** 编码单帧。断言：JSON 头 ≤16KiB、正文 ≤ 分片上限、整帧 ≤1MiB。 */
export function encodeFrame(frame: EncodableFrame, opts: EncodeOptions = {}): Uint8Array {
  const chunkLimit = opts.bodyChunkLimitBytes ?? DEFAULT_BODY_CHUNK_BYTES;
  assertChunkLimit(chunkLimit);
  if (!isKnownFrameType(frame.type)) {
    throw new WireEncodeError(
      "unknown_frame_type",
      `cannot encode unknown frame type 0x${frame.type.toString(16)}`,
    );
  }
  const headerBytes = TEXT_ENCODER.encode(JSON.stringify(frame.header));
  if (headerBytes.length > MAX_JSON_HEADER_BYTES) {
    throw new WireEncodeError(
      "json_header_too_large",
      `json header is ${headerBytes.length} bytes (max ${MAX_JSON_HEADER_BYTES})`,
    );
  }
  const body = frame.body ?? EMPTY_BODY;
  if (body.length > chunkLimit) {
    throw new WireEncodeError(
      "body_chunk_too_large",
      `body is ${body.length} bytes (chunk limit ${chunkLimit})`,
    );
  }
  const total = MIN_ENVELOPE_BYTES + headerBytes.length + body.length;
  if (total > MAX_FRAME_BYTES) {
    throw new WireEncodeError("frame_too_large", `frame is ${total} bytes (max ${MAX_FRAME_BYTES})`);
  }
  const out = new Uint8Array(total);
  out.set(MAGIC_BYTES, 0);
  out[6] = frame.type;
  out[7] = (headerBytes.length >> 8) & 0xff; // u16 大端
  out[8] = headerBytes.length & 0xff;
  out.set(headerBytes, 9);
  out.set(body, 9 + headerBytes.length);
  return out;
}

/** decode 结果：frame = 正常帧；标记（version/type/malformed）由 mux 按策略处置。 */
export type DecodedFrame =
  | { kind: "frame"; type: number; header: Record<string, unknown>; body: Uint8Array }
  | { kind: "unknown-version" }
  | { kind: "unknown-type"; type: number }
  | { kind: "malformed"; reason: string };

/**
 * 解码单帧（每条 fabric envelope 即一个完整 buffer）。
 * - 非 "aifly" 家族 → null（静默忽略，混流共存）；
 * - 家族匹配但版本位非 '1'、或 JSON 头 v 字段 ≠1 → unknown-version（可回送
 *   protocol_version ERROR）；
 * - 版本匹配但类型号未定义 → unknown-type（记录并忽略，不影响后续帧）；
 * - 结构损坏（截断 / JSON 非法 / 头非对象 / 超长）→ malformed。
 */
export function decodeFrame(buffer: Uint8Array): DecodedFrame | null {
  if (buffer.length < MAGIC_PREFIX_BYTES.length) return null;
  for (let i = 0; i < MAGIC_PREFIX_BYTES.length; i++) {
    if (buffer[i] !== MAGIC_PREFIX_BYTES[i]) return null;
  }
  if (buffer.length > MAX_FRAME_BYTES) {
    return { kind: "malformed", reason: "frame_too_large" }; // 防御（fabric 层已挡）
  }
  if (buffer.length >= 6 && buffer[5] !== MAGIC_BYTES[5]) {
    // 版本位先于长度检查：残缺的未来版本帧同样按版本不识别归类。
    return { kind: "unknown-version" };
  }
  if (buffer.length < MIN_ENVELOPE_BYTES) {
    return { kind: "malformed", reason: "truncated_header" };
  }
  const type = buffer[6]!;
  const jsonLen = (buffer[7]! << 8) | buffer[8]!;
  if (jsonLen > MAX_JSON_HEADER_BYTES) {
    return { kind: "malformed", reason: "json_header_too_large" };
  }
  if (MIN_ENVELOPE_BYTES + jsonLen > buffer.length) {
    return { kind: "malformed", reason: "truncated_json" };
  }
  let header: unknown;
  try {
    header = JSON.parse(TEXT_DECODER.decode(buffer.subarray(9, 9 + jsonLen)));
  } catch {
    return { kind: "malformed", reason: "invalid_json" };
  }
  if (typeof header !== "object" || header === null || Array.isArray(header)) {
    return { kind: "malformed", reason: "header_not_object" };
  }
  const v = (header as Record<string, unknown>).v;
  if (v !== undefined && v !== 1) {
    return { kind: "unknown-version" };
  }
  if (!isKnownFrameType(type)) {
    return { kind: "unknown-type", type };
  }
  return {
    kind: "frame",
    type,
    header: header as Record<string, unknown>,
    body: buffer.subarray(9 + jsonLen),
  };
}

// ---------------------------------------------------------------------------
// 大正文拆分（REQ 内联 / REQ_BODY 续帧）
// ---------------------------------------------------------------------------

export interface BodyChunkPlan {
  seq: number;
  end: boolean;
  data: Uint8Array;
}

export interface BodySplitPlan {
  /** true = 正文整体内联于 REQ 帧（≤ 分片上限，含空正文）。 */
  firstInline: boolean;
  /** REQ 帧携带的内联正文（firstInline=false 时为空）。 */
  inlineBody: Uint8Array;
  /** REQ_BODY 续帧分片（firstInline=true 时为空数组；否则覆盖全部正文，seq 从 0 递增）。 */
  chunks: BodyChunkPlan[];
}

/**
 * 按 design A3「body 内联(≤分片上限)或空」拆分：超限正文的 REQ 帧体为空，
 * 全部字节经 REQ_BODY 分片承载；接收侧按 seq 从 0 重组（mux.ts 负责）。
 */
export function splitBody(
  body: Uint8Array,
  chunkLimitBytes: number = DEFAULT_BODY_CHUNK_BYTES,
): BodySplitPlan {
  assertChunkLimit(chunkLimitBytes);
  if (body.length <= chunkLimitBytes) {
    return { firstInline: true, inlineBody: body, chunks: [] };
  }
  const chunks: BodyChunkPlan[] = [];
  for (let off = 0; off < body.length; off += chunkLimitBytes) {
    const end = off + chunkLimitBytes >= body.length;
    chunks.push({
      seq: chunks.length,
      end,
      data: body.subarray(off, end ? body.length : off + chunkLimitBytes),
    });
  }
  return { firstInline: false, inlineBody: EMPTY_BODY, chunks };
}

/** 便于日志：类型号 → 名称（未知号返回 hex）。 */
export function frameTypeName(type: number): string {
  return FRAME_TYPE_NAME[type] ?? `0x${type.toString(16)}`;
}
