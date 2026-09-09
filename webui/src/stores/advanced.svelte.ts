// 高级设置的状态机（B 3.5）：服务增删改（改 = remove+add 原子重排，契约无
// update 过程）、分组新建与成员整表替换、密钥 issue（一次性原文）/revoke、
// relay 配置（system.settings）、models.dev 开关。
// 引擎校验错误就地内联渲染（error 字段）+ toast；变更经通知通道即时反映。
import { toRpcError, type RpcClient, type RpcError } from "$lib/rpc-client";
import type { ServiceConfigView } from "$shared/rpc-contract.ts";
import { call } from "./rpc.svelte.ts";
import { toastRpcError, toastSuccess } from "./toast.svelte.ts";
import { app, refresh } from "./app.svelte.ts";
import { parsePositiveInt } from "./share-wizard.svelte.ts";

/** services.add 的输入类型（契约推导，保持单源）。 */
type ServiceAddInput = Parameters<RpcClient["provider"]["services"]["add"]>[0];

/** $env 注入值脱敏：凭据值位置显示 ●，无变量名（与 AUTH_OK 披露同源）。 */
export function maskSecret(value: string): string {
  return value.startsWith("$env:") ? "\u25cf" : value;
}

// ---------------------------------------------------------------------------
// 服务：增 / 删 / 改（remove+add）
// ---------------------------------------------------------------------------

export const serviceForm = $state({
  open: false,
  /** 编辑中的原服务名（空 = 新建）。 */
  editingName: "",
  name: "",
  upstream: "",
  port: "",
  keyEnv: "",
  match: [{ type: "suffix", value: "" }] as Array<{ type: string; value: string }>,
  busy: false,
  error: null as RpcError | null,
});

export function openServiceAdd(): void {
  serviceForm.open = true;
  serviceForm.editingName = "";
  serviceForm.name = "";
  serviceForm.upstream = "";
  serviceForm.port = "";
  serviceForm.keyEnv = "";
  serviceForm.match = [{ type: "suffix", value: "" }];
  serviceForm.error = null;
}

export function openServiceEdit(service: ServiceConfigView): void {
  serviceForm.open = true;
  serviceForm.editingName = service.name;
  serviceForm.name = service.name;
  serviceForm.upstream = service.upstream;
  serviceForm.port = String(service.defaultPort);
  const authorization = service.rewrite?.headerSet?.["authorization"];
  serviceForm.keyEnv = authorization?.startsWith("$env:") ? authorization.slice(5) : "";
  serviceForm.match = service.match.map((rule) => ({ type: rule.type, value: rule.value }));
  serviceForm.error = null;
}

export function closeServiceForm(): void {
  if (serviceForm.busy) return;
  serviceForm.open = false;
  serviceForm.error = null;
}

/** 表单 → services.add 输入；本地校验失败返回错误消息。 */
function serviceInput(): { ok: true; input: ServiceAddInput } | { ok: false; message: string } {
  const name = serviceForm.name.trim();
  const upstream = serviceForm.upstream.trim();
  const match = serviceForm.match
    .map((rule) => ({ type: rule.type as "exact" | "suffix" | "regex", value: rule.value.trim() }))
    .filter((rule) => rule.value !== "");
  const port = parsePositiveInt(serviceForm.port);
  if (name === "") return { ok: false, message: "service name is required" };
  if (!/^https?:\/\//.test(upstream)) return { ok: false, message: "upstream must be an http(s) URL" };
  if (match.length === 0) return { ok: false, message: "at least one match rule is required" };
  if (serviceForm.port.trim() !== "" && port === undefined) {
    return { ok: false, message: "port must be a positive integer" };
  }
  return {
    ok: true,
    input: {
      name,
      upstream,
      match,
      ...(port !== undefined ? { defaultPort: port } : {}),
      ...(serviceForm.keyEnv.trim() !== ""
        ? { rewrite: { headerSet: { authorization: `$env:${serviceForm.keyEnv.trim()}` } } }
        : {}),
    },
  };
}

/** 提交服务表单（新建 add；编辑 = remove 旧名 + add 新配置）。 */
export async function submitService(): Promise<void> {
  if (serviceForm.busy) return;
  const parsed = serviceInput();
  if (!parsed.ok) {
    serviceForm.error = { code: "INVALID_INPUT", message: parsed.message };
    return;
  }
  serviceForm.busy = true;
  serviceForm.error = null;
  try {
    if (serviceForm.editingName !== "" && serviceForm.editingName !== parsed.input.name) {
      // 改名：契约无 update，remove+add 序列（引擎校验同样兜底）
      await call((c) => c.provider.services.remove({ name: serviceForm.editingName }));
    }
    await call((c) => c.provider.services.add(parsed.input));
    serviceForm.open = false;
    toastSuccess(
      serviceForm.editingName !== "" ? "Service updated" : "Service added",
      parsed.input.name,
    );
    refresh("services", "provider", "groups");
  } catch (error) {
    serviceForm.error = toRpcError(error);
    toastRpcError(serviceForm.error);
  } finally {
    serviceForm.busy = false;
  }
}

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
// 分组：新建（可带限额）/ 成员整表替换（limits 契约只在创建时设置）
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
  /** 正在编辑成员的分组名（空 = 无）。 */
  open: "",
  draft: [] as string[],
  busy: false,
  error: null as RpcError | null,
});

export function openGroupEdit(name: string, current: string[]): void {
  groupEdit.open = name;
  groupEdit.draft = [...current];
  groupEdit.error = null;
}

export async function submitGroupEdit(): Promise<void> {
  if (groupEdit.busy || groupEdit.open === "") return;
  groupEdit.busy = true;
  groupEdit.error = null;
  try {
    await call((c) =>
      c.provider.groups.setServices({ name: groupEdit.open, serviceNames: groupEdit.draft }),
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

// ---------------------------------------------------------------------------
// 密钥：issue（一次性原文 dialog）/ revoke（幂等）
// ---------------------------------------------------------------------------

export const keyIssue = $state({
  group: "",
  busy: false,
  error: null as RpcError | null,
  /** 一次性原文（dialog 展示 + 复制；关闭即弃）。 */
  result: null as { keyId: string; key: string } | null,
});

export async function issueKey(): Promise<void> {
  if (keyIssue.busy || keyIssue.group === "") return;
  keyIssue.busy = true;
  keyIssue.error = null;
  try {
    const result = await call((c) => c.provider.keys.issue({ group: keyIssue.group }));
    keyIssue.result = { keyId: result.keyId, key: result.key };
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
  if (lines.some((line) => !/^wss?:\/\//.test(line))) {
    relayForm.error = { code: "INVALID_INPUT", message: "relay URLs must start with ws:// or wss://" };
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
