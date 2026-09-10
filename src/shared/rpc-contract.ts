// 前后端共享的 orpc 契约（browser-safe：仅 zod + @orpc/contract，禁止 node import）。
// 形状与 M1 引擎模块的公开类型一一对应（provider/store.ts、consumer/store.ts、
// consumer/providers.ts、provider/link.ts）；实现全部在 src/app/rpc-router.ts ——
// 契约只定义形状与 zod 校验，不含任何业务逻辑。
// 写法照抄 skill-creator-v2 的 src/shared/rpc-contract.ts（oc.errors 有限错误
// 词汇 + oc.input/output router 树）。用户面文案英文 ASCII。
import { oc, type ErrorMap } from "@orpc/contract";
import { z } from "zod";

// ---------------------------------------------------------------------------
// 错误词汇（有限、稳定；router 侧把 DomainError 映射到这些码）
// ---------------------------------------------------------------------------

/** UI daemon 可主动公开的有限业务错误码。 */
export const RpcErrorCodeSchema = z.enum([
  "NOT_FOUND", // 目标实体不存在（store not-found / 未知 serviceId）
  "CONFLICT", // 重名/重复（store duplicate）
  "INVALID_INPUT", // 校验失败（store invalid / CLI UsageError / 链接格式错误）
  "INVALID_STATE", // 当前状态不允许该操作（如对已停引擎取实时值之外的变更）
  "UNAVAILABLE", // 依赖不在位（provider daemon 未启动、网络拉取失败）
  "INTERNAL", // 未归类错误（统一兜底，不泄露内部细节）
]);
export type RpcErrorCode = z.infer<typeof RpcErrorCodeSchema>;

/** 与错误码绑定的稳定传输状态（skill-creator-v2 同款 ErrorMap 形状）。 */
export const RpcErrorDefinitions = {
  NOT_FOUND: { status: 404, message: "The requested resource was not found." },
  CONFLICT: { status: 409, message: "The operation conflicts with current state." },
  INVALID_INPUT: { status: 422, message: "The input failed validation." },
  INVALID_STATE: { status: 409, message: "The operation is not valid in the current state." },
  UNAVAILABLE: { status: 503, message: "The required engine is not running." },
  INTERNAL: { status: 500, message: "Internal error." },
} as const satisfies ErrorMap;

// ---------------------------------------------------------------------------
// 提供方实体（形状镜像 provider/store.ts 的公开 schema）
// ---------------------------------------------------------------------------

export const SERVICE_MATCH_SCHEMA = z.strictObject({
  type: z.enum(["exact", "suffix", "regex"]),
  value: z.string().min(1).max(2048),
});

export const SERVICE_REWRITE_SCHEMA = z.strictObject({
  hostHeader: z.string().min(1).max(2048).optional(),
  pathPrefixStrip: z.string().min(1).max(2048).optional(),
  pathPrefixAppend: z.string().min(1).max(2048).optional(),
  headerSet: z.record(z.string().min(1).max(1024), z.string().max(8192)).optional(),
  headerRemove: z.array(z.string().min(1).max(1024)).max(32).optional(),
});

// ---------------------------------------------------------------------------
// 按标准路由（M3-r4）：本地端口固定暴露三个标准前缀，路由表声明各自映射的
// upstream 前缀——一个服务同时服务多种 API 标准（如 DeepSeek 的 OpenAI 与
// Anthropic 形态）。无路由或路径未命中 → 原样透传（旧行为不变）。
// ---------------------------------------------------------------------------

export const ROUTE_FORM_SCHEMA = z.enum(["openai-chat", "openai-responses", "anthropic"]);

/** 路由匹配模式（M3-r7）：prefix = 前缀替换（默认）；pattern = URLPattern
 *  匹配 + RFC 6570 URI Template 拼装。 */
export const ROUTE_MODE_SCHEMA = z.enum(["prefix", "pattern"]);

