// 单进程引擎装配（A2）：提供方 daemon（startProviderDaemon）与使用方网关
// （consumer startEngine）在同进程内按需启停（幂等开关，不改数据）。
// 正交意图（本文件不实现）：
// - 引擎语义（全部在 M1 模块；本文件只做生命周期与事件桥）；
// - RPC 面（rpc-router 消费本模块的句柄）；
// - 任何 webui 代码（禁止 import——web-server 只依赖本文件的 notify 接口）。
// 事件桥：provider fabric 事件直连；consumer 状态机无回调注入面（M1 runtime
// 不透传 onStateChange），以 1s 快照 diff 轮询桥接——通知仅为触发器（spec），
// 前端拉取的快照是唯一事实源，轮询桥满足语义且零引擎侵入。

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Fabric, FabricOptions } from "@jixo/opendweb-client-sdk";
import {
  startProviderDaemon,
  type DaemonOptions,
  type RunningDaemon,
} from "../provider/serve.ts";
import { ProviderStore } from "../provider/store.ts";
import type { FabricFactory, FabricLike, ProviderStatus, ProviderTransportSessionFactory } from "../consumer/providers.ts";
import { createFabricProviderTransport } from "../consumer/providers.ts";
import { startEngine, type Engine as ConsumerEngine } from "../consumer/runtime.ts";
import { listKeyrings, loadKeyring, type Keyring } from "../consumer/store.ts";
import { loadSdk } from "../sdk.ts";
import { DomainError } from "./errors.ts";

/** 通知事件（轻量：type + 关键 id；前端收到后拉取详情）。 */
export interface NotifyEvent {
  type: string;
  payload: Record<string, unknown>;
}

export type NotifySink = (event: NotifyEvent) => void;

export interface EngineHostOptions {
  /** 提供方数据目录（默认 ~/.aifly/provider）。 */
  providerDataDir?: string;
  /** 使用方钥环根（默认 ~/.aifly/consumers）。 */
  consumersRoot?: string;
  /** relay 入口（settings.relayUrls 解析结果；undefined = SDK 默认）。 */
  relayUrls?: readonly string[] | undefined;
  /** $env 解析源（默认 process.env）。 */
  env?: DaemonOptions["env"];
  /** 测试注入：提供方 daemon 工厂。 */
  startProviderDaemonImpl?: typeof startProviderDaemon;
  /** 测试注入：使用方 fabric 工厂（避免触原生 SDK）。 */
  fabricFactory?: FabricFactory;
  /** 通知下沉（web-server 订阅）。 */
  notify?: NotifySink;
  /** consumer 状态轮询间隔（默认 1000ms；测试注入小值）。 */
  pollMs?: number;
  /** home 基准（默认 os.homedir()；仅用于默认目录推导）。 */
  home?: string;
}

/** consumer 快照的最小投影（diff 用）。 */
export type ConsumerSnapshot = Array<{
  endpointId: string;
  state: ProviderStatus["state"];
  servedCount: number;
  bufferOverflows: number;
  ports: Record<string, number>;
  services: number;
  /** 目录同步错误态（hooks-lifecycle 复核 R3-F1：set/clear/变化都要触发重拉）。 */
  lastError: string | undefined;
}>;

/**
 * consumer 快照 diff（纯函数，供轮询与单测共用）：新增/状态机/端口/目录/目录
 * 错误变化 → 对应通知事件。lastError set/clear/变化均触发 consumer-catalog
 * （驱动 UI 重拉 cservices 呈现错误态——hooks-lifecycle 复核 R3-F1）。
 */
export function diffConsumerSnapshots(
  prev: ConsumerSnapshot,
  next: ConsumerSnapshot,
  notify: (type: string, payload: Record<string, unknown>) => void,
): void {
  const prevById = new Map(prev.map((p) => [p.endpointId, p]));
  for (const entry of next) {
    const before = prevById.get(entry.endpointId);
    if (before === undefined) {
      notify("consumer-state", { endpointId: entry.endpointId, state: entry.state });
      continue;
    }
    if (before.state !== entry.state) {
      notify("consumer-state", { endpointId: entry.endpointId, state: entry.state });
    }
    if (JSON.stringify(before.ports) !== JSON.stringify(entry.ports)) {
      notify("consumer-ports", { endpointId: entry.endpointId });
    }
    if (before.services !== entry.services) {
      notify("consumer-catalog", { endpointId: entry.endpointId });
    }
    if (before.lastError !== entry.lastError) {
      notify("consumer-catalog", { endpointId: entry.endpointId });
    }
  }
}

