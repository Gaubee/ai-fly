// 高级设置的状态机（B 3.5）：服务增删改（改 = remove+add 原子重排，契约无
// update 过程）、分组新建与成员整表替换、密钥 issue（一次性原文）/revoke、
// relay 配置（system.settings）、models.dev 开关。
// 引擎校验错误就地内联渲染（error 字段）+ toast；变更经通知通道即时反映。
import { toRpcError, type RpcClient, type RpcError } from "$lib/rpc-client";
import type { ServiceConfigView } from "$shared/rpc-contract.ts";
import { t } from "$lib/i18n.svelte.ts";
import { call } from "./rpc.svelte.ts";
import { toastRpcError, toastSuccess } from "./toast.svelte.ts";
import { app, refresh } from "./app.svelte.ts";
import { parsePositiveInt } from "./service-form.svelte.ts";


/** services.add 的输入类型（契约推导，保持单源）。 */
type ServiceAddInput = Parameters<RpcClient["provider"]["services"]["add"]>[0];

/** 注入值脱敏：$secret 显示面板名（值只在本机密钥库）；$env 维持 ●，无变量名。 */
export function maskSecret(value: string): string {
  if (value.startsWith("$secret:")) return `secret panel: ${value.slice(8)}`;
  return value.startsWith("$env:") ? "\u25cf" : value;
}

// ---------------------------------------------------------------------------
// 服务：增 / 删 / 改（remove+add）
// ---------------------------------------------------------------------------







export const serviceRemove = $state({
  confirm: "",
  busy: "",
  error: null as RpcError | null,
});

export async function removeService(name: string): Promise<void> {
  if (serviceRemove.busy !== "") return;
  serviceRemove.busy = name;
  serviceRemove.error = null;
  try {
    await call((c) => c.provider.services.remove({ name }));
    toastSuccess("Service removed", name);
    refresh("services", "provider", "groups");
  } catch (error) {
    serviceRemove.error = toRpcError(error);
    toastRpcError(serviceRemove.error);
  } finally {
    serviceRemove.busy = "";
    serviceRemove.confirm = "";
  }
}

// ---------------------------------------------------------------------------
// 服务启停（service-lifecycle）：停暴露不删配置；AUTH_OK 目录排除 disabled →
// 消费端监听自然关停传导。开关单飞锁（busy = serviceId）。
// ---------------------------------------------------------------------------

export const serviceRunning = $state({
  busy: "",
  error: null as RpcError | null,
});

export async function setServiceRunning(serviceId: string, running: boolean, name: string): Promise<void> {
  if (serviceRunning.busy !== "") return;
  serviceRunning.busy = serviceId;
  serviceRunning.error = null;
  try {
    await call((c) => c.provider.services.setRunning({ serviceId, running }));
    toastSuccess(t(running ? "svc.runningToast" : "svc.stoppedToast"), name);
    await refresh("services", "provider");
  } catch (error) {
    serviceRunning.error = toRpcError(error);
    toastRpcError(serviceRunning.error);
  } finally {
    serviceRunning.busy = "";
  }
}

// ---------------------------------------------------------------------------
// 分组：新建（可带限额）/ 行内编辑（成员整表替换 + 限额更新）/ 删除
// （组内仍有未撤销密钥 → 引擎 CONFLICT，toast 带 revoke them first）
// ---------------------------------------------------------------------------

export const groupForm = $state({
  open: false,
  name: "",
  serviceNames: [] as string[],
  limitsConcurrency: "",
  limitsDaily: "",
  busy: false,
  error: null as RpcError | null,
});

export function openGroupAdd(): void {
  groupForm.open = true;
  groupForm.name = "";
  groupForm.serviceNames = [];
  groupForm.limitsConcurrency = "";
  groupForm.limitsDaily = "";
  groupForm.error = null;
}

