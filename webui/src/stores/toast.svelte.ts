// 应用级 toast 单例（SPA 单实例；store 由应用创建、viewport 消费——
// toast-store 的两缝契约）。错误 toast 统一走 toastRpcError：英文 ASCII
// 标题携带六码 code，正文携带引擎消息。
import { createToastStore, type ToastStore } from "$lib/toast-store";
import type { RpcError } from "$lib/rpc-client";

export const toast: ToastStore = createToastStore();

/** RPC/引擎错误 → assertive tonal error toast（不自动消失）。 */
export function toastRpcError(error: RpcError): number {
  return toast.api.push({
    title: `Error ${error.code}`,
    description: error.message,
    variant: "tonal",
    class: "jx-hue-error",
    assertive: true,
    duration: 0,
  });
}

/** 成功类轻提示。 */
export function toastSuccess(title: string, description?: string): number {
  return toast.api.push({
    title,
    ...(description !== undefined ? { description } : {}),
    variant: "tonal",
    class: "jx-hue-success",
  });
}
