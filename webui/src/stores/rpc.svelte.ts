// RPC 连接的反应式封装（B 3.1）：单例连接 + $state 状态（布局的连接
// 横幅与状态点消费）。真正的通知总线在 app.svelte.ts（按事件标脏拉取）。
import { RpcConnection, type RpcConnectionStatus, type RpcClient } from "$lib/rpc-client";

/** 连接单例（App 挂载时 start；整页生命周期一条）。 */
export const connection = new RpcConnection();

/** 反应式连接状态（回调写入 $state 代理，布局自动更新）。 */
export const rpcState = $state({
  status: "connecting" as RpcConnectionStatus,
});

/** 便捷调用入口：连接门面 call 的直通（错误规整交给调用方 toRpcError）。 */
export function call<T>(fn: (client: RpcClient) => Promise<T>, timeoutMs?: number): Promise<T> {
  return connection.call(fn, timeoutMs);
}

connection.onStatus((status) => {
  rpcState.status = status;
});
