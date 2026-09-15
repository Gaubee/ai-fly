// 服务表单统一状态机（Owner 裁决 2026-09-13 #5：分享向导②与高级设置
// "编辑服务"同一套编辑组件、同一数据源——本 store + ServiceForm.svelte）。
// 模型 = 向导②定形：分组+服务名 → 上游 URL → PATH ROUTES 行 → Request
// lifecycle 管线（hooks-lifecycle v2 四槽：①auth/②headers/③request/
// ④response）→ 连通测试 → 高级选项（接收方建议端口 + match 域名）。
// 三个入口：choosePreset（预设预填）/ openAdd + openEdit（高级页 Dialog）/
// chooseCustom；两条落库路径：submit（Dialog 保存，编辑 = remove+add）与
// ensureCreated（向导③幂等补建，不 remove）。
// 编辑透传（passthrough）：表单未覆盖的字段原样带回——routes、rewrite
// （host/路径前缀）、非 suffix 的 legacy match 规则、各脚本槽 args
// （脚本名未变时原样带回，换绑即清除）。

import { toRpcError, type RpcError, type RpcClient } from "$lib/rpc-client";
import { ROUTE_LOCAL_PREFIX, type ApiForm, type Preset, type RouteForm, type ServiceConfigView } from "$shared/rpc-contract.ts";
import { call } from "./rpc.svelte.ts";
import { toastRpcError, toastSuccess } from "./toast.svelte.ts";
import { app, refresh } from "./app.svelte.ts";
import {
  authSelFromPreset,
  authSelFromService,
  authSlotFromSel,
  isFullService,
  type AuthSlot,
  type AuthStageSel,
  type HeadersSlot,
} from "$lib/lifecycle.ts";

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

/** ② headers 槽 set 行（名称 + 字面量值；$env:/$secret: 引用语法随值键入）。 */
export interface HeaderSetRow {
  id: number;
  name: string;
  value: string;
}

let headerRowSeq = 1;

export function makeHeaderRow(over: Partial<HeaderSetRow> = {}): HeaderSetRow {
  return { id: headerRowSeq++, name: "", value: "", ...over };
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
  // ── Request lifecycle 四槽（hooks-lifecycle 7.1/7.2）──────────────────
  /** ① auth：四族单选 + bearer（唯一 Bearer 前缀来源）。 */
  auth: { kind: "none" } as AuthStageSel,
  /** ② headers：set 行（空行提交时跳过）。 */
  headerSetRows: [makeHeaderRow()] as HeaderSetRow[],
  /** ② headers：remove 名单草稿（逗号/空白分隔）。 */
  headerRemove: "",
  /** ② headers：整段脚本绑定（"" = 无）。 */
  headersScript: "",
  /** ③ request：脚本绑定（"" = 原生 fetch 直连）。 */
  requestScript: "",
  /** ④ response：脚本绑定（"" = 无）。 */
  responseScript: "",
  /** 预设来源（TestConnection 的模型下拉用；"" = custom）。 */
  presetId: "",
  /** 预设 apiForm（连通测试请求形状；服务模型不落库该字段——custom 缺省
   *  openai-completions，仅草稿期供 services.test 携带）。 */
  apiForm: undefined as ApiForm | undefined,
  busy: false,
  error: null as RpcError | null,
  /** 编辑透传（表单外字段原样带回；脚本 args 仅在脚本名未变时带回）。 */
  passthrough: null as {
    routes?: ServiceAddInput["routes"];
    rewrite?: ServiceAddInput["rewrite"];
    matchExtra?: ServiceAddInput["match"];
    authArgs?: Record<string, string>;
    headersScriptArgs?: Record<string, string>;
    requestArgs?: Record<string, string>;
    responseArgs?: Record<string, string>;
  } | null,
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
  serviceForm.auth = { kind: "none" };
  serviceForm.headerSetRows = [makeHeaderRow()];
  serviceForm.headerRemove = "";
  serviceForm.headersScript = "";
  serviceForm.requestScript = "";
  serviceForm.responseScript = "";
  serviceForm.presetId = "";
  serviceForm.apiForm = undefined;
  serviceForm.error = null;
  serviceForm.passthrough = null;
}

/** 高级页：新建。 */
export function openAdd(): void {
  formReset();
  serviceForm.open = true;
}

/** 高级页：编辑既有服务（回显统一模型；rewrite/routes/非 suffix 规则/
 *  脚本 args 原样透传，编辑保存不丢表单外字段）。 */
