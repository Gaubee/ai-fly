// 服务表单统一状态机（Owner 裁决 2026-09-13 #5：分享向导②与高级设置
// "编辑服务"同一套编辑组件、同一数据源——本 store + ServiceForm.svelte）。
// 模型 = 向导②定形：分组+服务名 → 上游 URL → PATH ROUTES 行 → hooks 脚本
// → 认证头 → 连通测试 → 高级选项（接收方建议端口 + match 域名）。
// 三个入口：choosePreset（预设预填）/ openAdd + openEdit（高级页 Dialog）/
// chooseCustom；两条落库路径：submit（Dialog 保存，编辑 = remove+add）与
// ensureCreated（向导③幂等补建，不 remove）。
// 编辑透传（passthrough）：表单未覆盖的字段原样带回——routes、headerSet
// 的非 authorization 头、非 suffix 的 legacy match 规则。

import { toRpcError, type RpcError, type RpcClient } from "$lib/rpc-client";
import { ROUTE_LOCAL_PREFIX, type Preset, type RouteForm } from "$shared/rpc-contract.ts";
import { call } from "./rpc.svelte.ts";
import { toastRpcError, toastSuccess } from "./toast.svelte.ts";
import { app, refresh } from "./app.svelte.ts";
import { authInput, authSelFromPreset, authSelFromService, hooksField, hooksScriptFromPreset, hooksScriptFromService, type AuthSel, type HeaderValue } from "$lib/auth-source.ts";

type ServiceAddInput = Parameters<RpcClient["provider"]["services"]["add"]>[0];

/**
 * 路径规范化（M3-r6，Owner 裁决：零语义限制）：仅形状归一（补前导斜杠、
 * 剥尾斜杠）。
 */