export async function submitGroupAdd(): Promise<void> {
  if (groupForm.busy) return;
  if (groupForm.name.trim() === "") {
    groupForm.error = { code: "INVALID_INPUT", message: "group name is required" };
    return;
  }
  const maxConcurrency = parsePositiveInt(groupForm.limitsConcurrency);
  const dailyRequests = parsePositiveInt(groupForm.limitsDaily);
  if (
    (groupForm.limitsConcurrency.trim() !== "" && maxConcurrency === undefined) ||
    (groupForm.limitsDaily.trim() !== "" && dailyRequests === undefined)
  ) {
    groupForm.error = { code: "INVALID_INPUT", message: "limits must be positive integers" };
    return;
  }
  groupForm.busy = true;
  groupForm.error = null;
  try {
    await call((c) =>
      c.provider.groups.add({
        name: groupForm.name.trim(),
        serviceNames: groupForm.serviceNames,
        ...(maxConcurrency !== undefined || dailyRequests !== undefined
          ? {
              limits: {
                ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
                ...(dailyRequests !== undefined ? { dailyRequests } : {}),
              },
            }
          : {}),
      }),
    );
    groupForm.open = false;
    toastSuccess("Group created", groupForm.name.trim());
    refresh("groups", "provider");
  } catch (error) {
    groupForm.error = toRpcError(error);
    toastRpcError(groupForm.error);
  } finally {
    groupForm.busy = false;
  }
}

export const groupEdit = $state({
  /** 正在编辑的分组名（空 = 无）。 */
  open: "",
  draft: [] as string[],
  /** 限额草稿（空串 = unlimited；保存时 setLimits，省略即清除）。 */
  limitsConcurrency: "",
  limitsDaily: "",
  busy: false,
  error: null as RpcError | null,
});

/** 限额草稿校验（非法 → 消息；合法 → null）。 */
function groupLimitsProblem(): string | null {
  if (
    (groupEdit.limitsConcurrency.trim() !== "" && parsePositiveInt(groupEdit.limitsConcurrency) === undefined) ||
    (groupEdit.limitsDaily.trim() !== "" && parsePositiveInt(groupEdit.limitsDaily) === undefined)
  ) {
    return "limits must be positive integers";
  }
  return null;
}

export function openGroupEdit(
  name: string,
  current: string[],
  limits?: { maxConcurrency?: number; dailyRequests?: number },
): void {
  groupEdit.open = name;
  groupEdit.draft = [...current];
  groupEdit.limitsConcurrency = limits?.maxConcurrency !== undefined ? String(limits.maxConcurrency) : "";
  groupEdit.limitsDaily = limits?.dailyRequests !== undefined ? String(limits.dailyRequests) : "";
  groupEdit.error = null;
}

/** 行内编辑保存：成员整表替换（setServices）+ 限额更新（空 = 清除为无限）。 */
export async function submitGroupEdit(): Promise<void> {
  if (groupEdit.busy || groupEdit.open === "") return;
  const problem = groupLimitsProblem();
  if (problem !== null) {
    groupEdit.error = { code: "INVALID_INPUT", message: problem };
    return;
  }
  const maxConcurrency = parsePositiveInt(groupEdit.limitsConcurrency);
  const dailyRequests = parsePositiveInt(groupEdit.limitsDaily);
  groupEdit.busy = true;
  groupEdit.error = null;
  try {
    await call((c) =>
      c.provider.groups.setServices({ name: groupEdit.open, serviceNames: groupEdit.draft }),
    );
    await call((c) =>
      c.provider.groups.setLimits({
        name: groupEdit.open,
        ...(maxConcurrency !== undefined || dailyRequests !== undefined
          ? {
              limits: {
                ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
                ...(dailyRequests !== undefined ? { dailyRequests } : {}),
              },
            }
          : {}),
      }),
    );
    toastSuccess("Group updated", groupEdit.open);
    groupEdit.open = "";
    refresh("groups", "provider");
  } catch (error) {
    groupEdit.error = toRpcError(error);
    toastRpcError(groupEdit.error);
  } finally {
    groupEdit.busy = false;
  }
}

export const groupRemove = $state({
  confirm: "",
  busy: "",
  error: null as RpcError | null,
});

