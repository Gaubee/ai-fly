// aifly1 帧子协议的静态定义层：帧类型号（design A3）、各帧 JSON 头的 zod strict
// schema 与 TS 类型、稳定错误码全集、头部策略（凭据类拒绝 / WS 握手头放行 /
// 响应头白名单）与结构上限。
// 正交意图：
// - 本文件只做“形状”：纯数据与校验，无 IO、无编码、无会话状态；
// - 错误码全集以 spec「中止与错误语义」为唯一权威；key_invalid / key_revoked 仅作为
//   AUTH_OK.rejected 载荷码存在，不进 ERROR 帧码常量区；
// - schema 校验失败的语义分类（forbidden_method / forbidden_header / protocol_error）
//   由 classifySchemaFailure 依据原始输入判定，供 mux 层选择回送 ERROR 码；
// - 越界 method 字符串按 forbidden_method、非字符串按 protocol_error（spec REQ 条款），
//   因此分类不依赖 zod issue 内部结构，直接复查原始输入。

import { z } from "zod";

// ---------------------------------------------------------------------------
// 帧类型号（design A3；PAUSE/RESUME 留待 v2 分配，不预留号段）
// ---------------------------------------------------------------------------

export const FRAME_TYPE = {
  AUTH: 0x01,
  AUTH_OK: 0x02,
  AUTH_ERR: 0x03,
  REQ: 0x04,
  REQ_BODY: 0x05,
  RESP_META: 0x06,
  RESP_CHUNK: 0x07,
  RESP_END: 0x08,
  ERROR: 0x09,
  ABORT: 0x0a,
  PING: 0x0b,
  DATA_UP: 0x0c,
  DATA_DOWN: 0x0d,
  CLOSE: 0x0e,
} as const;

export type FrameTypeValue = (typeof FRAME_TYPE)[keyof typeof FRAME_TYPE];

/** 类型号 → 名称（日志与误用报错用）。 */
export const FRAME_TYPE_NAME: Readonly<Record<number, string>> = {
  [FRAME_TYPE.AUTH]: "AUTH",
  [FRAME_TYPE.AUTH_OK]: "AUTH_OK",
  [FRAME_TYPE.AUTH_ERR]: "AUTH_ERR",
  [FRAME_TYPE.REQ]: "REQ",
  [FRAME_TYPE.REQ_BODY]: "REQ_BODY",
  [FRAME_TYPE.RESP_META]: "RESP_META",
  [FRAME_TYPE.RESP_CHUNK]: "RESP_CHUNK",
  [FRAME_TYPE.RESP_END]: "RESP_END",
  [FRAME_TYPE.ERROR]: "ERROR",
  [FRAME_TYPE.ABORT]: "ABORT",
  [FRAME_TYPE.PING]: "PING",
  [FRAME_TYPE.DATA_UP]: "DATA_UP",
  [FRAME_TYPE.DATA_DOWN]: "DATA_DOWN",
  [FRAME_TYPE.CLOSE]: "CLOSE",
};

export function isKnownFrameType(type: number): type is FrameTypeValue {
  return type in FRAME_TYPE_NAME;
}

// ---------------------------------------------------------------------------
// 稳定错误码（spec「中止与错误语义」全集；顺序与 spec 行文一致）
// ---------------------------------------------------------------------------

export const ERROR_CODE = {
  aborted: "aborted",
  buffer_overflow: "buffer_overflow",
  idle_timeout: "idle_timeout",
  unauthorized: "unauthorized",
  key_all_invalid: "key_all_invalid",
  unknown_service: "unknown_service",
  path_not_offered: "path_not_offered",
  upstream_unreachable: "upstream_unreachable",
  upstream_status: "upstream_status",
  secret_missing: "secret_missing",
  body_too_large: "body_too_large",
  rate_limited: "rate_limited",
  quota_exceeded: "quota_exceeded",
  forbidden_method: "forbidden_method",
  forbidden_header: "forbidden_header",
  protocol_version: "protocol_version",
  protocol_seq: "protocol_seq",
  protocol_error: "protocol_error",
  internal: "internal",
} as const;

