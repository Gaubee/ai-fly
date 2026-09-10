// 提供方分享向导状态机（B 3.2 / M3 3.2·3.3·6.2·6.3，#/share 三步）：
// ①服务来源（预设卡片 / 自定义 URL）→ ②命名与分组（可新建组、密钥选择器
// secretName、连通测试；限额收进 advanced options）→ ③生成分享
// （services.add + 分组落位 + daemon 幂等启动 + share.create → 链接 +
// 警示 + TTL）。M3-r5：预设 = 预填的 Custom——选预设展开 upstream/match/
// 路由进 ② 表单，一切可改；两种模式走同一条本地组装提交路径。
// 选中密钥时手组 rewrite.headerSet.authorization = $secret:<name>；
// match 留空时由 upstream hostname 派生（M3-acceptance ③）。
// 路由输入语义（M3-r5）：字段持「该标准的端点完整路径」，提交时剥掉标准
// 尾段得 upstream 前缀（/anthropic/v1/messages → 前缀 /anthropic）；
// 空 = 该标准不提供；全空不带 routes（legacy 透传）。
// 每步可回退；成功后锁定结果视图（回退会重复建服务，故隐藏 Back）。
import { toRpcError, type RpcError } from "$lib/rpc-client";
import { ROUTE_LOCAL_PREFIX, type Preset, type RouteForm } from "$shared/rpc-contract.ts";
import { call } from "./rpc.svelte.ts";
import { toastRpcError, toastSuccess } from "./toast.svelte.ts";
import { refresh } from "./app.svelte.ts";

/** 各标准的端点尾段（路由输入占位/校验/前缀推导共用）。 */
export const ROUTE_ENDPOINT_SUFFIX: Readonly<Record<RouteForm, string>> = {
  "openai-chat": "/v1/chat/completions",
  "openai-responses": "/v1/responses",
  anthropic: "/v1/messages",
};

/** 端点路径 → upstream 前缀：必须以标准尾段结尾，剥掉即前缀（"" = 根）。 */
export function routePrefixFromEndpointPath(form: RouteForm, endpointPath: string): string | null {
  const suffix = ROUTE_ENDPOINT_SUFFIX[form];
  if (!endpointPath.endsWith(suffix)) return null;
  const prefix = endpointPath.slice(0, -suffix.length);
  return prefix === "" || prefix.startsWith("/") ? prefix : `/${prefix}`;
}

/** upstream 前缀 → 端点路径（预设预填用）。 */
export function routeEndpointPathFromPrefix(form: RouteForm, upstreamPrefix: string): string {
  return `${upstreamPrefix}${ROUTE_ENDPOINT_SUFFIX[form]}`;
}

/** 分享链接 TTL 选项（契约范围 1s..30d；缺省引擎 60min）。 */
export const TTL_OPTIONS: ReadonlyArray<{ label: string; ttlMs: number }> = [
  { label: "1 hour", ttlMs: 3_600_000 },
  { label: "12 hours", ttlMs: 12 * 3_600_000 },
  { label: "1 day", ttlMs: 86_400_000 },
  { label: "7 days", ttlMs: 7 * 86_400_000 },
  { label: "30 days", ttlMs: 30 * 86_400_000 },
];