const DEFAULT_POLL_MS = 1_000;

export class EngineHost {
  readonly providerDataDir: string;
  readonly consumersRoot: string;
  private readonly opts: EngineHostOptions;
  private daemon: RunningDaemon | null = null;
  private daemonStarting: Promise<RunningDaemon> | null = null;
  private consumer: ConsumerEngine | null = null;
  private consumerStarting: Promise<void> | null = null;
  private fabricFactoryRef: FabricFactory | null = null;
  private unsubscribeFabric: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastConsumerSnapshot = "";
  private lastProviderRevision = -1;
  /** legacy NOTICE 只打一次（providerStore() 每次调用都会开新 store 视图）。 */
  private legacyNoticed = false;

  constructor(opts: EngineHostOptions = {}) {
    const home = opts.home ?? homedir();
    this.providerDataDir = opts.providerDataDir ?? join(home, ".aifly", "provider");
    this.consumersRoot = opts.consumersRoot ?? join(home, ".aifly", "consumers");
    this.opts = opts;
  }

  private notify(type: string, payload: Record<string, unknown>): void {
    try {
      this.opts.notify?.({ type, payload });
    } catch {
      // 通知下沉异常不波及引擎
    }
  }

  // -------------------------------------------------------------------------
  // 提供方 daemon
  // -------------------------------------------------------------------------

  /** 提供方 daemon 是否在运行。 */
  isProviderRunning(): boolean {
    return this.daemon !== null;
  }

  /** 启动提供方 daemon（幂等；并发调用合并为一次）。 */
  async startProvider(): Promise<void> {
    if (this.daemon !== null) return;
    if (this.daemonStarting !== null) return this.daemonStarting.then(() => undefined);
    const start = this.opts.startProviderDaemonImpl ?? startProviderDaemon;
    this.daemonStarting = start({
      dataDir: this.providerDataDir,
      ...(this.opts.relayUrls !== undefined ? { relayUrls: this.opts.relayUrls } : {}),
      ...(this.opts.env !== undefined ? { env: this.opts.env } : {}),
    })
      .then((daemon) => {
        this.daemon = daemon;
        this.lastProviderRevision = daemon.engine.store.revision;
        this.unsubscribeFabric = daemon.fabric.on((event) => {
          switch (event.type) {
            case "peer-connected":
              this.notify("provider-session", { peerId: event.endpointId, connected: true });
              break;
            case "peer-disconnected":
              this.notify("provider-session", { peerId: event.endpointId, connected: false });
              break;
            case "roster-updated":
              this.notify("provider-roster", {});
              break;
            case "relay-online":
              this.notify("provider-relay", { online: true });
              break;
            case "relay-offline":
              this.notify("provider-relay", { online: false });
              break;
            default:
              break;
          }
        });
        this.ensurePolling();
        this.notify("provider-daemon", { running: true });
        return daemon;
      })
      .finally(() => {
        this.daemonStarting = null;
      });
    return this.daemonStarting.then(() => undefined);
  }

  /** 停止提供方 daemon（幂等；在途请求按 M1 语义收敛）。 */
  async stopProvider(): Promise<void> {
    const daemon = this.daemon;
    this.daemon = null;
    this.unsubscribeFabric?.();
    this.unsubscribeFabric = null;
    if (daemon !== null) {
      await daemon.stop();
    }
    this.stopPollingIfIdle();
    this.notify("provider-daemon", { running: false });
  }

  /** 运行中的 daemon（未运行返回 null——status 等只读面走存储投影）。 */
  runningProviderDaemon(): RunningDaemon | null {
    return this.daemon;
  }

  /** 运行中的 daemon（未运行抛 UNAVAILABLE——share.create 等需要实时 fabric）。 */
  requireProviderDaemon(): RunningDaemon {
    if (this.daemon === null) {
      throw new DomainError("UNAVAILABLE", "provider daemon is not running; start it first");
    }
    return this.daemon;
  }

  /**
   * 提供方存储句柄：daemon 运行时复用其 store 实例（同进程写入即刻一致），
   * 否则按需打开磁盘存储（与 CLI 相同的打开语义）。legacy（pre-v2）态首见
   * 时打一行 NOTICE（hooks-lifecycle 2.3；daemon 运行路径的 NOTICE 由
   * serve.ts 负责，这里只覆盖 UI daemon 未启动 provider 的只读面）。
   */
  providerStore(): ProviderStore {
    if (this.daemon !== null) return this.daemon.engine.store;
    const store = ProviderStore.open(this.providerDataDir);
    if (store.legacy !== null && !this.legacyNoticed) {
      this.legacyNoticed = true;
      process.stderr.write(
        `NOTICE: provider store under ${this.providerDataDir} is in legacy (pre-v2) format; ` +
          `stale services are visible for removal only (remove them to rebuild as v2)\n`,
      );
    }
    return store;
  }