/**
 * 路径路由（M3-r7 定形）：**按声明顺序命中**（先声明先匹配）。
 * - prefix 模式（默认）：localPrefix（版本段粒度如 /v1）替换为 upstreamPrefix；
 * - pattern 模式：matchPattern（URLPattern pathname 表达式，`:name`/`{name}`
 *   组、`*` 通配）匹配请求路径，template（RFC 6570 URI Template）以捕获组
 *   + 查询参数拼装 upstream 路径。
 * forms 标注承载的 API 标准（AI 层；引擎转发与 forms 无关，可为空）。
 */
export const SERVICE_ROUTE_SCHEMA = z.strictObject({
  forms: z.array(ROUTE_FORM_SCHEMA).max(3),
  mode: ROUTE_MODE_SCHEMA.optional(),
  /** prefix 模式：本地端口前缀。缺省 = 首个 form 的规范前缀。 */
  localPrefix: z.string().min(1).max(2048).optional(),
  /** prefix 模式：替换本地前缀的 upstream 路径前缀（"" = upstream 根）。 */
  upstreamPrefix: z.string().max(2048).optional(),
  /** pattern 模式：URLPattern pathname 表达式。 */
  matchPattern: z.string().min(1).max(2048).optional(),
  /** pattern 模式：RFC 6570 URI Template（变量 = 捕获组 + 查询参数）。 */
  template: z.string().min(1).max(2048).optional(),
});

/** 各 API 标准在本地端口上的规范前缀（缺省 localPrefix 与 agent 配置基准）。 */
export const ROUTE_LOCAL_PREFIX: Readonly<Record<RouteForm, string>> = {
  "openai-chat": "/v1",
  "openai-responses": "/v1",
  anthropic: "/anthropic",
};

/** 路由的生效本地前缀（缺省派生规范前缀）。 */
export function routeLocalPrefix(route: { forms: RouteForm[]; localPrefix?: string | undefined }): string {
  return route.localPrefix ?? ROUTE_LOCAL_PREFIX[route.forms[0] ?? "openai-chat"];
}

export const SERVICE_SCHEMA = z.strictObject({
  serviceId: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  match: z.array(SERVICE_MATCH_SCHEMA).max(64),
  upstream: z.string().min(1).max(2048),
  rewrite: SERVICE_REWRITE_SCHEMA.optional(),
  routes: z.array(SERVICE_ROUTE_SCHEMA).max(3).optional(),
  defaultPort: z.number().int().min(1).max(65535),
});

/** services.add 输入（defaultPort 缺省规则的校验在 store，同 CLI）。 */
export const SERVICE_INPUT_SCHEMA = z.strictObject({
  name: z.string().min(1).max(256),
  upstream: z.string().min(1).max(2048),
  match: z.array(SERVICE_MATCH_SCHEMA).min(1).max(64),
  defaultPort: z.number().int().min(1).max(65535).optional(),
  rewrite: SERVICE_REWRITE_SCHEMA.optional(),
  routes: z.array(SERVICE_ROUTE_SCHEMA).max(3).optional(),
});

export const GROUP_LIMITS_SCHEMA = z.strictObject({
  maxConcurrency: z.number().int().min(1).optional(),
  dailyRequests: z.number().int().min(1).optional(),
});

export const GROUP_SCHEMA = z.strictObject({
  name: z.string().min(1).max(256),
  serviceIds: z.array(z.string().min(1).max(128)).max(256),
  limits: GROUP_LIMITS_SCHEMA.optional(),
});

/** 密钥视图：keyId/分组/时间/状态；哈希与原文一律不进契约（原文仅 issue 时一次性返回）。 */
export const KEY_VIEW_SCHEMA = z.strictObject({
  keyId: z.string().min(1).max(128),
  group: z.string().min(1).max(256),
  createdAt: z.number().int().min(0),
  revokedAt: z.number().int().min(0).optional(),
});

// ---------------------------------------------------------------------------
// 消费方实体（形状镜像 consumer/store.ts / providers.ts）
// ---------------------------------------------------------------------------

