// 消费侧引擎装配（manager ↔ gateway 绑定）：先把每个钥环的既有目录物化成本地监听
// （离线时端口常开、请求 503 快速失败的 spec 语义要求），再启动提供者连接；AUTH_OK
// 目录回调驱动网关全量同步。
// 正交意图：纯装配层，不含 CLI、不含 Fabric 构造（sessionFactoryFor 注入）。

import { ProviderManager, type ProviderTransportSessionFactory } from "./providers.ts";
import { Gateway } from "./gateway.ts";
import { setActualPorts, type Keyring } from "./store.ts";

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
  // 先物化既有目录的监听（离线 503 语义），再启动连接（AUTH_OK 后再全量同步刷新）；
  // 停用服务（disabledServices）不物化；环级停用（ring.disabled）整环跳过
  // （service-lifecycle）
  for (const ring of opts.rings) {
    if (ring.disabled) continue;
    const visible = ring.services.filter((s) => !ring.disabledServices.includes(s.serviceId));
    if (visible.length > 0) {
      await gateway.syncProviderServices(ring.endpointId, ring.alias, visible, ring.ports);
    }
  }
  // 实际监听端口回写（自动错开时 ai-fly test 按 actualPorts 命中真实端口，
  // 不再打到 defaultPort 的占用者）；失败不阻断引擎，NOTICE 提示
  const live = new Map(gateway.listenerInfo().map((l) => [l.serviceId, l.port]));
  for (const ring of opts.rings) {
    const actual: Record<string, number> = {};
    for (const s of ring.services) {
      const port = live.get(s.serviceId);
      if (port !== undefined) actual[s.serviceId] = port;
    }
    if (Object.keys(actual).length === 0) continue;
    try {
      setActualPorts(opts.consumersRoot, ring.endpointId, actual);
    } catch (err) {
      opts.onNotice?.(`warning: could not persist actual ports for '${ring.alias}': ${(err as Error).message}`);
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
