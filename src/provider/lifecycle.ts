// hooks-lifecycle v2 领域类型单源（openspec/changes/hooks-lifecycle，Owner 裁决
// 2026-09-15 破坏性重构、无迁移）：四段生命周期管线（onRequestBearerAuthentication
// → onRequestHeaders → onRequest → onResponse）的配置槽 TS 类型 + zod schema 在此
// 冻结；wire 投影（wire/frames.ts）、存储投影（provider/store.ts、consumer/
// store.ts）、RPC 契约（shared/rpc-contract.ts）一律 import 消费，只做传输/存储/
// 契约面投影，禁止手写镜像。
// 约束：browser-safe（rpc-contract 消费方禁止 node import）——本文件仅依赖 zod。

import { z } from "zod";

// ---------------------------------------------------------------------------
// 阶段常量（hooks.list 阶段矩阵 / 加载器发现 / UI 按阶段过滤共用）
// ---------------------------------------------------------------------------

/** 四阶段脚本导出名（顺序 = 管线执行顺序，spec「hooks 生命周期管线」）。 */
export const STAGE_FN_NAMES = [
  "onRequestBearerAuthentication",
  "onRequestHeaders",
  "onRequest",
  "onResponse",
] as const;

export type StageFnName = (typeof STAGE_FN_NAMES)[number];

// ---------------------------------------------------------------------------
// 披露掩码与字面量间接引用（$env: / $secret:）
// ---------------------------------------------------------------------------

/** 投影脱敏掩码 ●（wire/detail 投影中脚本绑定、密钥名、引用型字面量的统一掩码）。 */
export const SERVICE_VALUE_MASK = "\u25cf";

/** wire 投影中敏感位的形态：仅接受掩码本身（从 canonical 派生，禁止镜像声明）。 */
export const MASK_LITERAL = z.literal(SERVICE_VALUE_MASK);

/** $env 间接引用前缀（请求期环境变量解析；空/未设置 → 该头省略）。 */
export const ENV_REF_PREFIX = "$env:";

/** $secret 间接引用前缀（请求期密钥库解析；缺失 → secret_missing）。 */
export const SECRET_REF_PREFIX = "$secret:";

export function isEnvRef(value: string): boolean {
  return value.startsWith(ENV_REF_PREFIX);
}

export function isSecretRef(value: string): boolean {
  return value.startsWith(SECRET_REF_PREFIX);
}

/** 引用型字面量（$env:/$secret:）——披露时统一掩码（名与值都不出）。 */
export function isMaskedRef(value: string): boolean {
  return isEnvRef(value) || isSecretRef(value);
}

// ---------------------------------------------------------------------------
// 共享字段 schema（canonical；wire/存储/契约投影复用的基础对象）
// ---------------------------------------------------------------------------

/** 脚本名（沿用 v1 hooks 名词汇：小写开头，小写数字横杠下划线，≤64）。 */
export const SCRIPT_NAME_SCHEMA = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

/** 脚本 args（与 v1 hook 调用对象 args 同形：变量名 → 字符串）。 */
export const SCRIPT_ARGS_SCHEMA = z.record(z.string().min(1).max(128), z.string().max(2048));

/** auth.secret 引用的密钥库名（与 SECRET_NAME_SCHEMA 同词汇与上限）。 */
export const AUTH_SECRET_NAME_SCHEMA = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

/** 头名（headers.remove 条目 / headers.set 键；与 wire 头名上限一致）。 */
export const HEADER_NAME_SCHEMA = z.string().min(1).max(1024);

/** headers.set 值：仅字面量 string（动态值经 $env:/$secret: 间接引用或整段脚本；
 *  运行期解析，schema 层不做引用语法校验——语义沿用 v1 headerSet）。 */
export const HEADER_VALUE_SCHEMA = z.string().max(8192);

/** Bearer 前缀开关：auth 槽唯一来源（SecretsStore.bearerPrefix 已退役）。 */
export const AUTH_BEARER_SCHEMA = z.boolean().optional();

// ---------------------------------------------------------------------------
// ① auth 槽（onRequestBearerAuthentication）：三族单选 + 可选 bearer
// ---------------------------------------------------------------------------

export const AUTH_SECRET_SLOT_SCHEMA = z.strictObject({
  secret: AUTH_SECRET_NAME_SCHEMA,
  bearer: AUTH_BEARER_SCHEMA,
});

export const AUTH_SCRIPT_SLOT_SCHEMA = z.strictObject({
  script: SCRIPT_NAME_SCHEMA,
  args: SCRIPT_ARGS_SCHEMA.optional(),
  bearer: AUTH_BEARER_SCHEMA,
});