/** 使用方服务目录条目（AUTH_OK / import 视图；detail 为脱敏披露，$env 值显示 ●）。 */
export const SERVICE_ENTRY_SCHEMA = z.object({
  serviceId: z.string(),
  name: z.string(),
  match: z.array(z.strictObject({ type: z.string(), value: z.string() })),
  defaultPort: z.number().int(),
  detail: z
    .object({
      upstream: z.string(),
      match: z.array(z.strictObject({ type: z.string(), value: z.string() })),
      rewrite: z
        .object({
          host: z.string().optional(),
          prefix: z.string().optional(),
          headerSet: z.array(z.strictObject({ name: z.string(), value: z.string() })).optional(),
        })
        .optional(),
      /** 按标准路由披露（消费侧呈现各标准本地 base 与可用性判定）。 */
      routes: z
        .array(
          z.strictObject({
            forms: z.array(ROUTE_FORM_SCHEMA).max(3),
            mode: ROUTE_MODE_SCHEMA.optional(),
            localPrefix: z.string().optional(),
            upstreamPrefix: z.string().optional(),
            matchPattern: z.string().optional(),
            template: z.string().optional(),
          }),
        )
        .max(4)
        .optional(),
    })
    .optional(),
});

/** 消费侧提供者连接状态（M1 六态 + 网关未运行时的 stopped）。 */
export const PROVIDER_STATE_SCHEMA = z.enum([
  "stopped", // 本地网关未运行（仅 UI 投影态，非 M1 状态机值）
  "not-connected",
  "connected-unauthed",
  "direct",
  "relay",
  "offline",
  "key-all-invalid",
]);

export const CONSUMER_PROVIDER_STATUS_SCHEMA = z.object({
  endpointId: z.string(),
  alias: z.string(),
  state: PROVIDER_STATE_SCHEMA,
  /** 该提供者授权目录内的服务（脱敏 detail）。 */
  services: z.array(SERVICE_ENTRY_SCHEMA),
  /** serviceId -> 本地端口（pinned 或 default；网关运行时为实际监听端口）。 */
  ports: z.record(z.string(), z.number().int().min(0).max(65535)),
  servedCount: z.number().int().min(0),
  bufferOverflows: z.number().int().min(0),
  lastError: z.string().optional(),
});

// ---------------------------------------------------------------------------
// 预设（presets spec 数据契约的运行时形状；精选源见 presets/providers.json）
// ---------------------------------------------------------------------------

export const API_FORM_SCHEMA = z.enum(["openai-completions", "anthropic-messages", "gemini-native"]);

export const PRESET_SCHEMA = z.strictObject({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(256),
  apiForm: API_FORM_SCHEMA,
  baseUrl: z.string().min(1).max(2048),
  /** 图标源 id（models.dev logos 覆写；缺省取 id）。 */
  iconId: z.string().min(1).max(128).optional(),
  /** 惯用环境变量名（仅用于 $env 注入建议与文档；本地运行时模板无此字段）。 */
  keyEnv: z.string().min(1).max(256).optional(),
  /** 使用方本地端口建议（避开 <1024 特权段）。 */
  defaultPort: z.number().int().min(1024).max(65535),
  /** 官方域名集（exact/suffix 建议的生成源）。 */
  matchDomains: z.array(z.string().min(1).max(256)).min(1).max(16),
  /** 按标准路由（展开进服务；本地前缀由 form 派生）。 */
  routes: z.array(SERVICE_ROUTE_SCHEMA).max(3).optional(),
  notes: z.string().max(2048).optional(),
  /** 出处（精选集为调研 URL；models.dev 长尾为 "models.dev"）。 */
  source: z.string().min(1).max(512),
  /** apiForm 未经厂商文档核实（models.dev npm 推断）时长尾条目置 true。 */
  unverified: z.boolean().optional(),
});

/** 预设图标地址（models.dev logos；iconId 缺省取 id）。UI 端 onerror 回退首字母 tile。 */
export function presetLogoUrl(preset: Pick<Preset, "id" | "iconId">): string {
  return `https://models.dev/logos/${encodeURIComponent(preset.iconId ?? preset.id)}.svg`;
}

// ---------------------------------------------------------------------------
// 密钥库（provider-local；值绝不进契约输出）
// ---------------------------------------------------------------------------

