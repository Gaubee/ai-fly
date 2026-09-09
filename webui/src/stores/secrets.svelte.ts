// 密钥库 store（M3 6.2）：provider-local 密钥座行的反应式封装。
// 契约只回名称与时间戳——值由设计不跨 RPC，UI 亦不回显。
// 正交意图：
// - names/loading/loaded（loaded 区分「未加载」与「空库」，供选择器
//   判定「选中项已不存在」时避免误清）。
// - refresh/set/remove 包装（错误走 toastRpcError，调用方以 boolean 收口）。
import { toRpcError } from "$lib/rpc-client";
import { call } from "./rpc.svelte.ts";
import { toastRpcError } from "./toast.svelte.ts";

export const secrets = $state({
  loading: false,
  /** 首轮 list 成功后为 true（区分「未加载」与「空库」）。 */
  loaded: false,
  names: [] as string[],
});

/** 拉取密钥库名单（在途去重；失败 toast——面板场景用户在场）。 */
export async function refreshSecrets(): Promise<void> {
  if (secrets.loading) return;
  secrets.loading = true;
  try {
    const result = await call((c) => c.provider.secrets.list({}));
    secrets.names = result.secrets.map((entry) => entry.name);
    secrets.loaded = true;
  } catch (error) {
    toastRpcError(toRpcError(error));
  } finally {
    secrets.loading = false;
  }
}

/** 新增/覆写（value 为完整头值，如 "Bearer sk-…"；成功后刷新名单）。 */
export async function setSecret(name: string, value: string): Promise<boolean> {
  try {
    await call((c) => c.provider.secrets.set({ name, value }));
    await refreshSecrets();
    return true;
  } catch (error) {
    toastRpcError(toRpcError(error));
    return false;
  }
}

/** 删除（成功后刷新名单）。 */
export async function removeSecret(name: string): Promise<boolean> {
  try {
    await call((c) => c.provider.secrets.remove({ name }));
    await refreshSecrets();
    return true;
  } catch (error) {
    toastRpcError(toRpcError(error));
    return false;
  }
}