  /** 提供方存储当前 revision（-1 = 目录尚无存储文件）。 */
  providerDiskRevision(): number {
    if (!existsSync(ProviderStore.filePath(this.providerDataDir))) return -1;
    try {
      return ProviderStore.open(this.providerDataDir).revision;
    } catch {
      return -1;
    }
  }

  // -------------------------------------------------------------------------
  // 使用方网关
  // -------------------------------------------------------------------------

  /** 使用方网关是否在运行。 */
  isGatewayRunning(): boolean {
    return this.consumer !== null;
  }

  /** 启动本地网关（幂等；并发调用合并为一次）。 */
  async startGateway(): Promise<void> {
    if (this.consumer !== null) return;
    if (this.consumerStarting !== null) return this.consumerStarting.then(() => undefined);
    this.consumerStarting = this.startGatewayInner()
      .finally(() => {
        this.consumerStarting = null;
      });
    return this.consumerStarting.then(() => undefined);
  }

  private async startGatewayInner(): Promise<void> {
    const factory = await this.resolveFabricFactory();
    const { rings, warnings } = listKeyrings(this.consumersRoot);
    for (const warning of warnings) {
      this.notify("consumer-warning", { message: warning });
    }
    const engineRings = rings.filter((r) => r.keys.length > 0 || r.services.length > 0);
    const engine = await startEngine({
      rings: engineRings,
      consumersRoot: this.consumersRoot,
      sessionFactoryFor: (ring: Keyring): ProviderTransportSessionFactory =>
        createFabricProviderTransport(factory, {
          dataDir: join(this.consumersRoot, ring.endpointId.slice(0, 8), "fabric"),
          providerEndpointId: ring.endpointId,
          // 链接带来的会合点优先（Owner 裁决 2026-09-13）：ring 内嵌 relay 逐环
          // 传给 fabric（engine-host toOpts：opts.relayUrls 优先于 host settings）
          ...(ring.relayUrls.length > 0 ? { relayUrls: ring.relayUrls } : {}),
        }),
      onNotice: (line) => this.notify("consumer-notice", { message: line }),
      // 目录同步失败（AUTH_OK detail 投影解析失败——复核 R3-F1）：专用事件驱动
      // UI 标脏重拉（lastError 随 cservices/consumer 呈现），消息已脱敏（mux 层固定文案）。
      onCatalogError: (providerId, message) => {
        this.notify("consumer-catalog-error", { endpointId: providerId, message });
      },
    });
    this.consumer = engine;
    this.lastConsumerSnapshot = "";
    this.ensurePolling();
    this.notify("consumer-gateway", { running: true });
  }

  /** 停止本地网关（幂等）。 */
  async stopGateway(): Promise<void> {
    const engine = this.consumer;
    this.consumer = null;
    if (engine !== null) {
      await engine.stop();
    }
    this.stopPollingIfIdle();
    this.notify("consumer-gateway", { running: false });
  }

  /** 网关运行时的实时引擎句柄（未运行返回 null——status 走存储投影）。 */
  consumerEngine(): ConsumerEngine | null {
    return this.consumer;
  }

  /**
   * 单服务停用/启用热应用（service-lifecycle）：keyring 已落盘，内嵌网关直接
   * setServiceEnabled（不整网关重建）；网关停止态为 no-op（下次 start 自然带上）。
   */
  async applyServiceEnabled(ring: Keyring, serviceId: string, enabled: boolean): Promise<void> {
    if (this.consumer === null) return;
    const service = ring.services.find((s) => s.serviceId === serviceId);
    if (service === undefined) return;
    await this.consumer.gateway.setServiceEnabled(ring.endpointId, ring.alias, service, ring.ports, enabled);
  }

  /**
   * 提供方级停用/启用热应用（环级开关）：环停用 = 该环全部监听关闭；恢复 =
   * 逐服务重放（单服务停用保持叠加——与 lifecycle-watch 的 replay 同语义）。
   */
  async applyProviderEnabled(ring: Keyring, enabled: boolean): Promise<void> {
    if (this.consumer === null) return;
    const disabled = new Set(ring.disabledServices);
    for (const service of ring.services) {
      await this.consumer.gateway.setServiceEnabled(
        ring.endpointId,
        ring.alias,
        service,
        ring.ports,
        enabled && !disabled.has(service.serviceId),
      );
    }
  }