export const SECRET_NAME_SCHEMA = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "lowercase letters, digits, dot, dash, underscore");

/** 密钥库清单条目（仅名称与开关——值由设计不跨 RPC）。 */
export const SECRET_ENTRY_SCHEMA = z.strictObject({
  name: SECRET_NAME_SCHEMA,
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
  /** 注入时自动拼 "Bearer "（默认 true；Owner 2026-09-10：值默认是裸 key）。 */
  bearerPrefix: z.boolean(),
});

// ---------------------------------------------------------------------------
// 写手（agent 配置写入；两段式 preview → 确认 → apply）
// ---------------------------------------------------------------------------

export const WRITER_AGENT_SCHEMA = z.enum(["codex", "claude-code", "cursor", "cline", "continue"]);

/** agent 使用的 API 标准（writer 写入 base 与 ③ 步可用性判定共用）。 */
export const WRITER_AGENT_FORM: Readonly<Record<WriterAgent, RouteForm>> = {
  codex: "openai-responses",
  "claude-code": "anthropic",
  cursor: "openai-chat",
  cline: "openai-chat",
  continue: "openai-chat",
};

/** 写手目标描述：serviceId（从消费方存储解析端口）或显式 port，二选一。 */
export const WRITER_TARGET_SCHEMA = z
  .strictObject({
    serviceId: z.string().min(1).max(128).optional(),
    port: z.number().int().min(1).max(65535).optional(),
  })
  .refine((v) => (v.serviceId !== undefined) !== (v.port !== undefined), {
    message: "exactly one of serviceId or port is required",
  });

export const WRITER_PREVIEW_SCHEMA = z.strictObject({
  agent: WRITER_AGENT_SCHEMA,
  target: WRITER_TARGET_SCHEMA,
});

export const WRITER_APPLY_SCHEMA = z.strictObject({
  agent: WRITER_AGENT_SCHEMA,
  target: WRITER_TARGET_SCHEMA,
  /** preview 返回的确认令牌（sha256(diff)）：apply 只写入用户看过的那份 diff。 */
  confirmToken: z.string().regex(/^[0-9a-f]{64}$/),
});

// ---------------------------------------------------------------------------
// 系统设置（~/.aifly/settings.json；持久化实现见 src/app/settings.ts）
// ---------------------------------------------------------------------------

export const SETTINGS_SCHEMA = z.strictObject({
  theme: z.enum(["dark", "light", "system"]),
  /** false 时预设列表不含 models.dev 长尾（断网/隐私偏好）。 */
  modelsDevEnabled: z.boolean(),
  /** relay 入口列表（provider/consumer 共用；null = 未配置，走 SDK 默认）。 */
  relayUrls: z.array(z.string().min(1).max(2048)).max(8).nullable(),
});

// ---------------------------------------------------------------------------
// 组合输入/输出 schema
// ---------------------------------------------------------------------------

export const SHARE_CREATE_INPUT_SCHEMA = z.strictObject({
  group: z.string().min(1).max(256),
  /** TTL 毫秒（1s..30d；缺省 60min——范围校验复用 link.ts 常量语义）。 */
  ttlMs: z.number().int().min(1_000).max(30 * 86_400_000).optional(),
});

const PRESET_APPLY_INPUT_SCHEMA = z.strictObject({
  presetId: z.string().min(1).max(128),
  /** 服务名（缺省取 preset.id）。 */
  name: z.string().min(1).max(256).optional(),
  /** 显式端口（缺省取 preset.defaultPort；上游特权端口时必填——store 校验兜底）。 */
  port: z.number().int().min(1).max(65535).optional(),
  /** 密钥库名（选中时 rewrite 写入 $secret:<name>，优先于 keyEnv）。 */
  secretName: SECRET_NAME_SCHEMA.optional(),
  /** 注入建议的 $env 变量名（缺省取 preset.keyEnv；无 keyEnv 且未显式给出则不注入）。 */
  keyEnv: z.string().min(1).max(256).optional(),
});

