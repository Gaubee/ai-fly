// 提供方分享向导流程状态（#/share 三步）：①来源（预设卡/自定义）→ ②服务
// 表单（ServiceForm 组件 + stores/service-form.svelte.ts 统一模型）→
// ③分组密钥视图（GroupKeysPanel；服务/分组/daemon/保底 key 幂等落位）。
// 本文件只持流程状态（步骤/来源/TTL/在途/错误）；表单字段与组装一律在
// service-form store（Owner 裁决 2026-09-13 #5：两处编辑同一套代码）。

import { toRpcError, type RpcError } from "$lib/rpc-client";
import { call } from "./rpc.svelte.ts";
import { toastRpcError } from "./toast.svelte.ts";
import { refresh } from "./app.svelte.ts";
import { serviceForm, ensureCreated, choosePreset as formChoosePreset, chooseCustom as formChooseCustom, validate } from "./service-form.svelte.ts";

export { TTL_OPTIONS } from "./service-form.svelte.ts";

export const share = $state({
  step: 1 as 1 | 2 | 3,
  /** 来源模式：preset（预设展开）/ custom（手填）。 */
  mode: "preset" as "preset" | "custom",
  presetId: "",
  // ③ group 视图：分享 Dialog 的默认 TTL（GroupKeysPanel 内可改）
  ttlMs: 3_600_000,
  /** 在途阶段（'' | 'service' | 'group' | 'daemon' | 'key'）。 */
  busy: "",
  error: null as RpcError | null,
});

/** 重置向导（进入页面/完成后重新开始）。 */
export function resetShare(): void {
  share.step = 1;
  share.mode = "preset";
  share.presetId = "";
  share.busy = "";
  share.error = null;
}

/** ① 选预设：表单预填进 service-form store，流程步进到②。 */
export function choosePreset(preset: { id: string } & Parameters<typeof formChoosePreset>[0]): void {
  share.mode = "preset";
  share.presetId = preset.id;
  formChoosePreset(preset);
  share.error = null;
  share.step = 2;
}

/** ① 选自定义：表单复位，步进到②。 */
export function chooseCustom(): void {
  share.mode = "custom";
  share.presetId = "";
  formChooseCustom();
  share.error = null;
  share.step = 2;
}

/** 回退（③ 允许回②改配置——重进③幂等：服务已存在则跳过）。 */
export function shareBack(): void {
  if (share.step <= 1) return;
  share.step = (share.step - 1) as 1 | 2;
  share.error = null;
}

/** ② → ③ 前进（校验在 service-form store）。 */
export function namingNext(): void {
  const problem = validate();
  if (problem !== null) {
    share.error = { code: "INVALID_INPUT", message: problem };
    return;
  }
  share.error = null;
  share.step = 3;
}

/**
 * ③ 进入 group 视图：服务（幂等补建）→ 分组 → daemon → 保底 key
 * （组内无活跃 key 自动签发 "default"）。链接铸造在 GroupKeysPanel 的
 * 分享 Dialog。
 */
export async function enterGroupView(): Promise<void> {
  if (share.busy !== "" || share.step !== 3) return;
  share.error = null;
  try {
    // ensureCreated：服务幂等补建 + 组归属（service-form store 统一组装）
    share.busy = "service";
    await ensureCreated();

    share.busy = "daemon";
    await call((c) => c.provider.daemon.start({}));

    share.busy = "key";
    const { keys } = await call((c) => c.provider.keys.list({}));
    if (!keys.some((k) => k.group === serviceForm.groupName && k.revokedAt === undefined)) {
      await call((c) => c.provider.keys.issue({ group: serviceForm.groupName, name: "default" }));
    }
    refresh("provider", "groups", "services", "keys");
  } catch (error) {
    share.error = toRpcError(error);
    toastRpcError(share.error);
  } finally {
    share.busy = "";
  }
}
