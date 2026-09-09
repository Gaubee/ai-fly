// 消费侧端口规则：默认值解析（store.ports[serviceId] ?? service.defaultPort）、
// 127.0.0.1 监听与冲突处理（strict 报错 / 自动错开 + NOTICE）、ports 命令的参数校验。
// 正交意图：
// - 纯端口策略，不含 hono/gateway 请求转发（gateway.ts）；不含存储 IO（store.ts）；
// - 冲突探测采用“真实 listen + EADDRINUSE 即错开”而非 net.createServer 预探测：
//   预探测与正式 listen 之间存在 TOCTOU 窗口，listen 失败重试把窗口压到零且语义等价
//   （占用/冲突/特权端口均表现为 EADDRINUSE/EACCES）。
// - 本地端点只绑 127.0.0.1（spec：MUST NOT 绑定非回环接口；回环边界即信任边界）。

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { UsageError } from "../cli/errors.ts";
import type { ServiceEntry } from "../wire/frames.ts";

export const LOOPBACK_HOST = "127.0.0.1" as const;

export interface ListenAssignment {
  /** 实际监听端口（desired 冲突错开后可能变化；0 请求时为系统分配值）。 */
  port: number;
  /** 请求端口（展示与 NOTICE 用）。 */
  requested: number;
  /** true = 未能按请求端口监听（冲突自动错开），或请求 0 由系统分配。 */
  autoAssigned: boolean;
  /** 偏离原因（NOTICE 行用）。 */
  reason?: string;
}

/** 解析服务期望端口：显式偏好（keyring.ports）优先，缺省取服务 defaultPort。 */
export function desiredPortFor(service: ServiceEntry, ports: Readonly<Record<string, number>>): number {
  const pinned = ports[service.serviceId];
  if (pinned !== undefined) return pinned;
  return service.defaultPort;
}

function listenOnce(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onErr = (err: Error): void => {
      server.off("listening", onOk);
      reject(err);
    };
    const onOk = (): void => {
      server.off("error", onErr);
      const addr = server.address();
      const p = typeof addr === "object" && addr !== null ? addr.port : port;
      resolve(p);
    };
    server.once("error", onErr);
    server.once("listening", onOk);
    server.listen({ host: LOOPBACK_HOST, port });
  });
}

function isPortUnavailable(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException;
  return e?.code === "EADDRINUSE" || e?.code === "EACCES" || e?.code === "EADDRNOTAVAIL";
}

/**
 * 在 127.0.0.1 上监听：冲突（占用/特权）时 strict 即报错；否则错开为系统分配端口，
 * 返回 autoAssigned=true 与原因（调用方显著标注）。desired=0 直接请求系统分配。
 */
export async function listenWithFallback(
  server: Server,
  opts: { desired: number; strict: boolean },
): Promise<ListenAssignment> {
  try {
    const port = await listenOnce(server, opts.desired);
    if (opts.desired === 0) {
      return { port, requested: 0, autoAssigned: true, reason: "requested system-assigned port (0)" };
    }
    return { port, requested: opts.desired, autoAssigned: false };
  } catch (err) {
    if (!isPortUnavailable(err) || opts.strict) throw err;
    const port = await listenOnce(server, 0);
    return {
      port,
      requested: opts.desired,
      autoAssigned: true,
      reason: `port ${opts.desired} unavailable (${(err as NodeJS.ErrnoException).code ?? "in use"})`,
    };
  }
}

/** ports 命令 --port 值校验：整数 1..65535（0 仅运行期分配语义，不可持久化）。 */
export function validatePortArg(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new UsageError(`error: invalid port '${raw}' (expected integer 1..65535)`);
  }
  return n;
}
