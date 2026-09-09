// 消费侧引擎装配（manager ↔ gateway 绑定）：先把每个钥环的既有目录物化成本地监听
// （离线时端口常开、请求 503 快速失败的 spec 语义要求），再启动提供者连接；AUTH_OK
// 目录回调驱动网关全量同步。
// 正交意图：纯装配层，不含 CLI、不含 Fabric 构造（sessionFactoryFor 注入）。

import { ProviderManager, type ProviderTransportSessionFactory } from "./providers.ts";
import { Gateway } from "./gateway.ts";
import type { Keyring } from "./store.ts";

export interface EngineOptions {
  rings: readonly Keyring[];
  consumersRoot: string;
  sessionFactoryFor: (ring: Keyring) => ProviderTransportSessionFactory;
  strictPorts?: boolean;
  pollIntervalMs?: number;
  backoff?: { baseMs?: number; capMs?: number };
  onNotice?: (line: string) => void;
  onLog?: (line: string) => void;
}

export interface Engine {
  manager: ProviderManager;
  gateway: Gateway;
  stop(): Promise<void>;
}

export async function startEngine(opts: EngineOptions): Promise<Engine> {
  const managerRef: { current?: ProviderManager } = {};
  const gateway = new Gateway({
    resolveRoute: (providerId) => managerRef.current?.routeFor(providerId),
    ...(opts.strictPorts !== undefined ? { strictPorts: opts.strictPorts } : {}),
    ...(opts.onNotice !== undefined ? { onNotice: opts.onNotice } : {}),
  });
  const manager = new ProviderManager({
    rings: opts.rings,
    root: opts.consumersRoot,
    sessionFactory: opts.sessionFactoryFor,
    ...(opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {}),
    ...(opts.backoff !== undefined ? { backoff: opts.backoff } : {}),
    onCatalog: (providerId, alias, services, ports) => {
      void gateway.syncProviderServices(providerId, alias, services, ports);
    },
  });
  managerRef.current = manager;
  // 先物化既有目录的监听（离线 503 语义），再启动连接（AUTH_OK 后再全量同步刷新）
  for (const ring of opts.rings) {
    if (ring.services.length > 0) {
      await gateway.syncProviderServices(ring.endpointId, ring.alias, ring.services, ring.ports);
    }
  }
  manager.start();
  return {
    manager,
    gateway,
    stop: async () => {
      await gateway.stop();
      await manager.stop();
    },
  };
}
