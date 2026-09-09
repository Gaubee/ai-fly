// 密钥库 store（M3 6.2）：provider-local 密钥座行的反应式封装。
// 契约只回名称/时间戳/bearerPrefix——值由设计不跨 RPC，UI 亦不回显。
// 正交意图：
// - names/entries/loading/loaded（loaded 区分「未加载」与「空库」，供选择器
//   判定「选中项已不存在」时避免误清；entries 供编辑表单回填 bearer 开关）。
// - refresh/set/remove 包装（错误走 toastRpcError，调用方以 boolean 收口）。
import { toRpcError } from "$lib/rpc-client";
import { call } from "./rpc.svelte.ts";
import { toastRpcError } from "./toast.svelte.ts";

/** 契约密钥行（M3-acceptance ①：含 bearerPrefix；值不跨 RPC）。 */
export interface SecretEntryView {
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 注入时自动拼 "Bearer "（编辑表单回填开关初值）。 */
  bearerPrefix: boolean;
}

export const secrets = $state({
  loading: false,
  /** 首轮 list 成功后为 true（区分「未加载」与「空库」）。 */
  loaded: false,
  names: [] as string[],
  /** 完整行（names 的超集，编辑表单用）。 */
  entries: [] as SecretEntryView[],
});

/** 拉取密钥库名单（在途去重；失败 toast——面板场景用户在场）。 */
export async function refreshSecrets(): Promise<void> {
  if (secrets.loading) return;
  secrets.loading = true;
  try {
    const result = await call((c) => c.provider.secrets.list({}));
    secrets.entries = result.secrets;
    secrets.names = result.secrets.map((entry) => entry.name);
    secrets.loaded = true;
  } catch (error) {
    toastRpcError(toRpcError(error));
  } finally {
    secrets.loading = false;
  }
}

/**
 * 新增/覆写（value 为裸密钥，如 "sk-…"；成功后刷新名单）。
 * bearerPrefix=true（缺省）注入时自动拼 "Bearer "；false 按原样（非 Bearer 站点）。
 */
export async function setSecret(name: string, value: string, bearerPrefix?: boolean): Promise<boolean> {
  try {
    await call((c) => c.provider.secrets.set({ name, value, bearerPrefix }));
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