/** 提供方状态快照（引擎运行值 + 磁盘存储摘要，二合一）。 */
const PROVIDER_STATUS_SCHEMA = z.object({
  running: z.boolean(),
  alias: z.string().optional(),
  endpointId: z.string().optional(),
  fabricIdHex: z.string().optional(),
  relayMode: z.string().optional(),
  relayUrls: z.array(z.string()),
  sessionCount: z.number().int().min(0),
  services: z.number().int().min(0),
  groups: z.number().int().min(0),
  activeKeys: z.number().int().min(0),
  revokedKeys: z.number().int().min(0),
});

// ---------------------------------------------------------------------------
// 契约树（shell spec「RPC 契约面」清单的完整覆盖）
// ---------------------------------------------------------------------------

/** 完整契约（webui 与 UI daemon 共享；client 类型由此推导）。 */
export const rpcContract = oc.errors(RpcErrorDefinitions).router({
  provider: {
    services: {
      /** 全量服务配置（本机控制面：含 rewrite 原始 $env 引用，无脱敏需要）。 */
      list: oc.input(z.object({})).output(z.object({ services: z.array(SERVICE_SCHEMA) })),
      /** 按 name 精确定位单个服务。 */
      get: oc
        .input(z.strictObject({ name: z.string().min(1).max(256) }))
        .output(SERVICE_SCHEMA),
      /** 新增服务（校验同 CLI：defaultPort 特权规则、match 编译检查、重名拒绝）。 */
      add: oc.input(SERVICE_INPUT_SCHEMA).output(z.object({ service: SERVICE_SCHEMA })),
      /** 删除服务（连带清出分组引用）。 */
      remove: oc
        .input(z.strictObject({ name: z.string().min(1).max(256) }))
        .output(z.object({ removed: z.literal(true) })),
      /** 上游连通性测试（草稿或已存服务形状；provider-local、不落盘、不计限额）。 */
      test: oc
        .input(
          z.strictObject({
            upstream: z.string().min(1).max(2048),
            apiForm: API_FORM_SCHEMA.optional(),
            secretName: SECRET_NAME_SCHEMA.optional(),
            model: z.string().min(1).max(256).optional(),
          }),
        )
        .output(
          z.strictObject({
            ok: z.boolean(),
            httpStatus: z.number().int().min(0).max(599).optional(),
            latencyMs: z.number().int().min(0),
            model: z.string(),
            error: z.string().optional(),
            /** 请求详情（发起过即有）：UI 呈现「发了什么」。 */
            request: z
              .strictObject({ method: z.literal("POST"), url: z.string(), model: z.string() })
              .optional(),
            /** 模型选择来源（explicit / models.dev / upstream-probe）。 */
            modelSource: z.enum(["explicit", "models.dev", "upstream-probe"]).optional(),
          }),
        ),
    },
    secrets: {
      /** 密钥库清单（仅名称与时间戳；值由设计不跨 RPC）。 */
      list: oc.input(z.object({})).output(z.object({ secrets: z.array(SECRET_ENTRY_SCHEMA) })),
      /** 新增/覆写（value 为裸密钥——bearerPrefix 默认 true 时注入自动拼 "Bearer "）。 */
      set: oc
        .input(
          z.strictObject({
            name: SECRET_NAME_SCHEMA,
            value: z.string().min(1).max(8192),
            /** 关闭后按原样注入（非 Bearer 站点）。 */
            bearerPrefix: z.boolean().optional(),
          }),
        )
        .output(z.object({ secret: SECRET_ENTRY_SCHEMA })),
      /** 删除（不存在报 NOT_FOUND）。 */
      remove: oc
        .input(z.strictObject({ name: SECRET_NAME_SCHEMA }))
        .output(z.object({ removed: z.literal(true) })),
    },
    groups: {
      /** 分组列表（含 limits 与 serviceIds）。 */
      list: oc.input(z.object({})).output(z.object({ groups: z.array(GROUP_SCHEMA) })),
      /** 新建分组（可带限额；未知服务名报错——store 校验）。 */
      add: oc
        .input(
          z.strictObject({
            name: z.string().min(1).max(256),
            serviceNames: z.array(z.string().min(1).max(256)).max(256),
            limits: GROUP_LIMITS_SCHEMA.optional(),
          }),
        )
        .output(z.object({ group: GROUP_SCHEMA })),
      /** 整表替换分组服务引用。 */
      setServices: oc
        .input(
          z.strictObject({
            name: z.string().min(1).max(256),
            serviceNames: z.array(z.string().min(1).max(256)).max(256),
          }),
        )
        .output(z.object({ group: GROUP_SCHEMA })),
      /** 更新分组限额（省略 limits = 清除为无限）。 */
      setLimits: oc
        .input(
          z.strictObject({
            name: z.string().min(1).max(256),
            limits: GROUP_LIMITS_SCHEMA.optional(),
          }),
        )
        .output(z.object({ group: GROUP_SCHEMA })),
      /** 删除分组（仍有未撤销密钥时 CONFLICT——先 revoke）。 */
      remove: oc
        .input(z.strictObject({ name: z.string().min(1).max(256) }))
        .output(z.object({ removed: z.literal(true) })),
    },
    keys: {
      /** 签发（原文仅本次返回；此后只余哈希）。 */
      issue: oc
        .input(z.strictObject({ group: z.string().min(1).max(256) }))
        .output(z.object({ keyId: z.string(), key: z.string(), createdAt: z.number().int() })),
      /** 密钥清单（无哈希、无原文）。 */
      list: oc.input(z.object({})).output(z.object({ keys: z.array(KEY_VIEW_SCHEMA) })),
      /** 撤销（幂等）。 */
      revoke: oc
        .input(z.strictObject({ keyId: z.string().min(1).max(128) }))
        .output(z.object({ key: KEY_VIEW_SCHEMA })),
    },
    share: {
      /** 组合分享链接（需要 provider daemon 在运行以签发 fabric invite）。 */
      create: oc
        .input(SHARE_CREATE_INPUT_SCHEMA)
        .output(
          z.object({
            link: z.string().min(1),
            keyId: z.string(),
            warnings: z.array(z.string()),
          }),
        ),
    },
    /** 提供方状态（引擎运行值 + 磁盘摘要）。 */
    status: oc.input(z.object({})).output(PROVIDER_STATUS_SCHEMA),
    daemon: {
      /** 启动提供方 daemon（幂等；按数据目录现状装配）。 */
      start: oc.input(z.object({})).output(z.object({ running: z.literal(true) })),
      /** 停止提供方 daemon（幂等；在途请求按 M1 语义收敛）。 */
      stop: oc.input(z.object({})).output(z.object({ running: z.literal(false) })),
    },
  },
  consumer: {
    import: {
      /** 分享链接离线预览（不发起任何网络请求）。 */
      preview: oc
        .input(z.strictObject({ link: z.string().min(1) }))
        .output(
          z.object({
            alias: z.string(),
            endpointId: z.string(),
            group: z.string(),
            keyId: z.string(),
            relayUrls: z.array(z.string()),
            services: z.array(
              z.object({
                serviceId: z.string(),
                name: z.string(),
                defaultPort: z.number().int(),
                matchCount: z.number().int().min(0),
              }),
            ),
          }),
        ),
      /** 兑换令牌并入环（老设备复用既有身份，不消耗令牌）。 */
      apply: oc
        .input(z.strictObject({ link: z.string().min(1) }))
        .output(
          z.object({
            alias: z.string(),
            endpointId: z.string(),
            redeemed: z.boolean(),
            keyAdded: z.boolean(),
            services: z.array(
              z.object({ serviceId: z.string(), name: z.string(), defaultPort: z.number().int() }),
            ),
          }),
        ),
    },
    /** fabric 邀请令牌入网（裸 join，不带密钥）。 */
    join: oc
      .input(z.strictObject({ invite: z.string().min(1) }))
      .output(
        z.object({
          alias: z.string(),
          endpointId: z.string(),
          alreadyJoined: z.boolean(),
        }),
      ),
    key: {
      /** 裸密钥入环（keyId/group 由下次 AUTH_OK 回填）。 */
      add: oc
        .input(
          z.strictObject({
            key: z.string().min(8).max(256),
            providerRef: z.string().min(1).max(256),
          }),
        )
        .output(z.object({ alias: z.string(), added: z.boolean() })),
    },
    services: {
      /**
       * 消费侧连通测试（M3-r4）：对本机网关端口按 API 标准发最小请求，走完整
       * wire 链路；凭据由提供方 rewrite 注入，本请求不携带 authorization。
       * model 缺省时经 models.dev 缓存按 detail.upstream 选最便宜 chat 模型。
       */
      test: oc
        .input(
          z.strictObject({
            serviceId: z.string().min(1).max(128),
            form: ROUTE_FORM_SCHEMA,
            model: z.string().min(1).max(256).optional(),
          }),
        )
        .output(
          z.strictObject({
            ok: z.boolean(),
            latencyMs: z.number().int().min(0),
            request: z.strictObject({ method: z.literal("POST"), url: z.string(), model: z.string().optional() }),
            modelSource: z.enum(["explicit", "models.dev", "none"]).optional(),
            /** upstream 响应状态码（拿到响应即有；传输失败缺席）。 */
            httpStatus: z.number().int().min(100).max(599).optional(),
            error: z.string().optional(),
            /** 非 2xx 时的正文摘录（截断）。 */
            bodyExcerpt: z.string().optional(),
          }),
        ),
    },
    ports: {
      /** 全部已导入服务的本地端口清单（pinned/default 标注）。 */
      list: oc
        .input(z.object({}))
        .output(
          z.object({
            providers: z.array(
              z.object({
                alias: z.string(),
                endpointId: z.string(),
                services: z.array(
                  z.object({
                    serviceId: z.string(),
                    name: z.string(),
                    port: z.number().int(),
                    defaultPort: z.number().int(),
                    pinned: z.boolean(),
                  }),
                ),
              }),
            ),
          }),
        ),
      /** 持久化端口偏好（运行中网关下次启动生效）。 */
      set: oc
        .input(
          z.strictObject({
            serviceId: z.string().min(1).max(128),
            port: z.number().int().min(1).max(65535),
          }),
        )
        .output(z.object({ alias: z.string(), serviceId: z.string(), port: z.number().int() })),
    },
    /** 消费侧状态（网关运行时为实时状态机；停止时为 stopped + 存储投影）。 */
    status: oc
      .input(z.object({}))
      .output(
        z.object({
          gatewayRunning: z.boolean(),
          providers: z.array(CONSUMER_PROVIDER_STATUS_SCHEMA),
        }),
      ),
    /** 整环删除（钥环 + fabric 身份目录）。 */
    forget: oc
      .input(z.strictObject({ ref: z.string().min(1).max(256) }))
      .output(z.object({ alias: z.string(), removed: z.literal(true) })),
    gateway: {
      /** 启动本地网关（幂等；物化既有目录监听）。 */
      start: oc.input(z.object({})).output(z.object({ running: z.literal(true) })),
      /** 停止本地网关（幂等）。 */
      stop: oc.input(z.object({})).output(z.object({ running: z.literal(false) })),
    },
  },
  presets: {
    /** 预设列表（精选 + 可选 models.dev 长尾合流）。 */
    list: oc
      .input(z.strictObject({ includeModelsDev: z.boolean().optional() }))
      .output(
        z.object({
          curated: z.array(PRESET_SCHEMA),
          modelsDev: z.array(PRESET_SCHEMA),
          /** 长尾不可用原因（断网/禁用/无缓存；精选集仍可用）。 */
          modelsDevError: z.string().optional(),
        }),
      ),
    /** 预设 → 提供方服务（展开 upstream/match/defaultPort/$env 注入；走 services.add 同一校验）。 */
    applyAsService: oc
      .input(PRESET_APPLY_INPUT_SCHEMA)
      .output(
        z.object({
          service: SERVICE_SCHEMA,
          /** $env 注入建议（导出提示；值需含完整 header 形态如 "Bearer <key>"）。 */
          envHint: z.string().optional(),
        }),
      ),
    /** 模型清单（models.dev 缓存；按价格升序，chat 优先，未知价尾排）。
     *  presetId 二选一：已知预设；或 custom（自定义上游）实时探测 {upstream}/models。 */
    models: oc
      .input(
        z
          .strictObject({
            presetId: z.string().min(1).max(128).optional(),
            upstream: z.string().min(1).max(2048).optional(),
            secretName: SECRET_NAME_SCHEMA.optional(),
          })
          .refine((v) => (v.presetId !== undefined) !== (v.upstream !== undefined), {
            message: "exactly one of presetId or upstream is required",
          }),
      )
      .output(
        z.strictObject({
          models: z.array(
            z.strictObject({
              id: z.string().min(1).max(256),
              name: z.string().max(512).optional(),
              /** input+output 合计 USD/Mtok；未知价省略。 */
              pricePerMTok: z.number().min(0).optional(),
              /** 价格已知（排序依据；未知价条目 false）。 */
              priced: z.boolean(),
              /** false = embed/image/tts 等非对话模型（id 启发式）。 */
              chat: z.boolean(),
            }),
          ),
          /** 清单不可用原因（无缓存且拉取失败等）。 */
          error: z.string().optional(),
        }),
      ),
  },
  writers: {
    /** 生成目标 agent 配置的统一 diff 与落盘路径（不写盘）。 */
    preview: oc
      .input(WRITER_PREVIEW_SCHEMA)
      .output(
        z.object({
          agent: WRITER_AGENT_SCHEMA,
          path: z.string().min(1),
          /** 目标文件当前是否已存在（新建 vs 更新）。 */
          exists: z.boolean(),
          /** 解析后的本地端点（http://127.0.0.1:<port>）。 */
          baseUrl: z.string(),
          /** 统一 diff 文本（无上下文行数的完整 unified diff）。 */
          diff: z.string(),
          /** apply 必须原样带回（sha256(diff)）。 */
          confirmToken: z.string().regex(/^[0-9a-f]{64}$/),
        }),
      ),
    /** 确认后原子写（confirmToken 不匹配即拒绝；保留其余配置字段）。 */
    apply: oc
      .input(WRITER_APPLY_SCHEMA)
      .output(z.object({ agent: WRITER_AGENT_SCHEMA, path: z.string(), written: z.literal(true) })),
  },
  system: {
    settings: {
      /** 读取应用设置（主题/models.dev 开关/relay）。 */
      get: oc.input(z.object({})).output(SETTINGS_SCHEMA),
      /** 补丁式更新（仅提交的字段变更）。 */
      set: oc
        .input(
          z.strictObject({
            theme: z.enum(["dark", "light", "system"]).optional(),
            modelsDevEnabled: z.boolean().optional(),
            relayUrls: z.array(z.string().min(1).max(2048)).max(8).nullable().optional(),
          }),
        )
        .output(SETTINGS_SCHEMA),
    },
    /** 通知通道常量（前端 ws 订阅地址；与 web-server 实现保持同源）。 */
    notifyChannels: oc
      .input(z.object({}))
      .output(
        z.object({
          rpcPath: z.literal("/ws/rpc"),
          notifyPath: z.literal("/ws/notify"),
        }),
      ),
  },
});

/** 契约静态形状（client 类型推导用）。 */
export type RpcContract = typeof rpcContract;

// 派生类型别名（实现侧与 webui 共用）
export type ApiForm = z.infer<typeof API_FORM_SCHEMA>;
export type RouteForm = z.infer<typeof ROUTE_FORM_SCHEMA>;
export type Preset = z.infer<typeof PRESET_SCHEMA>;
export type WriterAgent = z.infer<typeof WRITER_AGENT_SCHEMA>;
export type Settings = z.infer<typeof SETTINGS_SCHEMA>;
export type ServiceConfigView = z.infer<typeof SERVICE_SCHEMA>;
export type ServiceInputView = z.infer<typeof SERVICE_INPUT_SCHEMA>;
export type GroupView = z.infer<typeof GROUP_SCHEMA>;
export type KeyView = z.infer<typeof KEY_VIEW_SCHEMA>;