export const AUTH_LITERAL_SLOT_SCHEMA = z.strictObject({
  literal: z.string().min(1).max(8192),
  bearer: AUTH_BEARER_SCHEMA,
});

/** auth 槽：{secret} | {script, args?} | {literal}（+可选 bearer）。 */
export const AUTH_SLOT_SCHEMA = z.union([
  AUTH_SECRET_SLOT_SCHEMA,
  AUTH_SCRIPT_SLOT_SCHEMA,
  AUTH_LITERAL_SLOT_SCHEMA,
]);

// ---------------------------------------------------------------------------
// ② headers 槽（onRequestHeaders）：remove[] + set{}（值仅字面量）+ 可选整段脚本
// ---------------------------------------------------------------------------

export const HEADERS_SCRIPT_SLOT_SCHEMA = z.strictObject({
  name: SCRIPT_NAME_SCHEMA,
  args: SCRIPT_ARGS_SCHEMA.optional(),
});

export const HEADERS_REMOVE_SCHEMA = z.array(HEADER_NAME_SCHEMA).max(32);

export const HEADERS_SET_SCHEMA = z.record(HEADER_NAME_SCHEMA, HEADER_VALUE_SCHEMA);

export const HEADERS_SLOT_SCHEMA = z.strictObject({
  remove: HEADERS_REMOVE_SCHEMA.optional(),
  set: HEADERS_SET_SCHEMA.optional(),
  script: HEADERS_SCRIPT_SLOT_SCHEMA.optional(),
});

// ---------------------------------------------------------------------------
// ③ request 槽 / ④ response 槽：脚本绑定
// ---------------------------------------------------------------------------

export const REQUEST_SLOT_SCHEMA = z.strictObject({
  script: SCRIPT_NAME_SCHEMA,
  args: SCRIPT_ARGS_SCHEMA.optional(),
});

export const RESPONSE_SLOT_SCHEMA = z.strictObject({
  script: SCRIPT_NAME_SCHEMA,
  args: SCRIPT_ARGS_SCHEMA.optional(),
});

// ---------------------------------------------------------------------------
// 四槽合体（嵌入服务配置 / 服务视图的形状）
// ---------------------------------------------------------------------------

/** 生命周期四槽（auth/headers/request/response；嵌入服务形状的 canonical 形）。 */
export const LIFECYCLE_SLOTS_SCHEMA = z.strictObject({
  auth: AUTH_SLOT_SCHEMA.optional(),
  headers: HEADERS_SLOT_SCHEMA.optional(),
  request: REQUEST_SLOT_SCHEMA.optional(),
  response: RESPONSE_SLOT_SCHEMA.optional(),
});

// ---------------------------------------------------------------------------
// 推断类型
// ---------------------------------------------------------------------------

export type AuthSecretSlot = z.infer<typeof AUTH_SECRET_SLOT_SCHEMA>;
export type AuthScriptSlot = z.infer<typeof AUTH_SCRIPT_SLOT_SCHEMA>;
export type AuthLiteralSlot = z.infer<typeof AUTH_LITERAL_SLOT_SCHEMA>;
export type AuthSlot = z.infer<typeof AUTH_SLOT_SCHEMA>;
export type HeadersScriptSlot = z.infer<typeof HEADERS_SCRIPT_SLOT_SCHEMA>;
export type HeadersSlot = z.infer<typeof HEADERS_SLOT_SCHEMA>;
export type RequestSlot = z.infer<typeof REQUEST_SLOT_SCHEMA>;
export type ResponseSlot = z.infer<typeof RESPONSE_SLOT_SCHEMA>;
export type ServiceLifecycleSlots = z.infer<typeof LIFECYCLE_SLOTS_SCHEMA>;

// ---------------------------------------------------------------------------
// 出站归一形（upstream 转发循环的唯一消费形状）
// ---------------------------------------------------------------------------

/**
 * 归一出站响应：原生 fetch 结果与 ③ onRequest 脚本结果统一归一
 * `{status, headers, body: AsyncIterable<Uint8Array>}`；forwardHttp 消费循环
 * 只认归一形（脚本流被取消 = 引擎中止传播；headers 小写化、last-wins、经
 * RESP_META 白名单过滤由引擎投影层负责）。body 为异步字节迭代器（SSE MUST 逐块
 * 产出，禁止缓冲攒齐）。
 */
export interface NormalizedUpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
}