  /**
   * 消费侧数据变更（import/join/key.add/forget/ports.set）后重建网关：
   * 运行中则 stop→start 拉入新钥环；停止态为 no-op（下次 start 自然带上）。
   */
  async reloadGateway(): Promise<void> {
    if (this.consumer === null) return;
    await this.stopGateway();
    await this.startGateway();
  }

  /** fabric 工厂（import/join 用；缓存复用）。 */
  async resolveFabricFactory(): Promise<FabricFactory> {
    if (this.fabricFactoryRef !== null) return this.fabricFactoryRef;
    if (this.opts.fabricFactory !== undefined) {
      this.fabricFactoryRef = this.opts.fabricFactory;
      return this.fabricFactoryRef;
    }
    const sdk = await loadSdk();
    const relayUrls = this.opts.relayUrls;
    const toOpts = (opts: { dataDir: string; relayUrls?: string[] | undefined }): FabricOptions => {
      const fabricOpts: FabricOptions = { dataDir: opts.dataDir };
      const urls = opts.relayUrls ?? relayUrls;
      if (urls !== undefined && urls.length > 0) {
        fabricOpts.relay = { mode: "custom", urls: [urls[0]!, ...urls.slice(1)] };
      }
      return fabricOpts;
    };
    this.fabricFactoryRef = {
      open: async (opts) => (await sdk.Fabric.open(toOpts(opts))) as FabricLike,
      joinWithToken: async (opts, token) =>
        (await sdk.Fabric.joinWithToken(toOpts(opts), token)) as FabricLike,
    };
    return this.fabricFactoryRef;
  }

  /** 定位钥环（endpointId / 8 字符前缀 / 别名）。 */
  findKeyring(ref: string): Keyring | undefined {
    return loadKeyring(this.consumersRoot, ref);
  }

  // -------------------------------------------------------------------------
  // 快照轮询桥（consumer 状态机 + provider 存储变更 → notify）
  // -------------------------------------------------------------------------

  private ensurePolling(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => this.pollOnce(), this.opts.pollMs ?? DEFAULT_POLL_MS);
    this.pollTimer.unref?.();
  }

  /** 停止轮询（两个引擎都停时自动收缩；stop() 显式调用）。 */
  private stopPollingIfIdle(): void {
    if (this.daemon !== null || this.consumer !== null) return;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private pollOnce(): void {
    // provider 存储 revision 变化（CLI/其它进程写盘后 daemon watcher 已刷新；
    // 这里补一层 UI 通知）
    if (this.daemon !== null) {
      const revision = this.daemon.engine.store.revision;
      if (revision !== this.lastProviderRevision) {
        if (this.lastProviderRevision >= 0) {
          this.notify("provider-store", { revision });
        }
        this.lastProviderRevision = revision;
      }
    }
    // consumer 快照 diff（状态机/端口/目录变化）
    const engine = this.consumer;
    if (engine === null) {
      this.lastConsumerSnapshot = "";
      return;
    }
    const snapshot = this.projectConsumerSnapshot(engine.manager.snapshot());
    const json = JSON.stringify(snapshot);
    if (json !== this.lastConsumerSnapshot) {
      const prev = this.lastConsumerSnapshot === "" ? [] : (JSON.parse(this.lastConsumerSnapshot) as ConsumerSnapshot);
      diffConsumerSnapshots(prev, snapshot, (type, payload) => this.notify(type, payload));
      this.lastConsumerSnapshot = json;
    }
  }

  private projectConsumerSnapshot(statuses: readonly ProviderStatus[]): ConsumerSnapshot {
    return statuses.map((s) => ({
      endpointId: s.endpointId,
      state: s.state,
      servedCount: s.servedCount,
      bufferOverflows: s.bufferOverflows,
      ports: { ...s.ports },
      services: s.services.length,
      lastError: s.lastError,
    }));
  }

  /** 全量关闭（幂等；宿主进程退出路径）。 */
  async stop(): Promise<void> {
    await this.stopProvider();
    await this.stopGateway();
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

// Fabric 类型仅用于 daemon 事件签名的结构对照（Fabric.on 的事件联合）。
export type FabricEventType = Parameters<Parameters<Fabric["on"]>[0]>[0];