/** 正整数解析（空串/非法 → undefined；用于端口与限额输入）。 */
export function parsePositiveInt(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number.parseInt(trimmed, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export const share = $state({
  step: 1 as 1 | 2 | 3,
  /** 来源模式：preset（预设展开）/ custom（手填 services.add）。 */
  mode: "preset" as "preset" | "custom",
  // ① 预设选择
  presetId: "",
  // ① 自定义服务（名称在 ② 的 share.name 输入；此处只留来源字段）
  customUpstream: "",
  customMatch: "",
  customPort: "",
  // ②（M3-r4 ⑦）自定义服务的按标准路由 upstream 前缀（空 = 该标准不提供）
  customRouteChat: "",
  customRouteResponses: "",
  customRouteAnthropic: "",
  // ② 命名与分组（端口沿用预设 defaultPort，可覆盖）
  name: "",
  port: "",
  groupName: "",
  /** false = 从既有分组选择；true = 新建。 */
  groupNew: false, // 退役：新建走 GroupsDialog（M3-r3 ①）；保留字段避免历史状态迁移
  limitsConcurrency: "",
  limitsDaily: "",
  /** 密钥库选择（undefined = 不注入 authorization；本地运行时可留空）。 */
  secretName: undefined as string | undefined,
  // ③ 生成
  ttlMs: TTL_OPTIONS[0]!.ttlMs,
  /** 在途阶段（'' | 'service' | 'group' | 'daemon' | 'share'）。 */
  busy: "",
  error: null as RpcError | null,
  result: null as { link: string; keyId: string; warnings: string[] } | null,
});

/** 重置向导（进入页面/完成后重新开始）。 */
export function resetShare(): void {
  share.step = 1;
  share.mode = "preset";
  share.presetId = "";
  share.customUpstream = "";
  share.customMatch = "";
  share.customPort = "";
  share.customRouteChat = "";
  share.customRouteResponses = "";
  share.customRouteAnthropic = "";
  share.name = "";
  share.port = "";
  share.groupName = "";
  share.groupNew = false;
  share.limitsConcurrency = "";
  share.limitsDaily = "";
  share.secretName = undefined;
  share.ttlMs = TTL_OPTIONS[0]!.ttlMs;
  share.busy = "";
  share.error = null;
  share.result = null;
}

/** ① 选择预设 → 展开预填 ②（M3-r5：预设 = 预填的 Custom，一切可改）并前进。 */
export function choosePreset(preset: Preset): void {
  share.mode = "preset";
  share.presetId = preset.id;
  share.name = preset.id;
  share.port = String(preset.defaultPort);
  share.customUpstream = preset.baseUrl;
  share.customMatch = preset.matchDomains.join(", ");
  // 路由端点路径预填：预设 routes 前缀 + 标准尾段；未声明的标准留空（不提供）
  const byForm = new Map((preset.routes ?? []).map((r) => [r.form, r.upstreamPrefix]));
  share.customRouteChat =
    byForm.get("openai-chat") !== undefined ? routeEndpointPathFromPrefix("openai-chat", byForm.get("openai-chat")!) : "";
  share.customRouteResponses =
    byForm.get("openai-responses") !== undefined
      ? routeEndpointPathFromPrefix("openai-responses", byForm.get("openai-responses")!)
      : "";
  share.customRouteAnthropic =
    byForm.get("anthropic") !== undefined ? routeEndpointPathFromPrefix("anthropic", byForm.get("anthropic")!) : "";
  share.error = null;
  share.step = 2;
}

/** ① 选择自定义 → 预填 ②。 */
export function chooseCustom(): void {
  share.mode = "custom";
  share.presetId = "";
  share.name = "";
  share.port = share.customPort;
  share.error = null;
  share.step = 2;
}

/** 回退（成功后不可回：结果视图隐藏按钮）。 */
export function shareBack(): void {
  if (share.result !== null || share.step <= 1) return;
  share.step = (share.step - 1) as 1 | 2;
  share.error = null;
}

/** ① → ② 校验（自定义模式：名称/upstream 必填；match 可留空——提交时由
 *  upstream host 派生（M3-acceptance ③），仅派生亦不可行时才判无效）。 */
export function customSourceValid(): boolean {
  if (share.name.trim() === "") return false;
  const upstream = share.customUpstream.trim();
  if (!/^https?:\/\//.test(upstream)) return false;
  return share.customMatch.trim() !== "" || customMatchRules() !== null;
}

/** 自定义 match 组装：手填（逗号/空白分隔多域名 → 多条 suffix）→ 留空用
 *  new URL(upstream).hostname 单条 exact（解析失败返回 null——维持既有校验
 *  错误文案）。 */
function customMatchRules(): Array<{ type: "exact" | "suffix"; value: string }> | null {
  const manual = share.customMatch.trim();
  if (manual !== "") {
    const domains = manual
      .split(/[\s,]+/)
      .map((d) => d.trim())
      .filter((d) => d !== "");
    if (domains.length === 0) return null;
    return domains.map((value) => ({ type: "suffix" as const, value }));
  }
  try {
    return [{ type: "exact", value: new URL(share.customUpstream.trim()).hostname }];
  } catch {
    return null;
  }
}

/** 路由组装（M3-r5 端点路径语义）：字段持完整端点路径，剥标准尾段得 upstream
 *  前缀；非法（不以尾段结尾）返回 null（校验错误在 namingValid 给出）。
 *  全空 = undefined（不带 routes，legacy 透传）。 */
function customRoutes(): Array<{ form: RouteForm; upstreamPrefix: string }> | null | undefined {
  const entries: Array<{ form: RouteForm; upstreamPrefix: string }> = [];
  const fields: Array<{ form: RouteForm; value: string }> = [
    { form: "openai-chat", value: share.customRouteChat.trim() },
    { form: "openai-responses", value: share.customRouteResponses.trim() },
    { form: "anthropic", value: share.customRouteAnthropic.trim() },
  ];
  for (const field of fields) {
    if (field.value === "") continue;
    const prefix = routePrefixFromEndpointPath(field.form, field.value);
    if (prefix === null) return null;
    entries.push({ form: field.form, upstreamPrefix: prefix });
  }
  return entries.length > 0 ? entries : undefined;
}

/** 路由输入校验：非空字段必须以该标准的端点尾段结尾（给出人话错误）。 */
export function routeInputError(): string | null {
  const fields: Array<{ form: RouteForm; value: string; label: string }> = [
    { form: "openai-chat", value: share.customRouteChat.trim(), label: "openai chat completions path" },
    { form: "openai-responses", value: share.customRouteResponses.trim(), label: "openai responses path" },
    { form: "anthropic", value: share.customRouteAnthropic.trim(), label: "anthropic messages path" },
  ];
  for (const field of fields) {
    if (field.value !== "" && routePrefixFromEndpointPath(field.form, field.value) === null) {
      return `${field.label} must end with ${ROUTE_ENDPOINT_SUFFIX[field.form]}`;
    }
  }
  return null;
}

/** ② → ③ 校验：名称、分组名非空；端口/限额/路由端点路径可解析（两模式同规——
    预设即预填的 Custom）。 */
export function namingValid(): string | null {
  if (share.name.trim() === "") return "service name is required";
  if (share.groupName.trim() === "") return "group name is required";
  // M3-r5：两模式同规——预设的 upstream 也在表单里可改，需同校验
  if (!/^https?:\/\//.test(share.customUpstream.trim())) return "https upstream url is required";
  if (share.port.trim() !== "" && parsePositiveInt(share.port) === undefined) {
    return "port must be a positive integer";
  }
  if (share.limitsConcurrency.trim() !== "" && parsePositiveInt(share.limitsConcurrency) === undefined) {
    return "concurrency limit must be a positive integer";
  }
  if (share.limitsDaily.trim() !== "" && parsePositiveInt(share.limitsDaily) === undefined) {
    return "daily limit must be a positive integer";
  }
  const routeProblem = routeInputError();
  if (routeProblem !== null) return routeProblem;
  return null;
}

/** ② → ③ 前进。 */
export function namingNext(): void {
  const problem = namingValid();
  if (problem !== null) {
    share.error = { code: "INVALID_INPUT", message: problem };
    return;
  }
  share.error = null;
  share.step = 3;
}

/** 可选限额输入 → 契约 limits（空 = 不限）。 */
function limitsInput(): { maxConcurrency?: number; dailyRequests?: number } | undefined {
  const maxConcurrency = parsePositiveInt(share.limitsConcurrency);
  const dailyRequests = parsePositiveInt(share.limitsDaily);
  if (maxConcurrency === undefined && dailyRequests === undefined) return undefined;
  return {
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    ...(dailyRequests !== undefined ? { dailyRequests } : {}),
  };
}

/** 确保服务落进目标分组（新建带限额 / 既有则 setServices 增补）。 */
async function ensureGroupWithService(serviceName: string): Promise<void> {
  const { groups } = await call((c) => c.provider.groups.list({}));
  const existing = groups.find((group) => group.name === share.groupName);
  if (existing === undefined) {
    await call((c) =>
      c.provider.groups.add({
        name: share.groupName,
        serviceNames: [serviceName],
      }),
    );
    return;
  }
  // serviceIds → serviceNames 映射需要 services.list（store 无 names 直查）
  const { services } = await call((c) => c.provider.services.list({}));
  const target = services.find((service) => service.name === serviceName);
  const names = existing.serviceIds
    .map((serviceId) => services.find((service) => service.serviceId === serviceId)?.name)
    .filter((name): name is string => name !== undefined);
  if (target === undefined || existing.serviceIds.includes(target.serviceId)) return;
  await call((c) =>
    c.provider.groups.setServices({ name: share.groupName, serviceNames: [...names, serviceName] }),
  );
}

/**
 * ③ 生成分享（四段：服务 → 分组 → daemon（share.create 依赖运行态 fabric）
 * → share.create）。任一段失败就地内联渲染 + toast。
 */
export async function generateShare(): Promise<void> {
  if (share.busy !== "" || share.result !== null) return;
  share.error = null;
  try {
    share.busy = "service";
    // M3-r5：预设 = 预填的 Custom——两模式走同一条本地组装提交路径
    // （applyAsService 保留给 CLI；向导不再依赖服务端展开）。
    // match：手填 suffix（多域名）；留空 → upstream hostname 单条 exact
    const match = customMatchRules();
    if (match === null) {
      share.error = { code: "INVALID_INPUT", message: "name, https upstream and match domain are required" };
      return;
    }
    // routes：端点路径剥标准尾段得 upstream 前缀（全空 = undefined 不带）
    const routes = customRoutes();
    if (routes === null) {
      share.error = { code: "INVALID_INPUT", message: routeInputError() ?? "invalid route path" };
      return;
    }
    const added = await call((c) =>
      c.provider.services.add({
        name: share.name.trim(),
        upstream: share.customUpstream.trim(),
        match,
        ...(parsePositiveInt(share.port) !== undefined
          ? { defaultPort: parsePositiveInt(share.port) }
          : {}),
        ...(share.secretName !== undefined
          ? { rewrite: { headerSet: { authorization: `$secret:${share.secretName}` } } }
          : {}),
        ...(routes !== undefined ? { routes } : {}),
      }),
    );
    const serviceName = added.service.name;

    share.busy = "group";
    await ensureGroupWithService(serviceName);

    share.busy = "daemon";
    await call((c) => c.provider.daemon.start({}));

    share.busy = "share";
    const result = await call((c) =>
      c.provider.share.create({ group: share.groupName, ttlMs: share.ttlMs }),
    );
    share.result = { link: result.link, keyId: result.keyId, warnings: result.warnings };
    toastSuccess("Share link created", "Copy it to your friend - the link itself is the credential.");
    refresh("provider", "groups", "services", "keys");
  } catch (error) {
    share.error = toRpcError(error);
    toastRpcError(share.error);
  } finally {
    share.busy = "";
  }
}
