// 提供方 daemon 装配：Fabric createRoot（首启）/ open（复入）-> ProviderEngine ->
// 启动横幅 -> services.json 变更监听（CLI 与 daemon 是不同进程，靠文件同步目录刷新）
// -> 优雅退出（幂等）。
// 正交意图（本文件不实现）：
// - 会话与转发逻辑（engine.ts）；本文件只做 Fabric 生命周期、横幅与 watcher；
// - CLI 参数解析（src/cli/commands/provider/serve.ts）；
// - 原生 SDK 加载：仅在本文件的启动/打开函数内动态 import（单测 import 本模块
//   不会加载原生模块；engine.ts 同样保持类型级引用）。

import { existsSync, readdirSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Fabric, FabricOptions } from "@jixo/opendweb-client-sdk";
import { ProviderStore } from "./store.ts";
import type { ServiceConfig } from "./store.ts";
import { LimitEnforcer } from "./limits.ts";
import { ProviderEngine, type ProviderEngineOptions } from "./engine.ts";
import { collectEnvVarNames, type EnvSource } from "./rewrite.ts";
import type { UpstreamTimeouts } from "./upstream.ts";
import { loadSdk } from "../sdk.ts";

export const DEFAULT_PROVIDER_DATA_DIR = (): string => join(homedir(), ".aifly", "provider");

export function providerFabricDir(dataDir: string): string {
  return join(dataDir, "fabric");
}

function fabricOptions(dataDir: string, relayUrls: readonly string[] | undefined): FabricOptions {
  const opts: FabricOptions = { dataDir: providerFabricDir(dataDir) };
  if (relayUrls !== undefined && relayUrls.length > 0) {
    opts.relay = { mode: "custom", urls: [relayUrls[0]!, ...relayUrls.slice(1)] };
  }
  return opts;
}

function dirHasEntries(path: string): boolean {
  return existsSync(path) && readdirSync(path).length > 0;
}

/**
 * 打开（或首启创建 root）数据目录下的 Fabric。已存在 fabric 数据则 open 复入
 * （EndpointId/名册不变），否则 createRoot。
 */
export async function openOrCreateFabric(
  dataDir: string,
  relayUrls?: readonly string[] | undefined,
): Promise<Fabric> {
  const { Fabric } = await loadSdk();
  const opts = fabricOptions(dataDir, relayUrls);
  const existed = dirHasEntries(providerFabricDir(dataDir));
  if (existed) {
    try {
      return await Fabric.open(opts);
    } catch (err) {
      // 数据目录存在但 open 失败（如名册缺失）：尝试 createRoot 重建。
      const fallback = await Fabric.createRoot(opts).catch(
        () => Promise.reject(err instanceof Error ? err : new Error(String(err))),
      );
      return fallback;
    }
  }
  try {
    return await Fabric.createRoot(opts);
  } catch (err) {
    // 并发首启竞态（另一进程已创建）：回退 open。
    const fallback = await Fabric.open(opts).catch(
      () => Promise.reject(err instanceof Error ? err : new Error(String(err))),
    );
    return fallback;
  }
}

/** 打开既有 fabric 身份（share/revoke/status 用；未初始化时抛错）。 */
export async function openExistingFabric(
  dataDir: string,
  relayUrls?: readonly string[] | undefined,
): Promise<Fabric> {
  if (!dirHasEntries(providerFabricDir(dataDir))) {
    throw new Error(`error: no fabric identity under ${dataDir}; run 'ai-fly serve --data <dir>' first`);
  }
  const { Fabric } = await loadSdk();
  return Fabric.open(fabricOptions(dataDir, relayUrls));
}

// ---------------------------------------------------------------------------
// 启动横幅
// ---------------------------------------------------------------------------

/** 扫描空/未设置的 $env 变量（已声明但为空 -> WARNING 列表）。 */
export function findEmptyEnvRefs(
  services: readonly ServiceConfig[],
  env: EnvSource = process.env,
): Array<{ service: string; vars: string[] }> {
  const out: Array<{ service: string; vars: string[] }> = [];
  for (const service of services) {
    const empty = collectEnvVarNames(service).filter((name) => {
      const value = env[name];
      return value === undefined || value === "";
    });
    if (empty.length > 0) out.push({ service: service.name, vars: empty });
  }
  return out;
}

export interface BannerInput {
  endpointId: string;
  fabricIdHex: string;
  dataDir: string;
  alias: string;
  serviceCount: number;
  groupCount: number;
  activeKeyCount: number;
  revokedKeyCount: number;
  relayMode: string;
  relayUrls: readonly string[];
  emptyEnvRefs: ReadonlyArray<{ service: string; vars: string[] }>;
}