export function normalizeRoutePrefix(raw: string): string {
  let value = raw.trim();
  if (value === "") return "";
  if (!value.startsWith("/")) value = `/${value}`;
  return value.replace(/\/+$/, "");
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

/** 正整数解析（空串/非法 → undefined；用于端口输入）。 */
export function parsePositiveInt(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const value = Number.parseInt(trimmed, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 路径路由行（M3-r6 定形）：from（本地前缀）→ to（upstream 前缀）；
 * bound = 1:1 绑定（隐藏 to 输入）；pattern 模式走 URLPattern + 模板。
 */
export interface ShareRouteRow {
  id: number;
  mode: "prefix" | "pattern";
  from: string;
  to: string;
  bound: boolean;
  match: string;
  template: string;
  forms: RouteForm[];
}

let routeRowSeq = 1;

export function makeRouteRow(over: Partial<ShareRouteRow> = {}): ShareRouteRow {
  return { id: routeRowSeq++, mode: "prefix", from: "/v1", to: "/v1", bound: true, match: "", template: "", forms: [], ...over };
}

export const serviceForm = $state({
  /** Dialog 开合（高级页编辑/新建用；向导内联渲染不读此位）。 */
  open: false,
  /** 编辑中的原服务名（"" = 新建）。 */
  editingName: "",
  name: "",
  groupName: "",
  upstream: "",
  /** 接收方建议端口（Owner 2026-09-13 #4：这是给使用方的建议值）。 */
  port: "",
  /** match 域名（逗号/空白分隔 → suffix 规则；留空 = upstream hostname）。 */
  customMatch: "",
  routeRows: [makeRouteRow()] as ShareRouteRow[],
  /** hooks 脚本（Owner #3 双控件：先激活，认证头才出条目）。 */
  hooksScript: "",
  /** 认证头取值（AuthSel：none/secret/hook/keep）。 */
  auth: { kind: "none" } as AuthSel,
  /** 预设来源（TestConnection 的模型下拉用；"" = custom）。 */
  presetId: "",
  busy: false,
  error: null as RpcError | null,
  /** 编辑透传（表单外字段原样带回）。 */
  passthrough: null as { routes?: ServiceAddInput["routes"]; headerRest?: Record<string, HeaderValue>; matchExtra?: ServiceAddInput["match"] } | null,
});

/** 表单复位（保留 open 由调用方管理）。 */
function formReset(): void {
  serviceForm.editingName = "";
  serviceForm.name = "";
  serviceForm.groupName = "";
  serviceForm.upstream = "";
  serviceForm.port = "";
  serviceForm.customMatch = "";
  serviceForm.routeRows = [makeRouteRow()];
  serviceForm.hooksScript = "";
  serviceForm.auth = { kind: "none" };
  serviceForm.presetId = "";
  serviceForm.error = null;
  serviceForm.passthrough = null;
}

/** 高级页：新建。 */
export function openAdd(): void {
  formReset();
  serviceForm.open = true;
}

/** 高级页：编辑既有服务（回显统一模型；非 suffix 规则/headerSet 其他头/
 *  routes 原样透传，编辑保存不丢表单外字段）。 */
export function openEdit(service: Parameters<typeof authSelFromService>[0]): void {
  formReset();
  serviceForm.editingName = service.name;
  serviceForm.name = service.name;
  // 分组回显（走查实证 2026-09-13：漏设会让"不改直接保存"必报 group
  // name is required）——取第一个包含该服务的组；无组 = 空（未分组）
  serviceForm.groupName = app.groups.find((g) => g.serviceIds.includes(service.serviceId))?.name ?? "";
  serviceForm.upstream = service.upstream;
  serviceForm.port = String(service.defaultPort);
  serviceForm.hooksScript = hooksScriptFromService(service);
  serviceForm.auth = authSelFromService(service);
  const suffixes = service.match.filter((r) => r.type === "suffix").map((r) => r.value);
  serviceForm.customMatch = suffixes.join(", ");
  const matchExtra = service.match.filter((r) => r.type !== "suffix");
  const { authorization, ...headerRest } = (service.rewrite?.headerSet ?? {}) as Record<string, HeaderValue>;
  serviceForm.passthrough = {
    ...(service.routes !== undefined && service.routes.length > 0 ? { routes: service.routes } : {}),
    ...(Object.keys(headerRest).length > 0 ? { headerRest } : {}),
    ...(matchExtra.length > 0 ? { matchExtra } : {}),
  };
  // 服务既有路由回显为可编辑行
  if (service.routes !== undefined && service.routes.length > 0) {
    serviceForm.routeRows = service.routes.map((route) => {
      const from = route.localPrefix ?? ROUTE_LOCAL_PREFIX[route.forms[0] ?? "openai-chat"];
      const to = toInputFromPrefix(route.upstreamPrefix ?? "");
      return makeRouteRow({
        from,
        to,
        bound: to === from,
        forms: route.forms,
        ...(route.mode === "pattern" && route.matchPattern !== undefined && route.template !== undefined
          ? { mode: "pattern" as const, match: route.matchPattern, template: route.template }
          : {}),
      });
    });
  }
  serviceForm.open = true;
}

/** 向导①：选预设 → 预填（预设 = 预填的 Custom，一切可改）。 */
export function choosePreset(preset: Preset): void {
  formReset();
  serviceForm.presetId = preset.id;
  serviceForm.name = preset.id;
  serviceForm.port = String(preset.defaultPort);
  serviceForm.upstream = preset.baseUrl;
  serviceForm.customMatch = preset.matchDomains.join(", ");
  serviceForm.auth = authSelFromPreset(preset);
  serviceForm.hooksScript = hooksScriptFromPreset(preset);
  serviceForm.routeRows = (preset.routes ?? []).map((route) => {
    const from = route.localPrefix ?? ROUTE_LOCAL_PREFIX[route.forms[0] ?? "openai-chat"];
    const to = toInputFromPrefix(route.upstreamPrefix ?? "");
    return makeRouteRow({ from, to, bound: to === from, forms: route.forms });
  });
  if (serviceForm.routeRows.length === 0) serviceForm.routeRows = [makeRouteRow()];
}

/** 向导①：自定义来源。 */
export function chooseCustom(): void {
  formReset();
}

/** 路由行操作（零校验——形状归一在组装期）。 */
export function updateRouteFrom(row: ShareRouteRow, value: string): void {
  row.from = value;
  if (row.bound) row.to = value;
}
export function toggleRouteBound(row: ShareRouteRow, bound: boolean): void {
  row.bound = bound;
  if (bound) row.to = row.from;
}
export function moveRouteRow(id: number, direction: -1 | 1): void {
  const idx = serviceForm.routeRows.findIndex((row) => row.id === id);
  const next = idx + direction;
  if (idx < 0 || next < 0 || next >= serviceForm.routeRows.length) return;
  const rows = [...serviceForm.routeRows];
  const [row] = rows.splice(idx, 1);
  rows.splice(next, 0, row!);
  serviceForm.routeRows = rows;
}
export function setRouteMode(row: ShareRouteRow, mode: "prefix" | "pattern"): void {
  row.mode = mode;
}
export function addRouteRow(): void {
  if (serviceForm.routeRows.length >= 4) return;
  serviceForm.routeRows.push(makeRouteRow());
}
export function removeRouteRow(id: number): void {
  serviceForm.routeRows = serviceForm.routeRows.filter((row) => row.id !== id);
  if (serviceForm.routeRows.length === 0) serviceForm.routeRows = [makeRouteRow()];
}

/** match 组装：手填域名 → suffix 规则；留空 → upstream hostname 单条 exact；
 *  失败 → null（维持既有校验错误文案）；legacy 非 suffix 规则透传附加。 */
export function matchRules(): Array<{ type: "exact" | "suffix" | "regex"; value: string }> | null {
  const manual = serviceForm.customMatch.trim();
  let composed: Array<{ type: "exact" | "suffix" | "regex"; value: string }>;
  if (manual !== "") {
    const domains = manual
      .split(/[\s,]+/)
      .map((d) => d.trim())
      .filter((d) => d !== "");
    if (domains.length === 0) return null;
    composed = domains.map((value) => ({ type: "suffix" as const, value }));
  } else {
    try {
      composed = [{ type: "exact", value: new URL(serviceForm.upstream.trim()).hostname }];
    } catch {
      return null;
    }
  }
  return [...composed, ...(serviceForm.passthrough?.matchExtra ?? [])];
}

/** 路由组装：行模型 → 引擎路由；全空 = passthrough.routes（编辑透传）或省略。 */
export function routesInput(): ServiceAddInput["routes"] {
  const entries: NonNullable<ServiceAddInput["routes"]> = [];
  for (const row of serviceForm.routeRows) {
    if (row.mode === "pattern") {
      const match = row.match.trim();
      const template = row.template.trim();
      if (match === "" || template === "") continue;
      entries.push({ forms: row.forms, mode: "pattern", matchPattern: match, template });
      continue;
    }
    const local = normalizeRoutePrefix(row.from);
    if (local === "" || local === "/") continue;
    entries.push({ forms: row.forms, localPrefix: local, upstreamPrefix: toPrefixFromInput(row.to) });
  }
  if (entries.length > 0) return entries;
  return serviceForm.passthrough?.routes;
}

/** 校验（② → ③ / Dialog 保存共用）：名称、分组、upstream、端口。 */
export function validate(): string | null {
  if (serviceForm.name.trim() === "") return "service name is required";
  if (serviceForm.groupName.trim() === "") return "group name is required";
  if (!/^https?:\/\//.test(serviceForm.upstream.trim())) return "https upstream url is required";
  if (serviceForm.port.trim() !== "" && parsePositiveInt(serviceForm.port) === undefined) {
    return "port must be a positive integer";
  }
  if (matchRules() === null) return "a valid upstream url is required to derive match rules";
  return null;
}

/** 组装完整 services.add 输入（认证/headerSet 合并透传）。 */
export function composeInput(): { ok: true; input: ServiceAddInput } | { ok: false; message: string } {
  const problem = validate();
  if (problem !== null) return { ok: false, message: problem };
  const match = matchRules()!;
  const port = parsePositiveInt(serviceForm.port);
  const authParts = authInput(serviceForm.auth);
  const hooks = hooksField(serviceForm.hooksScript, serviceForm.auth);
  const headerSet: Record<string, HeaderValue> = { ...(serviceForm.passthrough?.headerRest ?? {}) };
  if (authParts.authorization !== undefined) {
    headerSet["authorization"] = authParts.authorization;
  }
  const routes = routesInput();
  return {
    ok: true,
    input: {
      name: serviceForm.name.trim(),
      upstream: serviceForm.upstream.trim(),
      match,
      ...(port !== undefined ? { defaultPort: port } : {}),
      ...(hooks !== undefined ? { hooks } : {}),
      ...(routes !== undefined ? { routes } : {}),
      ...(Object.keys(headerSet).length > 0 ? { rewrite: { headerSet } } : {}),
    },
  };
}

/** 确保服务落进目标分组（新建 / 既有 setServices 增补）。 */
async function ensureGroupWithService(serviceName: string): Promise<void> {
  const groupName = serviceForm.groupName;
  const { groups } = await call((c) => c.provider.groups.list({}));
  const existing = groups.find((group) => group.name === groupName);
  if (existing === undefined) {
    await call((c) => c.provider.groups.add({ name: groupName, serviceNames: [serviceName] }));
    return;
  }
  const { services } = await call((c) => c.provider.services.list({}));
  const target = services.find((service) => service.name === serviceName);
  const names = existing.serviceIds
    .map((serviceId) => services.find((service) => service.serviceId === serviceId)?.name)
    .filter((name): name is string => name !== undefined);
  if (target === undefined || existing.serviceIds.includes(target.serviceId)) return;
  await call((c) => c.provider.groups.setServices({ name: groupName, serviceNames: [...names, serviceName] }));
}

/**
 * Dialog 保存（高级页）：编辑 = remove + add 重建（同名不再 CONFLICT），
 * 随后确保分组归属。成功后关闭 Dialog。
 */
export async function submit(): Promise<void> {
  if (serviceForm.busy) return;
  const parsed = composeInput();
  if (!parsed.ok) {
    serviceForm.error = { code: "INVALID_INPUT", message: parsed.message };
    return;
  }
  serviceForm.busy = true;
  serviceForm.error = null;
  try {
    // 编辑重建（remove+add）保留原停用态（service-lifecycle）：remove 不可逆，
    // 停用值须在重建前读出并注入 add 输入，否则编辑保存会静默复活服务
    let prevEnabled: boolean | undefined;
    if (serviceForm.editingName !== "") {
      const { services } = await call((c) => c.provider.services.list({}));
      prevEnabled = services.find((s) => s.name === serviceForm.editingName)?.enabled;
      await call((c) => c.provider.services.remove({ name: serviceForm.editingName }));
    }
    const input =
      prevEnabled === false ? { ...parsed.input, enabled: false } : parsed.input;
    await call((c) => c.provider.services.add(input));
    await ensureGroupWithService(input.name);
    serviceForm.open = false;
    toastSuccess(serviceForm.editingName !== "" ? "Service updated" : "Service added", input.name);
    refresh("services", "groups", "provider");
  } catch (error) {
    serviceForm.error = toRpcError(error);
    toastRpcError(serviceForm.error);
  } finally {
    serviceForm.busy = false;
  }
}

/**
 * 向导③幂等补建：服务名不存在则按当前表单 add（不 remove 既有），随后
 * 确保分组归属。返回服务名。
 */
export async function ensureCreated(): Promise<string> {
  const parsed = composeInput();
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }
  let serviceName = parsed.input.name;
  const { services } = await call((c) => c.provider.services.list({}));
  if (!services.some((s) => s.name === serviceName)) {
    const added = await call((c) => c.provider.services.add(parsed.input));
    serviceName = added.service.name;
  }
  await ensureGroupWithService(serviceName);
  return serviceName;
}
