// service-lifecycle 1.3：daemon 进程间传导——CLI（services stop/start/rm）与
// gateway daemon 是不同进程，靠 keyring.json 文件变更同步（对齐 provider serve.ts
// 的 services.json watcher 模式：事件去抖 + 低频轮询兜底 + 停止清理）。
// 正交意图（本文件不实现）：
// - 网关监听的建立/关闭（gateway.ts setServiceEnabled；本文件只做差分重放）；
// - 新钥环的动态发现（watch 固定于 daemon 启动时装配的环集合；新导入走重启）；
// - 端口偏好变化（重启网关生效——ports 命令既有语义，裁决记录于 gateway.ts）。

import { watch as fsWatch, type FSWatcher } from "node:fs";
import { keyringDir, loadKeyring, type Keyring } from "./store.ts";
import type { Gateway } from "./gateway.ts";

export interface LifecycleWatchOptions {
  /** 消费侧数据根（keyring 目录树）。 */
  root: string;
  /** daemon 启动时装配的环集合（watch 范围；新环不动态纳入）。 */
  rings: readonly Keyring[];
  gateway: Gateway;
  onNotice?: (line: string) => void;
  debounceMs?: number;
  pollMs?: number;
}

export interface LifecycleWatch {
  stop(): void;
}

/**
 * watch 各钥环目录的 keyring.json 变更，把停用/启用状态全量重放到网关
 * （setServiceEnabled 幂等：在跑 start、未跑 stop 均为 no-op，天然收敛，
 * 无需精确 diff）。文件不可读/校验失败仅 NOTICE，不断 watch。
 */
export function watchServiceLifecycle(opts: LifecycleWatchOptions): LifecycleWatch {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const watchers: FSWatcher[] = [];

  const replay = (): void => {
    if (stopped) return;
    const notice = opts.onNotice ?? (() => undefined);
    for (const base of opts.rings) {
      let ring: Keyring;
      try {
        ring = loadKeyring(opts.root, base.endpointId) ?? base;
      } catch (err) {
        notice(`warning: keyring reload failed for '${base.alias}': ${(err as Error).message}`);
        continue;
      }
      const disabled = new Set(ring.disabledServices);
      for (const service of ring.services) {
        opts.gateway
          .setServiceEnabled(ring.endpointId, ring.alias, service, ring.ports, !disabled.has(service.serviceId))
          .catch((err: unknown) => {
            notice(`warning: service lifecycle apply failed for '${ring.alias}/${service.serviceId}': ${(err as Error).message}`);
          });
      }
    }
  };

  const schedule = (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      replay();
    }, opts.debounceMs ?? 150);
  };

  for (const base of opts.rings) {
    try {
      const w = fsWatch(keyringDir(opts.root, base.endpointId), (_event, filename) => {
        const f = filename === null ? "" : String(filename);
        if (f === "" || f === "keyring.json" || f.startsWith(".keyring.json.tmp-") || f.startsWith("keyring.json")) {
          schedule();
        }
      });
      watchers.push(w);
    } catch {
      // watcher 不可用：轮询兜底
    }
  }
  pollTimer = setInterval(replay, opts.pollMs ?? 30_000);
  pollTimer.unref?.();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      if (pollTimer !== null) clearInterval(pollTimer);
      for (const w of watchers) w.close();
    },
  };
}
