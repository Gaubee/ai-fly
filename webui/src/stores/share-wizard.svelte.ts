// 提供方分享向导状态机（B 3.2 / M3 3.2·3.3·6.2·6.3，#/share 三步）：
// ①服务来源（预设卡片 / 自定义 URL）→ ②命名与分组（可新建组、密钥选择器
// secretName、连通测试；限额收进 advanced options）→ ③生成分享
// （applyAsService/services.add + 分组落位 + daemon 幂等启动 +
// share.create → 链接 + 警示 + TTL）。选中密钥时：preset 路径传
// secretName（服务端写 $secret:<name>）；custom 路径手组
// rewrite.headerSet.authorization = $secret:<name>，match 留空时由
// upstream hostname 派生单条 exact（M3-acceptance ③）。
// 每步可回退；成功后锁定结果视图（回退会重复建服务，故隐藏 Back）。
import { toRpcError, type RpcError } from "$lib/rpc-client";
import type { Preset } from "$shared/rpc-contract.ts";
import { call } from "./rpc.svelte.ts";
import { toastRpcError, toastSuccess } from "./toast.svelte.ts";
import { refresh } from "./app.svelte.ts";

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

/** ① 选择预设 → 预填 ② 并前进（密钥选择器留空，由用户挑选）。 */
export function choosePreset(preset: Preset): void {
  share.mode = "preset";
  share.presetId = preset.id;
  share.name = preset.id;
  share.port = String(preset.defaultPort);
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

/** 自定义 match 组装：手填 → suffix；留空 → new URL(upstream).hostname 单条
 *  exact（解析失败返回 null——维持既有校验错误文案）。 */
function customMatchRules(): Array<{ type: "exact" | "suffix"; value: string }> | null {
  const manual = share.customMatch.trim();
  if (manual !== "") return [{ type: "suffix", value: manual }];
  try {
    return [{ type: "exact", value: new URL(share.customUpstream.trim()).hostname }];
  } catch {
    return null;
  }
}

/** ② → ③ 校验：名称、分组名非空；端口/限额可解析。 */
export function namingValid(): string | null {
  if (share.name.trim() === "") return "service name is required";
  if (share.groupName.trim() === "") return "group name is required";
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
    let serviceName: string;
    if (share.mode === "preset") {
      const applied = await call((c) =>
        c.presets.applyAsService({
          presetId: share.presetId,
          ...(share.name.trim() !== "" ? { name: share.name.trim() } : {}),
          ...(parsePositiveInt(share.port) !== undefined ? { port: parsePositiveInt(share.port) } : {}),
          ...(share.secretName !== undefined ? { secretName: share.secretName } : {}),
        }),
      );
      serviceName = applied.service.name;
    } else {
      // match：手填 suffix；留空 → upstream hostname 单条 exact（M3-acceptance ③）
      const match = customMatchRules();
      if (match === null) {
        share.error = { code: "INVALID_INPUT", message: "name, https upstream and match domain are required" };
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
        }),
      );
      serviceName = added.service.name;
    }

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