export function openEdit(service: ServiceConfigView): void {
  formReset();
  serviceForm.editingName = service.name;
  serviceForm.name = service.name;
  // 分组回显（走查实证 2026-09-13：漏设会让"不改直接保存"必报 group
  // name is required）——取第一个包含该服务的组；无组 = 空（未分组）
  serviceForm.groupName = app.groups.find((g) => g.serviceIds.includes(service.serviceId))?.name ?? "";
  serviceForm.upstream = service.upstream;
  serviceForm.port = String(service.defaultPort);
  // 四槽回显（auth 四族全覆盖；headers 展开为行/名单；脚本绑定取脚本名）
  serviceForm.auth = authSelFromService(service);
  const set = service.headers?.set ?? {};
  const setRows = Object.entries(set).map(([name, value]) => makeHeaderRow({ name, value }));
  serviceForm.headerSetRows = setRows.length > 0 ? setRows : [makeHeaderRow()];
  serviceForm.headerRemove = (service.headers?.remove ?? []).join(", ");
  serviceForm.headersScript = service.headers?.script?.name ?? "";
  serviceForm.requestScript = service.request?.script ?? "";
  serviceForm.responseScript = service.response?.script ?? "";
  const suffixes = service.match.filter((r) => r.type === "suffix").map((r) => r.value);
  serviceForm.customMatch = suffixes.join(", ");
  const matchExtra = service.match.filter((r) => r.type !== "suffix");
  serviceForm.passthrough = {
    ...(service.routes !== undefined && service.routes.length > 0 ? { routes: service.routes } : {}),
    ...(service.rewrite !== undefined &&
    (service.rewrite.host !== undefined ||
      service.rewrite.pathPrefixStrip !== undefined ||
      service.rewrite.pathPrefixAppend !== undefined)
      ? { rewrite: service.rewrite }
      : {}),
    ...(matchExtra.length > 0 ? { matchExtra } : {}),
    ...(service.auth !== undefined && "script" in service.auth && service.auth.args !== undefined
      ? { authArgs: service.auth.args }
      : {}),
    ...(service.headers?.script?.args !== undefined ? { headersScriptArgs: service.headers.script.args } : {}),
    ...(service.request?.args !== undefined ? { requestArgs: service.request.args } : {}),
    ...(service.response?.args !== undefined ? { responseArgs: service.response.args } : {}),
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
  serviceForm.apiForm = preset.apiForm;
  serviceForm.name = preset.id;
  serviceForm.port = String(preset.defaultPort);
  serviceForm.upstream = preset.baseUrl;
  serviceForm.customMatch = preset.matchDomains.join(", ");
  serviceForm.auth = authSelFromPreset(preset);
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

// ---------------------------------------------------------------------------
// 路由行操作（零校验——形状归一在组装期）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// headers 行操作
// ---------------------------------------------------------------------------

export function addHeaderRow(): void {
  if (serviceForm.headerSetRows.length >= 32) return;
  serviceForm.headerSetRows.push(makeHeaderRow());
}
export function removeHeaderRow(id: number): void {
  serviceForm.headerSetRows = serviceForm.headerSetRows.filter((row) => row.id !== id);
  if (serviceForm.headerSetRows.length === 0) serviceForm.headerSetRows = [makeHeaderRow()];
}

/** 脚本换绑时清除对应 args 透传（args 属于旧绑定，不可跟到新脚本）。 */
export function setStageScript(slot: "headers" | "request" | "response", name: string): void {
  if (slot === "headers") {
    if (serviceForm.headersScript !== name && serviceForm.passthrough !== null) delete serviceForm.passthrough.headersScriptArgs;
    serviceForm.headersScript = name;
  } else if (slot === "request") {
    if (serviceForm.requestScript !== name && serviceForm.passthrough !== null) delete serviceForm.passthrough.requestArgs;
    serviceForm.requestScript = name;
  } else {
    if (serviceForm.responseScript !== name && serviceForm.passthrough !== null) delete serviceForm.passthrough.responseArgs;
    serviceForm.responseScript = name;
  }
}

/** auth 换选（script 族换绑时清除 args 透传）。 */
export function setAuthSel(sel: AuthStageSel): void {
  const prev = serviceForm.auth;
  if (
    prev.kind === "script" &&
    sel.kind === "script" &&
    prev.script !== sel.script &&
    serviceForm.passthrough !== null
  ) {
    delete serviceForm.passthrough.authArgs;
  }
  serviceForm.auth = sel;
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

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

/** ② headers 组装：行/名单/脚本 → 契约槽；全空 → undefined（清除绑定）。 */
export function headersSlotFromForm(): HeadersSlot | undefined {
  const set: Record<string, string> = {};
  for (const row of serviceForm.headerSetRows) {
    const name = row.name.trim();
    if (name === "") continue;
    set[name] = row.value;
  }
  const remove = serviceForm.headerRemove
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token !== "");
  const script = serviceForm.headersScript.trim();
  if (Object.keys(set).length === 0 && remove.length === 0 && script === "") return undefined;
  const args = serviceForm.passthrough?.headersScriptArgs;
  return {
    ...(remove.length > 0 ? { remove } : {}),
    ...(Object.keys(set).length > 0 ? { set } : {}),
    ...(script !== ""
      ? { script: { name: script, ...(args !== undefined && Object.keys(args).length > 0 ? { args } : {}) } }
      : {}),
  };
}

/** ③/④ 脚本槽组装："" → undefined；args 仅脚本名未变时透传。 */
function stageScriptSlot(
  name: string,
  args: Record<string, string> | undefined,
): { script: string; args?: Record<string, string> } | undefined {
  const script = name.trim();
  if (script === "") return undefined;
  return { script, ...(args !== undefined && Object.keys(args).length > 0 ? { args } : {}) };
}

/** 当前 auth 草稿（TestConnection 连通测试与摘要共用）。 */
export function authDraft(): AuthSlot | undefined {
  const args = serviceForm.passthrough?.authArgs;
  return authSlotFromSel(serviceForm.auth, args);
}

/** ③/④ 摘要行（管线行/向导摘要短文案）：none / 脚本名。 */
export function stageSummary(name: string): string {
  return name.trim() !== "" ? name.trim() : "none";
}

/** ② headers 摘要行：+n set / -n remove / script 名 / none。 */
export function headersSummary(): string {
  const parts: string[] = [];
  const setCount = serviceForm.headerSetRows.filter((row) => row.name.trim() !== "").length;
  const removeCount = serviceForm.headerRemove
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token !== "").length;
  if (setCount > 0) parts.push(`+${setCount} set`);
  if (removeCount > 0) parts.push(`-${removeCount} remove`);
  if (serviceForm.headersScript.trim() !== "") parts.push(`script ${serviceForm.headersScript.trim()}`);
  return parts.length > 0 ? parts.join(" · ") : "none";
}

/** 校验（② → ③ / Dialog 保存共用）：名称、分组、upstream、端口、literal 值。 */
export function validate(): string | null {
  if (serviceForm.name.trim() === "") return "service name is required";
  if (serviceForm.groupName.trim() === "") return "group name is required";
  if (!/^https?:\/\//.test(serviceForm.upstream.trim())) return "https upstream url is required";
  if (serviceForm.port.trim() !== "" && parsePositiveInt(serviceForm.port) === undefined) {
    return "port must be a positive integer";
  }
  if (serviceForm.auth.kind === "literal" && serviceForm.auth.value.trim() === "") {
    return "auth literal value is required";
  }
  if (matchRules() === null) return "a valid upstream url is required to derive match rules";
  return null;
}

/** 组装完整 services.add 输入（四槽 + rewrite/routes 透传）。 */
export function composeInput(): { ok: true; input: ServiceAddInput } | { ok: false; message: string } {
  const problem = validate();
  if (problem !== null) return { ok: false, message: problem };
  const match = matchRules()!;
  const port = parsePositiveInt(serviceForm.port);
  const auth = authDraft();
  const headers = headersSlotFromForm();
  const request = stageScriptSlot(serviceForm.requestScript, serviceForm.passthrough?.requestArgs);
  const response = stageScriptSlot(serviceForm.responseScript, serviceForm.passthrough?.responseArgs);
  const routes = routesInput();
  const rewrite = serviceForm.passthrough?.rewrite;
  return {
    ok: true,
    input: {
      name: serviceForm.name.trim(),
      upstream: serviceForm.upstream.trim(),
      match,
      ...(port !== undefined ? { defaultPort: port } : {}),
      ...(auth !== undefined ? { auth } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(request !== undefined ? { request } : {}),
      ...(response !== undefined ? { response } : {}),
      ...(routes !== undefined ? { routes } : {}),
      ...(rewrite !== undefined ? { rewrite } : {}),
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
  // legacy 失效壳不参与分组运算（hooks-lifecycle 2.3 联合输出分拣）
  const live = services.filter(isFullService);
  const target = live.find((service) => service.name === serviceName);
  const names = existing.serviceIds
    .map((serviceId) => live.find((service) => service.serviceId === serviceId)?.name)
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
      prevEnabled = services
        .filter(isFullService)
        .find((s) => s.name === serviceForm.editingName)?.enabled;
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
  if (!services.some((s) => isFullService(s) && s.name === serviceName)) {
    const added = await call((c) => c.provider.services.add(parsed.input));
    serviceName = added.service.name;
  }
  await ensureGroupWithService(serviceName);
  return serviceName;
}