/** 启动横幅（英文 ASCII；用户面文案码位 < 128）。 */
export function composeStartupBanner(input: BannerInput): string {
  const lines: string[] = [];
  lines.push("ai-fly provider daemon");
  lines.push(`  EndpointId : ${input.endpointId}`);
  lines.push(`  FabricId   : ${input.fabricIdHex}`);
  lines.push(`  Data dir   : ${input.dataDir}`);
  lines.push(`  Alias      : ${input.alias}`);
  lines.push(`  Services   : ${input.serviceCount}`);
  lines.push(
    `  Groups     : ${input.groupCount} (keys: ${input.activeKeyCount} active, ${input.revokedKeyCount} revoked)`,
  );
  if (input.relayUrls.length > 0) {
    lines.push(`  Relay      : ${input.relayMode} ${input.relayUrls.join(", ")}`);
  } else {
    lines.push(`  Relay      : ${input.relayMode} (none)`);
  }
  for (const ref of input.emptyEnvRefs) {
    for (const name of ref.vars) {
      lines.push(`  WARNING: $env variable '${name}' referenced by service '${ref.service}' is empty or unset`);
    }
  }
  lines.push("Ready. Waiting for consumers (Ctrl+C to stop).");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// daemon
// ---------------------------------------------------------------------------

export interface DaemonOptions extends ProviderEngineOptions {
  dataDir: string;
  /** 已解析的 relay 入口（flag > env > config；undefined = SDK 默认 n0）。 */
  relayUrls?: readonly string[] | undefined;
  /** 关闭文件 watcher（测试用）。 */
  watch?: boolean;
  /** $env 解析源（默认 process.env）。 */
  env?: EnvSource | undefined;
  timeouts?: Partial<UpstreamTimeouts> | undefined;
}

export interface RunningDaemon {
  engine: ProviderEngine;
  fabric: Fabric;
  endpointId: string;
  fabricIdHex: string;
  relayUrls: string[];
  relayMode: string;
  banner: string;
  stop(): Promise<void>;
}

export async function startProviderDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  const store = ProviderStore.open(opts.dataDir); // 0700/0600 由 store 保障
  if (opts.alias !== undefined && opts.alias !== store.alias) {
    store.setAlias(opts.alias);
  }
  const limits = new LimitEnforcer({ dataDir: opts.dataDir });
  const fabric = await openOrCreateFabric(opts.dataDir, opts.relayUrls);
  const engine = new ProviderEngine({
    fabric,
    store,
    dataDir: opts.dataDir,
    limits,
    opts: {
      alias: opts.alias,
      logUsage: opts.logUsage,
      timeouts: opts.timeouts,
      env: opts.env,
    },
  });
  await engine.start();

  const endpointId = fabric.endpointId;
  const fabricIdHex = await fabric.fabricIdHex();
  const relayStatus = await fabric.relayStatus();
  const relayUrls = [...relayStatus.urls];

  const banner = composeStartupBanner({
    endpointId,
    fabricIdHex,
    dataDir: opts.dataDir,
    alias: engine.alias(),
    serviceCount: store.listServices().length,
    groupCount: store.listGroups().length,
    activeKeyCount: store.listKeys().filter((k) => k.revokedAt === undefined).length,
    revokedKeyCount: store.listKeys().filter((k) => k.revokedAt !== undefined).length,
    relayMode: relayStatus.mode,
    relayUrls,
    emptyEnvRefs: findEmptyEnvRefs(store.listServices(), opts.env ?? process.env),
  });

  // 文件监听 + 低频轮询兜底：CLI 修改 services.json -> reloadStore -> refresh 推送。
  let stopped = false;
  let watcher: FSWatcher | null = null;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const reload = (): void => {
    if (stopped) return;
    engine
      .reloadStore()
      .catch((err: unknown) => {
        process.stderr.write(`warn: store reload failed: ${(err as Error).message}\n`);
      })
      .finally(() => {
        reloadTimer = null;
      });
  };
  if (opts.watch !== false) {
    const storePath = ProviderStore.filePath(opts.dataDir);
    const schedule = (): void => {
      if (reloadTimer !== null) return;
      reloadTimer = setTimeout(reload, 150);
    };
    try {
      watcher = fsWatch(opts.dataDir, (_event, filename) => {
        if (filename === null || filename === "services.json" || String(filename).startsWith("services.json")) {
          schedule();
        }
      });
    } catch {
      watcher = null; // watcher 不可用：轮询兜底
    }
    pollTimer = setInterval(reload, 30_000);
    pollTimer.unref?.();
  }

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (reloadTimer !== null) clearTimeout(reloadTimer);
    if (pollTimer !== null) clearInterval(pollTimer);
    watcher?.close();
    await engine.shutdown();
    await fabric.shutdown(); // SDK 幂等
  };

  return {
    engine,
    fabric,
    endpointId,
    fabricIdHex,
    relayUrls,
    relayMode: relayStatus.mode,
    banner,
    stop,
  };
}