export type ErrorCodeValue = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

/**
 * 仅 AUTH_OK.rejected 载荷码（spec 明确：这两个码不是 ERROR 帧码）；
 * 归档注释锚点：key_invalid / key_revoked 不得加入 ERROR_CODE。
 */
export const REJECTED_CODE = {
  key_invalid: "key_invalid",
  key_revoked: "key_revoked",
} as const;

export type RejectedCodeValue = (typeof REJECTED_CODE)[keyof typeof REJECTED_CODE];

// ---------------------------------------------------------------------------
// 结构上限与头部策略
// ---------------------------------------------------------------------------

/** 帧资源上限（spec「帧资源上限」：path / headers 项数 / 键值 / JSON 头总长）。 */
export const STRUCT_LIMITS = {
  pathMaxBytes: 4 * 1024,
  headersMaxCount: 32,
  headerNameMaxBytes: 1024,
  headerValueMaxBytes: 8 * 1024,
  jsonHeaderMaxBytes: 16 * 1024,
} as const;

/** REQ.headers 禁止透传的凭据类 / 归属类头（双向零过桥；spec REQ 条款）。 */
export const FORBIDDEN_REQ_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-type",
]);

/** 允许透传的 WebSocket 握手头（非黑名单成员即放行，此处成文用于文档与测试对照）。 */
export const WS_HANDSHAKE_HEADER_NAMES = [
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
] as const;

/** RESP_META.headers 白名单子集（spec 响应下行条款）。 */
export const RESP_META_HEADER_WHITELIST: ReadonlySet<string> = new Set([
  "x-request-id",
  "retry-after",
  "sec-websocket-accept",
]);

/** HTTP 方法枚举（REQ.method；越界字符串 → forbidden_method，非字符串 → protocol_error）。 */
export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethodValue = (typeof HTTP_METHODS)[number];

// ---------------------------------------------------------------------------
// 基础构件
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder();