/** 删除分组（组内仍有未撤销密钥 → 引擎 CONFLICT，错误信息含 revoke them first）。 */
export async function removeGroup(name: string): Promise<void> {
  if (groupRemove.busy !== "") return;
  groupRemove.busy = name;
  groupRemove.error = null;
  try {
    await call((c) => c.provider.groups.remove({ name }));
    toastSuccess("Group removed", name);
    // 正在编辑的组被删 → 收起编辑块（行已消失）
    if (groupEdit.open === name) groupEdit.open = "";
    refresh("groups", "provider");
  } catch (error) {
    groupRemove.error = toRpcError(error);
    toastRpcError(groupRemove.error);
  } finally {
    groupRemove.busy = "";
    groupRemove.confirm = "";
  }
}

// ---------------------------------------------------------------------------
// 密钥：issue（一次性原文 dialog）/ revoke（幂等）
// ---------------------------------------------------------------------------

export const keyIssue = $state({
  group: "",
  /** key 名（Owner 裁决 2026-09-13 #5：签发时必填；缺省 "default"）。 */
  name: "default",
  busy: false,
  error: null as RpcError | null,
});

export async function issueKey(): Promise<void> {
  if (keyIssue.busy || keyIssue.group === "") return;
  keyIssue.busy = true;
  keyIssue.error = null;
  try {
    await call((c) =>
      c.provider.keys.issue({ group: keyIssue.group, name: keyIssue.name.trim() || "default" }),
    );
    // 原文随库可复制（#5）——不再弹一次性 dialog；分组视图 key 行直接可复制
    refresh("keys", "provider");
  } catch (error) {
    keyIssue.error = toRpcError(error);
    toastRpcError(keyIssue.error);
  } finally {
    keyIssue.busy = false;
  }
}

export const keyRevoke = $state({
  confirm: "",
  busy: "",
  error: null as RpcError | null,
});

export async function revokeKey(keyId: string): Promise<void> {
  if (keyRevoke.busy !== "") return;
  keyRevoke.busy = keyId;
  keyRevoke.error = null;
  try {
    await call((c) => c.provider.keys.revoke({ keyId }));
    toastSuccess("Key revoked", keyId);
    refresh("keys", "provider");
  } catch (error) {
    keyRevoke.error = toRpcError(error);
    toastRpcError(keyRevoke.error);
  } finally {
    keyRevoke.busy = "";
    keyRevoke.confirm = "";
  }
}

// ---------------------------------------------------------------------------
// relay 与设置（system.settings）
// ---------------------------------------------------------------------------

export const relayForm = $state({
  text: "",
  busy: false,
  error: null as RpcError | null,
  savedTick: 0,
});

/** 由 settings 初始化编辑框（每行一个 URL；null/未配置 → 空）。 */
export function initRelayForm(): void {
  const urls = app.settings?.relayUrls;
  relayForm.text = urls !== null && urls !== undefined ? urls.join("\n") : "";
  relayForm.error = null;
}

export async function saveRelay(): Promise<void> {
  if (relayForm.busy) return;
  const lines = relayForm.text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length > 8) {
    relayForm.error = { code: "INVALID_INPUT", message: "at most 8 relay URLs" };
    return;
  }
  // relay URL scheme = http(s)（与 iroh RelayMap 同规；dweb-server 对非 http(s)
  // 条目按禁用处理并 WARNING——wss:// 是历史误植，此处一并纠正）
  if (lines.some((line) => !/^https?:\/\//.test(line))) {
    relayForm.error = { code: "INVALID_INPUT", message: "relay URLs must start with http:// or https://" };
    return;
  }
  relayForm.busy = true;
  relayForm.error = null;
  try {
    await call((c) =>
      c.system.settings.set({ relayUrls: lines.length === 0 ? null : lines }),
    );
    relayForm.savedTick += 1;
    toastSuccess("Relay entries saved", lines.length === 0 ? "using SDK default" : `${lines.length} entr(y|ies)`);
    refresh("settings", "provider");
  } catch (error) {
    relayForm.error = toRpcError(error);
    toastRpcError(relayForm.error);
  } finally {
    relayForm.busy = false;
  }
}

