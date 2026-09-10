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

/**
 * 路径规范化（M3-r6，Owner 裁决：不做任何配置限制——net-fly 通用转发规则
 * 在前，AI 标注在后）：仅形状归一（补前导斜杠、剥尾斜杠），语义零约束。
 * "/" 或空 → 视调用方语义（from 不允许根占位由行模型处理；to 根 = ""）。
 */
export function normalizeRoutePrefix(raw: string): string {
  let value = raw.trim();
  if (value === "") return "";
  if (!value.startsWith("/")) value = `/${value}`;
  value = value.replace(/\/+$/, "");
  return value;
}

/** to 字段 → 存储 upstreamPrefix（空或 "/" = 根 ""）。 */
export function toPrefixFromInput(raw: string): string {
  const normalized = normalizeRoutePrefix(raw);
  return normalized === "/" ? "" : normalized;
}

/** 存储 upstreamPrefix → to 表单值（根 "" 显示为 "/"）。 */
export function toInputFromPrefix(upstreamPrefix: string): string {
  return upstreamPrefix === "" ? "/" : upstreamPrefix;
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

/**
 * 路径路由行（M3-r6 定形，Owner 裁决）：客观的 from→to 转发规则——
 * from = 本地端口前缀（请求从这来），to = upstream 前缀；bound = 1:1 绑定
 * （默认只需编辑一个 input，解绑后两侧自由编辑）。forms 为 AI 层标注
 * （预设行携带供消费侧 agent 判定；表单不显示、用户新增行为空）。
 * from 为空 = 该行不生成规则；to 为空或 "/" = upstream 根。零语义限制。
 */
export interface ShareRouteRow {
  id: number;
  /** 匹配模式（M3-r7）：prefix（默认，from→to 前缀替换）/ pattern
   *  （URLPattern 匹配 + RFC 6570 模板拼装）。 */
  mode: "prefix" | "pattern";
  from: string;
  to: string;
  bound: boolean;
  /** pattern 模式：URLPattern pathname 表达式。 */
  match: string;
  /** pattern 模式：RFC 6570 URI Template。 */
  template: string;
  forms: RouteForm[];
}

let routeRowSeq = 1;

export function makeRouteRow(over: Partial<ShareRouteRow> = {}): ShareRouteRow {
  return { id: routeRowSeq++, mode: "prefix", from: "/v1", to: "/v1", bound: true, match: "", template: "", forms: [], ...over };
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
  // ② 路径路由行（默认一条 /v1 → /v1 绑定规则）
  routeRows: [makeRouteRow()] as ShareRouteRow[],
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
  share.routeRows = [makeRouteRow()];
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
  // 路由行预填（M3-r6）：预设规则即 from→to 行（默认官方镜像 1:1 绑定态）；
  // forms 标注随行（消费侧 agent 判定），表单不显示
  share.routeRows = (preset.routes ?? []).map((route) => {
    const from = route.localPrefix ?? ROUTE_LOCAL_PREFIX[route.forms[0] ?? "openai-chat"];
    const to = toInputFromPrefix(route.upstreamPrefix ?? "");
    return makeRouteRow({ from, to, bound: to === from, forms: route.forms });
  });
  if (share.routeRows.length === 0) share.routeRows = [makeRouteRow()];
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

/** 路由行操作（② 表单）：from 变更（绑定态联动 to）、绑定切换（开启时 to 对齐
 *  from）、增删行。零校验——形状归一在组装期。 */
export function updateRouteFrom(row: ShareRouteRow, value: string): void {
  row.from = value;
  if (row.bound) row.to = value;
}
export function toggleRouteBound(row: ShareRouteRow, bound: boolean): void {
  row.bound = bound;
  if (bound) row.to = row.from;
}
/** 行排序（M3-r7 Owner 裁决：按顺序命中，先声明先匹配）。 */
export function moveRouteRow(id: number, direction: -1 | 1): void {
  const idx = share.routeRows.findIndex((row) => row.id === id);
  const next = idx + direction;
  if (idx < 0 || next < 0 || next >= share.routeRows.length) return;
  const rows = [...share.routeRows];
  const [row] = rows.splice(idx, 1);
  rows.splice(next, 0, row!);
  share.routeRows = rows;
}

export function setRouteMode(row: ShareRouteRow, mode: "prefix" | "pattern"): void {
  row.mode = mode;
}

export function addRouteRow(): void {
  if (share.routeRows.length >= 4) return;
  share.routeRows.push(makeRouteRow());
}
export function removeRouteRow(id: number): void {
  share.routeRows = share.routeRows.filter((row) => row.id !== id);
  if (share.routeRows.length === 0) share.routeRows = [makeRouteRow()];
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

/** 路由组装（M3-r6）：行模型 from→to → 引擎路由（from 空 = 该行跳过；形状
 *  归一在此完成——零语义限制）。全空 = undefined（不带 routes，legacy 透传）。 */
function routeRowsInput():
  | Array<{
      forms: RouteForm[];
      mode?: "prefix" | "pattern";
      localPrefix?: string;
      upstreamPrefix?: string;
      matchPattern?: string;
      template?: string;
    }>
  | undefined {
  const entries: Array<{
    forms: RouteForm[];
    mode?: "prefix" | "pattern";
    localPrefix?: string;
    upstreamPrefix?: string;
    matchPattern?: string;
    template?: string;
  }> = [];
  for (const row of share.routeRows) {
    if (row.mode === "pattern") {
      const match = row.match.trim();
      const template = row.template.trim();
      if (match === "" || template === "") continue; // 未完成的 pattern 行跳过
      entries.push({ forms: row.forms, mode: "pattern", matchPattern: match, template });
      continue;
    }
    const local = normalizeRoutePrefix(row.from);
    if (local === "" || local === "/") continue;
    entries.push({ forms: row.forms, localPrefix: local, upstreamPrefix: toPrefixFromInput(row.to) });
  }
  return entries.length > 0 ? entries : undefined;
}

/** ② → ③ 校验：名称、分组名非空；端口/限额可解析（两模式同规——预设即
    预填的 Custom；路由行零校验，形状归一在组装期）。 */
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
    // routes：行模型 from→to（全空 = undefined 不带，legacy 透传）
    const routes = routeRowsInput();
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
