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

/** 注入值脱敏：$secret 显示面板名（值只在本机密钥库）；$env 维持 ●，无变量名。 */
export function maskSecret(value: string): string {
  if (value.startsWith("$secret:")) return `secret panel: ${value.slice(8)}`;
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
  /** 选中密钥名（undefined = 不注入 authorization；$secret: 语法，M3 6.2）。 */
  secretName: undefined as string | undefined,
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
  serviceForm.secretName = undefined;
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
  serviceForm.secretName =
    authorization?.startsWith("$secret:") ? authorization.slice("$secret:".length) : undefined;
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
  const secretName = serviceForm.secretName?.trim();
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
      // 有密钥 → $secret: 注入（引擎请求期从本机密钥库取值）；无 → 不带
      ...(secretName !== undefined && secretName !== ""
        ? { rewrite: { headerSet: { authorization: `$secret:${secretName}` } } }
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

// ---------------------------------------------------------------------------
// 自托管 opendweb server（dweb-server 子进程；settings.opendwebServer 驱动）
// ---------------------------------------------------------------------------

/** system.opendweb.status 输出（契约推导）。 */
type OpendwebStatus = Awaited<ReturnType<RpcClient["system"]["opendweb"]["status"]>>;
export type { OpendwebStatus };

export const DEFAULT_GATEWAY_BIND = "127.0.0.1:8787";
export const DEFAULT_RELAY_BIND = "127.0.0.1:3340";

/** 绑定地址本地校验（镜像契约 BIND_ADDRESS_SCHEMA，不引 zod 运行时）。 */
export function bindAddressProblem(value: string): string | null {
  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9.\-]+:\d{1,5}$/.test(trimmed)) return "bind must be host:port";
  const port = Number.parseInt(trimmed.split(":")[1] ?? "", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "port must be in 1..65535";
  return null;
}

export const opendwebEdit = $state({
  enabled: false,
  gatewayBind: DEFAULT_GATEWAY_BIND,
  relayBind: DEFAULT_RELAY_BIND,
  relayEnabled: true,
  busy: false,
  error: null as RpcError | null,
  status: null as OpendwebStatus | null,
  statusBusy: false,
});

/** settings 到达后（或进 tab 时）回填表单（一次）。 */
export function initOpendwebForm(): void {
  const config = app.settings?.opendwebServer;
  if (config === null || config === undefined) {
    opendwebEdit.enabled = false;
    opendwebEdit.gatewayBind = DEFAULT_GATEWAY_BIND;
    opendwebEdit.relayBind = DEFAULT_RELAY_BIND;
    opendwebEdit.relayEnabled = true;
    return;
  }
  opendwebEdit.enabled = config.enabled;
  opendwebEdit.gatewayBind = config.gatewayBind;
  opendwebEdit.relayBind = config.relayBind;
  opendwebEdit.relayEnabled = config.relayEnabled;
}

export async function refreshOpendwebStatus(): Promise<void> {
  if (opendwebEdit.statusBusy) return;
  opendwebEdit.statusBusy = true;
  try {
    opendwebEdit.status = await call((c) => c.system.opendweb.status({}));
  } catch {
    // 拉取失败静默（状态面板显示上次快照；保存路径的 set 会再刷）
  } finally {
    opendwebEdit.statusBusy = false;
  }
}

/** 保存并立即对账子进程（settings.set → manager.apply → 刷状态）。 */
export async function saveOpendweb(): Promise<void> {
  if (opendwebEdit.busy) return;
  const gatewayBind = opendwebEdit.gatewayBind.trim();
  const relayBind = opendwebEdit.relayBind.trim();
  for (const problem of [bindAddressProblem(gatewayBind), bindAddressProblem(relayBind)]) {
    if (problem !== null) {
      opendwebEdit.error = { code: "INVALID_INPUT", message: problem };
      return;
    }
  }
  if (opendwebEdit.relayEnabled && gatewayBind === relayBind) {
    opendwebEdit.error = { code: "INVALID_INPUT", message: "gateway and relay binds must differ" };
    return;
  }
  opendwebEdit.busy = true;
  opendwebEdit.error = null;
  try {
    await call((c) =>
      c.system.settings.set({
        opendwebServer: {
          enabled: opendwebEdit.enabled,
          gatewayBind,
          relayBind,
          relayEnabled: opendwebEdit.relayEnabled,
        },
      }),
    );
    toastSuccess(
      "Opendweb server saved",
      opendwebEdit.enabled ? "applied - child process reconciled" : "server stopped",
    );
    refresh("settings");
    await refreshOpendwebStatus();
  } catch (error) {
    opendwebEdit.error = toRpcError(error);
    toastRpcError(opendwebEdit.error);
  } finally {
    opendwebEdit.busy = false;
  }
}

/** 自己服务器的 relay URL（fabric 形态 http://relayBind）。 */
export function ownServerRelayUrl(): string | null {
  const status = opendwebEdit.status;
  if (status === null || !status.running) return null;
  const bind = status.config?.relayBind;
  return bind === undefined || bind === null ? null : `http://${bind}`;
}

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