export const settingsEdit = $state({
  modelsDevBusy: false,
  error: null as RpcError | null,
});

/** 保存 relay 选择（RelayPickerDialog 的 save；null = SDK 默认）。 */
export async function saveRelayChoice(urls: string[] | null): Promise<void> {
  await call((c) => c.system.settings.set({ relayUrls: urls }));
  refresh("settings", "provider");
}

export async function setModelsDev(enabled: boolean): Promise<void> {
  if (settingsEdit.modelsDevBusy) return;
  settingsEdit.modelsDevBusy = true;
  settingsEdit.error = null;
  try {
    await call((c) => c.system.settings.set({ modelsDevEnabled: enabled }));
    refresh("settings");
  } catch (error) {
    settingsEdit.error = toRpcError(error);
    toastRpcError(settingsEdit.error);
  } finally {
    settingsEdit.modelsDevBusy = false;
  }
}

// ---------------------------------------------------------------------------
// hooks 脚本资源域（Owner 视觉验收 2026-09-12：管理面同 group/secret）
// ---------------------------------------------------------------------------

export interface HookScriptRow {
  name: string;
  source: "user" | "builtin";
  fns: string[];
}

export const hooksPanel = $state({
  scripts: [] as HookScriptRow[],
  loaded: false,
  busy: false,
  error: null as RpcError | null,
});

export async function loadHooks(force = false): Promise<void> {
  if (hooksPanel.busy || (hooksPanel.loaded && !force)) return;
  hooksPanel.busy = true;
  hooksPanel.error = null;
  try {
    const result = await call((c) => c.provider.hooks.list({}));
    hooksPanel.scripts = result.hooks;
    hooksPanel.loaded = true;
  } catch (error) {
    hooksPanel.error = toRpcError(error);
    toastRpcError(hooksPanel.error);
  } finally {
    hooksPanel.busy = false;
  }
}

export const hookView = $state({
  open: false,
  name: "",
  source: "user" as "user" | "builtin",
  path: "",
  content: "",
  busy: false,
  error: null as RpcError | null,
});

export async function openHookView(name: string): Promise<void> {
  hookView.open = true;
  hookView.name = name;
  hookView.busy = true;
  hookView.error = null;
  hookView.content = "";
  try {
    const found = await call((c) => c.provider.hooks.get({ name }));
    hookView.source = found.source;
    hookView.path = found.path;
    hookView.content = found.content;
  } catch (error) {
    hookView.error = toRpcError(error);
  } finally {
    hookView.busy = false;
  }
}

export const hookAdd = $state({
  open: false,
  name: "",
  content: "",
  busy: false,
  error: null as RpcError | null,
});

export async function submitHookAdd(): Promise<void> {
  if (hookAdd.busy) return;
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(hookAdd.name.trim())) {
    hookAdd.error = { code: "INVALID_INPUT", message: "name: lowercase identifier (letters/digits/-/_)" };
    return;
  }
  if (hookAdd.content.trim() === "") {
    hookAdd.error = { code: "INVALID_INPUT", message: "script content is required" };
    return;
  }
  hookAdd.busy = true;
  hookAdd.error = null;
  try {
    const installed = await call((c) =>
      c.provider.hooks.add({ name: hookAdd.name.trim(), content: hookAdd.content }),
    );
    hookAdd.open = false;
    toastSuccess("Hook script installed", `${installed.name} (${installed.fns.join(", ")})`);
    await loadHooks(true);
  } catch (error) {
    hookAdd.error = toRpcError(error);
    toastRpcError(hookAdd.error);
  } finally {
    hookAdd.busy = false;
  }
}

export async function removeHookScript(name: string): Promise<void> {
  try {
    await call((c) => c.provider.hooks.remove({ name }));
    toastSuccess("Hook script removed", name);
    await loadHooks(true);
  } catch (error) {
    toastRpcError(toRpcError(error));
  }
}