function byteLen(s: string): number {
  return TEXT_ENCODER.encode(s).length;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** 标识字段（z32 形态：request-id 26 字符 / serviceId 13 / keyId 同族；上限宽松防滥用）。 */
const Z_ID = z.string().min(1).max(128);

/** 分片序号：非负整数（缺断/重复由 mux 的期望序号判定，schema 不设上界）。 */
const Z_SEQ = z.number().int().min(0);

/** contentType 形态：任意字符串，字节长受单值上限约束（与头值同规）。 */
const Z_CONTENT_TYPE = z
  .string()
  .refine((s) => byteLen(s) <= STRUCT_LIMITS.headerValueMaxBytes, {
    message: `contentType exceeds ${STRUCT_LIMITS.headerValueMaxBytes} bytes`,
  });

// ---------------------------------------------------------------------------
// REQ.path 形态校验：单个 / 开头、无 scheme、非 // 与 /\ 开头、无 . 与 .. 段（可含查询串）
// ---------------------------------------------------------------------------

const REQ_PATH_SCHEMA = z.string().superRefine((p, ctx) => {
  const add = (message: string) => ctx.addIssue({ code: "custom", message, path: ["path"] });
  if (byteLen(p) > STRUCT_LIMITS.pathMaxBytes) {
    add(`path exceeds ${STRUCT_LIMITS.pathMaxBytes} bytes`);
    return;
  }
  if (!p.startsWith("/")) {
    add("path must start with a single '/'");
    return;
  }
  if (p.startsWith("//") || p.startsWith("/\\")) {
    add("path must not start with '//' or '/\\'");
    return;
  }
  const pathPart = p.split("?", 1)[0]!;
  if (pathPart.includes("://")) {
    // 查询串中的 scheme（如 ?next=http://x）不受限；路径段中含 scheme 一律拒绝。
    add("path must not contain a scheme");
    return;
  }
  for (const seg of pathPart.split("/").slice(1)) {
    if (seg === "." || seg === "..") {
      add("path must not contain '.' or '..' segments");
      return;
    }
  }
});

// ---------------------------------------------------------------------------
// REQ.headers / RESP_META.headers
// ---------------------------------------------------------------------------

const REQ_HEADERS_SCHEMA = z.record(z.string(), z.string()).superRefine((headers, ctx) => {
  const names = Object.keys(headers);
  if (names.length > STRUCT_LIMITS.headersMaxCount) {
    ctx.addIssue({
      code: "custom",
      message: `headers exceed ${STRUCT_LIMITS.headersMaxCount} entries`,
      path: ["headers"],
    });
  }
  for (const name of names) {
    const value = headers[name]!;
    if (FORBIDDEN_REQ_HEADER_NAMES.has(name)) {
      ctx.addIssue({ code: "custom", message: `forbidden header: ${name}`, path: ["headers", name] });
      continue;
    }
    if (name !== name.toLowerCase()) {
      ctx.addIssue({
        code: "custom",
        message: `header name not lowercase-normalized: ${name}`,
        path: ["headers", name],
      });
    }
    if (byteLen(name) > STRUCT_LIMITS.headerNameMaxBytes) {
      ctx.addIssue({ code: "custom", message: `header name exceeds ${STRUCT_LIMITS.headerNameMaxBytes} bytes`, path: ["headers", name] });
    }
    if (byteLen(value) > STRUCT_LIMITS.headerValueMaxBytes) {
      ctx.addIssue({ code: "custom", message: `header value exceeds ${STRUCT_LIMITS.headerValueMaxBytes} bytes`, path: ["headers", name] });
    }
  }
});

const RESP_META_HEADERS_SCHEMA = z.record(z.string(), z.string()).superRefine((headers, ctx) => {
  const names = Object.keys(headers);
  if (names.length > STRUCT_LIMITS.headersMaxCount) {
    ctx.addIssue({
      code: "custom",
      message: `headers exceed ${STRUCT_LIMITS.headersMaxCount} entries`,
      path: ["headers"],
    });
  }
  for (const name of names) {
    const value = headers[name]!;
    if (!RESP_META_HEADER_WHITELIST.has(name)) {
      ctx.addIssue({
        code: "custom",
        message: `response header not whitelisted: ${name}`,
        path: ["headers", name],
      });
      continue;
    }
    if (byteLen(value) > STRUCT_LIMITS.headerValueMaxBytes) {
      ctx.addIssue({ code: "custom", message: `header value exceeds ${STRUCT_LIMITS.headerValueMaxBytes} bytes`, path: ["headers", name] });
    }
  }
});

// ---------------------------------------------------------------------------
// 目录（AUTH_OK 载荷）子结构
// ---------------------------------------------------------------------------

/** match 展示集条目（exact / suffix / regex；纯展示元数据，运行时路由走 serviceId）。 */
export const SERVICE_MATCH_SCHEMA = z.strictObject({
  type: z.enum(["exact", "suffix", "regex"]),
  value: z.string().min(1).max(2048),
});

/** 服务完整配置的脱敏披露（$env 注入的头值仅显示 ●，变量名不显示）。 */
export const SERVICE_DETAIL_SCHEMA = z.strictObject({
  upstream: z.string().min(1).max(2048),
  match: z.array(SERVICE_MATCH_SCHEMA).max(64),
  rewrite: z.strictObject({
    host: z.string().min(1).max(2048).optional(),
    prefix: z.string().min(1).max(2048).optional(),
    headerSet: z
      .array(z.strictObject({ name: z.string().min(1).max(1024), value: z.string().max(256) }))
      .max(32)
      .optional(),
  }),
  /** 路径路由披露（M3-r7：prefix/pattern 双模式；forms 为 AI 层标注，可为空）。 */
  routes: z
    .array(
      z.strictObject({
        forms: z.array(z.enum(["openai-chat", "openai-responses", "anthropic"])).max(3),
        mode: z.enum(["prefix", "pattern"]).optional(),
        localPrefix: z.string().max(2048).optional(),
        upstreamPrefix: z.string().max(2048).optional(),
        matchPattern: z.string().max(2048).optional(),
        template: z.string().max(2048).optional(),
      }),
    )
    .max(4)
    .optional(),
});

export const SERVICE_ENTRY_SCHEMA = z.strictObject({
  serviceId: Z_ID,
  name: z.string().min(1).max(256),
  match: z.array(SERVICE_MATCH_SCHEMA).max(64),
  defaultPort: z.number().int().min(1).max(65535),
  detail: SERVICE_DETAIL_SCHEMA.optional(),
});

export const GROUP_ENTRY_SCHEMA = z.strictObject({
  keyId: Z_ID,
  group: z.string().min(1).max(256),
  limits: z.strictObject({
    maxConcurrency: z.number().int().min(1).optional(),
    dailyRequests: z.number().int().min(1).optional(),
  }),
  services: z.array(SERVICE_ENTRY_SCHEMA),
});

// ---------------------------------------------------------------------------
// 各帧 JSON 头 schema（strict：未知字段一律失败 → protocol_error 路径）
// ---------------------------------------------------------------------------

/** AUTH {v, keys[]}：钥环一次呈交（密钥格式细则归 §3 store，wire 层仅防明显垃圾）。 */
export const AUTH_HEADER_SCHEMA = z.strictObject({
  v: z.literal(1),
  keys: z.array(z.string().min(8).max(256)).min(1),
});

/**
 * AUTH_OK：目录全量载荷（初次授权与 refresh 推送同构；groups ≥1——全无效走 AUTH_ERR）。
 */
export const AUTH_OK_HEADER_SCHEMA = z.strictObject({
  v: z.literal(1),
  alias: z.string().min(1).max(256),
  relayUrls: z.array(z.string().min(1).max(2048)),
  groups: z.array(GROUP_ENTRY_SCHEMA).min(1),
  rejected: z
    .array(z.strictObject({ code: z.enum([REJECTED_CODE.key_invalid, REJECTED_CODE.key_revoked]) }))
    .max(64)
    .optional(),
  refresh: z.literal(true).optional(),
});

/** AUTH_ERR：全部密钥无效（单次即断，由 §3 引擎层执行断开）。 */
export const AUTH_ERR_HEADER_SCHEMA = z.strictObject({
  v: z.literal(1),
  code: z.literal(ERROR_CODE.key_all_invalid),
  message: z.string().max(2048).optional(),
});

/** REQ {v,id,serviceId,method,path,headers?,contentType?,bodyLen}：body 内联或空。 */
export const REQ_HEADER_SCHEMA = z.strictObject({
  v: z.literal(1),
  id: Z_ID,
  serviceId: Z_ID,
  method: z.enum(HTTP_METHODS),
  path: REQ_PATH_SCHEMA,
  headers: REQ_HEADERS_SCHEMA.optional(),
  contentType: Z_CONTENT_TYPE.optional(),
  bodyLen: z.number().int().min(0).max(2 ** 32),
});

/** REQ_BODY {id,seq,end}：正文分片续帧（seq 从 0 递增）。 */
export const REQ_BODY_HEADER_SCHEMA = z.strictObject({
  id: Z_ID,
  seq: Z_SEQ,
  end: z.boolean(),
});

/** RESP_META {id,status,contentType,headers?}：响应元信息（WS 101 时含 accept 头）。 */
export const RESP_META_HEADER_SCHEMA = z.strictObject({
  id: Z_ID,
  status: z.number().int().min(100).max(599),
  contentType: Z_CONTENT_TYPE,
  headers: RESP_META_HEADERS_SCHEMA.optional(),
});

/** RESP_CHUNK {id,seq}：响应字节分片。 */
export const RESP_CHUNK_HEADER_SCHEMA = z.strictObject({
  id: Z_ID,
  seq: Z_SEQ,
});

/** RESP_END {id}：成功终结。 */
export const RESP_END_HEADER_SCHEMA = z.strictObject({
  id: Z_ID,
});

/** ERROR {id?,code,message}：id 可得时携带；message 脱敏（不含密钥与上游凭据）。 */
export const ERROR_HEADER_SCHEMA = z.strictObject({
  id: Z_ID.optional(),
  code: z.enum([
    ERROR_CODE.aborted,
    ERROR_CODE.buffer_overflow,
    ERROR_CODE.idle_timeout,
    ERROR_CODE.unauthorized,
    ERROR_CODE.key_all_invalid,
    ERROR_CODE.unknown_service,
    ERROR_CODE.path_not_offered,
    ERROR_CODE.upstream_unreachable,
    ERROR_CODE.upstream_status,
    ERROR_CODE.secret_missing,
    ERROR_CODE.body_too_large,
    ERROR_CODE.rate_limited,
    ERROR_CODE.quota_exceeded,
    ERROR_CODE.forbidden_method,
    ERROR_CODE.forbidden_header,
    ERROR_CODE.protocol_version,
    ERROR_CODE.protocol_seq,
    ERROR_CODE.protocol_error,
    ERROR_CODE.internal,
  ]),
  message: z.string(),
});

/** ABORT {id}：使用方本地中止信号（提供方回 ERROR(aborted) 终结）。 */
export const ABORT_HEADER_SCHEMA = z.strictObject({
  id: Z_ID,
});

/** PING {id}：首字节等待期心跳（提供方 → 使用方，每 30s）。 */
export const PING_HEADER_SCHEMA = z.strictObject({
  id: Z_ID,
});

/** DATA_UP / DATA_DOWN {v,id,seq}：WS 双向原始字节分片（spec WS 条款字面含 v）。 */
export const DATA_HEADER_SCHEMA = z.strictObject({
  v: z.literal(1),
  id: Z_ID,
  seq: Z_SEQ,
});

/** CLOSE {id,code?}：WS 终结帧（语义同 RESP_END）。 */
export const CLOSE_HEADER_SCHEMA = z.strictObject({
  id: Z_ID,
  code: z.number().int().min(1000).max(65535).optional(),
});

/** 类型号 → 头 schema 注册表（mux 入站校验入口）。 */
export const FRAME_HEADER_SCHEMAS: Readonly<Record<FrameTypeValue, z.ZodType>> = {
  [FRAME_TYPE.AUTH]: AUTH_HEADER_SCHEMA,
  [FRAME_TYPE.AUTH_OK]: AUTH_OK_HEADER_SCHEMA,
  [FRAME_TYPE.AUTH_ERR]: AUTH_ERR_HEADER_SCHEMA,
  [FRAME_TYPE.REQ]: REQ_HEADER_SCHEMA,
  [FRAME_TYPE.REQ_BODY]: REQ_BODY_HEADER_SCHEMA,
  [FRAME_TYPE.RESP_META]: RESP_META_HEADER_SCHEMA,
  [FRAME_TYPE.RESP_CHUNK]: RESP_CHUNK_HEADER_SCHEMA,
  [FRAME_TYPE.RESP_END]: RESP_END_HEADER_SCHEMA,
  [FRAME_TYPE.ERROR]: ERROR_HEADER_SCHEMA,
  [FRAME_TYPE.ABORT]: ABORT_HEADER_SCHEMA,
  [FRAME_TYPE.PING]: PING_HEADER_SCHEMA,
  [FRAME_TYPE.DATA_UP]: DATA_HEADER_SCHEMA,
  [FRAME_TYPE.DATA_DOWN]: DATA_HEADER_SCHEMA,
  [FRAME_TYPE.CLOSE]: CLOSE_HEADER_SCHEMA,
};

// ---------------------------------------------------------------------------
// 推断类型
// ---------------------------------------------------------------------------

export type ServiceMatch = z.infer<typeof SERVICE_MATCH_SCHEMA>;
export type ServiceDetail = z.infer<typeof SERVICE_DETAIL_SCHEMA>;
export type ServiceEntry = z.infer<typeof SERVICE_ENTRY_SCHEMA>;
export type GroupEntry = z.infer<typeof GROUP_ENTRY_SCHEMA>;

export type AuthHeader = z.infer<typeof AUTH_HEADER_SCHEMA>;
export type AuthOkHeader = z.infer<typeof AUTH_OK_HEADER_SCHEMA>;
export type AuthErrHeader = z.infer<typeof AUTH_ERR_HEADER_SCHEMA>;
export type ReqHeader = z.infer<typeof REQ_HEADER_SCHEMA>;
export type ReqBodyHeader = z.infer<typeof REQ_BODY_HEADER_SCHEMA>;
export type RespMetaHeader = z.infer<typeof RESP_META_HEADER_SCHEMA>;
export type RespChunkHeader = z.infer<typeof RESP_CHUNK_HEADER_SCHEMA>;
export type RespEndHeader = z.infer<typeof RESP_END_HEADER_SCHEMA>;
export type ErrorHeader = z.infer<typeof ERROR_HEADER_SCHEMA>;
export type AbortHeader = z.infer<typeof ABORT_HEADER_SCHEMA>;
export type PingHeader = z.infer<typeof PING_HEADER_SCHEMA>;
export type DataHeader = z.infer<typeof DATA_HEADER_SCHEMA>;
export type CloseHeader = z.infer<typeof CLOSE_HEADER_SCHEMA>;

// ---------------------------------------------------------------------------
// schema 校验失败分类
// ---------------------------------------------------------------------------

export type SchemaFailureCode = "forbidden_method" | "forbidden_header" | "protocol_error";

/** 分类结果：code 为回送 ERROR 帧的错误码语义；id 可定位时携带（取自原始输入）。 */
export interface SchemaFailure {
  code: SchemaFailureCode;
  id?: string;
}

/**
 * 依据原始输入对 schema 失败做语义分类：
 * - REQ.method 为字符串但越界 → forbidden_method；非字符串 → protocol_error；
 * - REQ.headers 命中凭据类头（大小写不敏感）→ forbidden_header；
 * - 其余（未知字段、类型非法、path 形态、结构超限、版本字面量）→ protocol_error。
 * 注意：protocol_version 不在此处产生——JSON 头中 v≠1 由 codec 层先行拦截。
 */
export function classifySchemaFailure(frameType: number, input: unknown): SchemaFailure {
  let id: string | undefined;
  if (isRecord(input) && typeof input.id === "string") {
    id = input.id;
  }
  if (isRecord(input) && frameType === FRAME_TYPE.REQ) {
    const method = input.method;
    if (typeof method === "string" && !(HTTP_METHODS as readonly string[]).includes(method)) {
      return withId({ code: "forbidden_method" }, id);
    }
    const headers = input.headers;
    if (isRecord(headers)) {
      for (const key of Object.keys(headers)) {
        if (FORBIDDEN_REQ_HEADER_NAMES.has(key) || FORBIDDEN_REQ_HEADER_NAMES.has(key.toLowerCase())) {
          return withId({ code: "forbidden_header" }, id);
        }
      }
    }
  }
  return withId({ code: "protocol_error" }, id);
}

function withId(fail: SchemaFailure, id: string | undefined): SchemaFailure {
  if (id !== undefined) fail.id = id;
  return fail;
}
