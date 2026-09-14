// 使用方提供者管理器（consumer spec「提供者在线性与离线语义」「目录同步处理」）：
// 每个已导入提供者一个 Fabric 实例 + FabricWireAdapter + WireSession(role consumer)；
// 连接状态机（未连接/direct/relay/已连接未AUTH/离线/key_all_invalid）；连接后立即
// AUTH（呈交钥环全部密钥）；full jitter 指数退避重连（1s→60s）+ linkStatus 30s 轮询
// 复核 + path 事件驱动；refresh AUTH_OK 全量替换服务视图并同步本地存储与端口映射；
// onPoison(protocol_seq) 重建该提供者连接；离线/AUTH 全拒对新请求快速失败。
// 正交意图：
// - Fabric 事实全部经 FabricLike/FabricFactory 结构接口注入（vitest 与 SDK 原生模块
//   隔离；真实接线在 CLI 层 lazy import SDK）；
// - 传输会话经 ProviderTransportSessionFactory 注入（真实实现包装 Fabric+适配器，
//   单测用内存 loopback 成对传输，与 test/unit/wire 同手法）；
// - 请求转发只经 wire 帧契约（frames.ts schema）；本地端口/HTTP/WS 还原在 gateway.ts。

import type { Fabric } from "@jixo/opendweb-client-sdk";
import { FabricWireAdapter } from "../wire/fabric-adapter.ts";
import { splitBody } from "../wire/codec.ts";
import {
  FRAME_TYPE,
  type AuthOkHeader,
  type ErrorHeader,
  type RespMetaHeader,
  type ServiceEntry,
} from "../wire/frames.ts";
import {
  WireSession,
  type InboundFrame,
  type TerminateCause,
  type WireTransport,
} from "../wire/mux.ts";
import { applyCatalog, reconcileKeyMetadata, saveKeyring, loadKeyring, type Keyring } from "./store.ts";

// ---------------------------------------------------------------------------
// Fabric 结构接口（SDK Fabric 的消费侧子集；真实 Fabric 结构满足此接口）
// ---------------------------------------------------------------------------

export interface FabricMember {
  endpointId: string;
  displayName?: string | undefined;
  sinceMs: number;
}

export type FabricEventLike =
  | { type: "peer-connected" | "peer-disconnected"; endpointId: string }
  | { type: "message"; from: string; data: Buffer }
  | { type: "path-changed"; endpointId: string; status: "direct" | "relay" | "unknown" };

export interface FabricLike {
  readonly endpointId: string;
  connect(endpointId: string): Promise<void>;
  disconnect(endpointId: string): Promise<void>;
  send(endpointId: string, data: Buffer): Promise<void>;
  linkStatus(endpointId: string): Promise<string>;
  on(callback: (event: FabricEventLike) => void): () => void;
  members(): Promise<FabricMember[]>;
  shutdown(): Promise<void>;
}

/** Fabric 工厂（join/open）；CLI 层以 lazy import SDK 实现，测试注入 fake。 */
export interface FabricFactory {
  open(opts: { dataDir: string; relayUrls?: string[] }): Promise<FabricLike>;
  joinWithToken(opts: { dataDir: string; relayUrls?: string[] }, token: string): Promise<FabricLike>;
}

// ---------------------------------------------------------------------------
// 重连退避（full jitter 指数，1s→60s；纯函数便于边界测试）
// ---------------------------------------------------------------------------

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_CAP_MS = 60_000;
export const LINK_STATUS_POLL_MS = 30_000;

/**
 * full jitter：delay = random() * min(cap, base * 2^attempt)。
 * attempt 从 0 起（首次重连窗口 [0, base]）；封顶后窗口恒为 [0, cap]。
 */
export function fullJitterDelayMs(
  attempt: number,
  opts: { baseMs?: number; capMs?: number; random?: () => number } = {},
): number {
  const base = opts.baseMs ?? RECONNECT_BASE_MS;
  const cap = opts.capMs ?? RECONNECT_CAP_MS;
  const random = opts.random ?? Math.random;
  const ceiling = Math.min(cap, base * 2 ** Math.min(Math.max(attempt, 0), 30));
  return Math.floor(random() * ceiling);
}

// ---------------------------------------------------------------------------
// 转发面契约（gateway.ts 消费）
// ---------------------------------------------------------------------------

/** 本地请求 → REQ 帧的入参（gateway 已剥离凭据头；contentType 独立字段承载）。 */
export interface ForwardInput {
  serviceId: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  contentType?: string;
  body: Uint8Array;
  /** true = WS 升级请求（握手头透传；走 DATA_UP/DOWN/CLOSE 流）。 */
  upgrade: boolean;
}

export interface ForwardHandlers {
  onMeta(header: RespMetaHeader): void;
  onChunk(body: Uint8Array): void;
  onEnd(): void;
  onError(header: ErrorHeader): void;
  /** WS：提供方 DATA_DOWN 字节。 */
  onWsData(body: Uint8Array): void;
  /** WS：提供方 CLOSE（终结帧）。 */
  onWsClose(code: number | undefined): void;
  /** 请求终结（断连/空闲/毒化/本地中止等；对端终结帧已先行经 onEnd/onError 路由）。 */
  onTerminate(cause: TerminateCause): void;
}

export interface ForwardHandle {
  readonly id: string;
  /** 本地客户端断开/缓冲超限：HTTP 发 ABORT，WS 发 CLOSE（终结帧）。 */
  abort(opts?: { ws?: boolean; code?: number }): void;
  /** WS 上行原始字节（DATA_UP；同 id 顺序 await 保序）。 */
  sendData(bytes: Uint8Array): Promise<void>;
}

/** 离线/AUTH 全拒时的快速失败（gateway 映射 503 JSON）。 */
export class OfflineError extends Error {
  readonly code: "provider_offline" | "key_all_invalid";
  readonly alias: string;
  constructor(code: "provider_offline" | "key_all_invalid", alias: string) {
    super(code === "provider_offline" ? `provider '${alias}' is offline` : `all keys for '${alias}' were rejected`);
    this.name = "OfflineError";
    this.code = code;
    this.alias = alias;
  }
}

export type ProviderStateKind =
  | "not-connected" // 未连接（启动前/首次连接尝试中）
  | "connected-unauthed" // 已连接未 AUTH（含钥环为空只入网的提供者）
  | "direct" // 直连且 AUTH 通过
  | "relay" // 经 relay 且 AUTH 通过
  | "offline" // 离线（断连/连接失败，退避重连中）
  | "key-all-invalid"; // AUTH_ERR：全部密钥被拒（等待 key add / 重新签发）

export interface ProviderStatus {
  endpointId: string;
  alias: string;
  state: ProviderStateKind;
  services: ServiceEntry[];
  ports: Record<string, number>;
  servedCount: number;
  bufferOverflows: number;
  lastError?: string;
}

/** gateway 路由面：按提供者取转发入口。 */
export interface ProviderRoute {
  readonly alias: string;
  readonly state: ProviderStateKind;
  forward(input: ForwardInput, handlers: ForwardHandlers): ForwardHandle;
  /** 接收缓冲超限记账（buffer_overflow 计数入 status）。 */
  noteBufferOverflow(): void;
}

// ---------------------------------------------------------------------------
// 传输会话工厂抽象
// ---------------------------------------------------------------------------

/** 一次与提供者的 wire 会话（transport + 路径观测 + 拆除）。 */
export interface ProviderTransportSession {
  readonly transport: WireTransport;
  linkStatus(): Promise<"direct" | "relay" | "unknown">;
  onPathChange?(cb: (status: "direct" | "relay" | "unknown") => void): void;
  /** 拆除本会话（触发 transport close → 在途全量终结）；底层 Fabric 保留。 */
  teardown(): Promise<void>;
}

export interface ProviderTransportSessionFactory {
  /** 建立/复用底层并返回新会话（resolve 即视为 peer-connected）。 */
  openSession(): Promise<ProviderTransportSession>;
  /** 底层实例彻底关闭（进程退出路径）。 */
  shutdown(): Promise<void>;
}

/**
 * 真实传输接线：一个 Fabric 实例（open 一次复用）+ connect(provider) + 每连接一个
 * FabricWireAdapter。FabricLike 是 SDK Fabric 的结构子集，适配器仅消费该子集，
 * 故经 unknown 收窄（SDK 类型仅 type import，vitest 不触原生模块）。
 */
export function createFabricProviderTransport(
  factory: FabricFactory,
  info: {
    dataDir: string;
    providerEndpointId: string;
    /** 该 ring 内嵌的 relay 入口（链接带来；缺省走工厂层解析）。 */
    relayUrls?: string[];
  },
): ProviderTransportSessionFactory {
  let fabric: FabricLike | undefined;
  const getFabric = async (): Promise<FabricLike> => {
    fabric ??= await factory.open({
      dataDir: info.dataDir,
      ...(info.relayUrls !== undefined && info.relayUrls.length > 0
        ? { relayUrls: info.relayUrls }
        : {}),
    });
    return fabric;
  };
  return {
    openSession: async () => {
      const f = await getFabric();
      await f.connect(info.providerEndpointId);
      const adapter = new FabricWireAdapter(f as unknown as Fabric, info.providerEndpointId);
      let pathCb: ((status: "direct" | "relay" | "unknown") => void) | undefined;
      const off = f.on((event) => {
        if (event.type === "path-changed" && event.endpointId === info.providerEndpointId) {
          pathCb?.(event.status);
        }
      });
      return {
        transport: adapter,
        linkStatus: async () => {
          const s = await f.linkStatus(info.providerEndpointId);
          return s === "relay" ? "relay" : s === "direct" ? "direct" : "unknown";
        },
        onPathChange(cb) {
          pathCb = cb;
        },
        teardown: async () => {
          off();
          adapter.dispose();
          adapter.close("provider-teardown");
          await f.disconnect(info.providerEndpointId).catch(() => undefined);
        },
      };
    },
    shutdown: async () => {
      const f = fabric;
      fabric = undefined;
      if (f !== undefined) await f.shutdown().catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// 单提供者连接（状态机 + AUTH + 目录 + 重连/复核）
// ---------------------------------------------------------------------------

interface BackoffOpts {
  baseMs?: number;
  capMs?: number;
}

export class ProviderConnection implements ProviderRoute {
  readonly endpointId: string;
  alias: string;
  state: ProviderStateKind = "not-connected";

  private readonly root: string;
  private readonly factory: ProviderTransportSessionFactory;
  private readonly backoff: BackoffOpts;
  private readonly pollIntervalMs: number;
  private readonly onCatalog: (conn: ProviderConnection, ring: Keyring) => void;
  private readonly onStateChange: (conn: ProviderConnection) => void;
  private readonly reloadRing: (endpointId: string) => Keyring | undefined;

  private ring: Keyring;
  private session: WireSession | null = null;
  private rawSession: ProviderTransportSession | null = null;
  private readonly inflight = new Map<string, ForwardHandlers>();
  private readonly dataUpSeq = new Map<string, number>();
  private attempt = 0;
  private connecting = false;
  private intentionalTeardown = false;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastKeySnapshot = "";
  servedCount = 0;
  bufferOverflows = 0;
  lastError: string | undefined;

  constructor(opts: {
    ring: Keyring;
    root: string;
    factory: ProviderTransportSessionFactory;
    backoff?: BackoffOpts;
    pollIntervalMs?: number;
    onCatalog?: (conn: ProviderConnection, ring: Keyring) => void;
    onStateChange?: (conn: ProviderConnection) => void;
    reloadRing?: (endpointId: string) => Keyring | undefined;
  }) {
    this.ring = opts.ring;
    this.endpointId = opts.ring.endpointId;
    this.alias = opts.ring.alias;
    this.root = opts.root;
    this.factory = opts.factory;
    this.backoff = opts.backoff ?? {};
    this.pollIntervalMs = opts.pollIntervalMs ?? LINK_STATUS_POLL_MS;
    this.onCatalog = opts.onCatalog ?? (() => undefined);
    this.onStateChange = opts.onStateChange ?? (() => undefined);
    this.reloadRing = opts.reloadRing ?? (() => undefined);
    this.lastKeySnapshot = JSON.stringify(opts.ring.keys.map((k) => k.key));
  }

  get keys(): readonly string[] {
    return this.ring.keys.map((k) => k.key);
  }

  get services(): readonly ServiceEntry[] {
    return this.ring.services;
  }

  get ports(): Readonly<Record<string, number>> {
    return this.ring.ports;
  }

  status(): ProviderStatus {
    const s: ProviderStatus = {
      endpointId: this.endpointId,
      alias: this.alias,
      state: this.state,
      services: [...this.ring.services],
      ports: { ...this.ring.ports },
      servedCount: this.servedCount,
      bufferOverflows: this.bufferOverflows,
    };
    if (this.lastError !== undefined) s.lastError = this.lastError;
    return s;
  }

  noteBufferOverflow(): void {
    this.bufferOverflows++;
  }

  // ------------------------------------------------------------------
  // 生命周期
  // ------------------------------------------------------------------

  start(): void {
    if (this.stopped) return;
    this.pollTimer = setInterval(() => void this.poll(), this.pollIntervalMs);
    void this.attemptConnect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await this.teardownSession("stopped");
    await this.factory.shutdown().catch(() => undefined);
  }

  // ------------------------------------------------------------------
  // 转发面
  // ------------------------------------------------------------------

  forward(input: ForwardInput, handlers: ForwardHandlers): ForwardHandle {
    if (this.state !== "direct" && this.state !== "relay") {
      throw new OfflineError(this.state === "key-all-invalid" ? "key_all_invalid" : "provider_offline", this.alias);
    }
    const session = this.session;
    if (session === null || session.dead) {
      throw new OfflineError("provider_offline", this.alias);
    }
    const id = session.allocId();
    this.inflight.set(id, handlers);
    this.servedCount++;
    const header: Record<string, unknown> = {
      v: 1,
      id,
      serviceId: input.serviceId,
      method: input.method,
      path: input.path,
      bodyLen: input.body.length,
    };
    if (input.headers !== undefined) header.headers = input.headers;
    if (input.contentType !== undefined) header.contentType = input.contentType;
    const plan = splitBody(input.body);
    void (async () => {
      try {
        await session.send(FRAME_TYPE.REQ, header, plan.firstInline ? plan.inlineBody : undefined);
        for (const chunk of plan.chunks) {
          await session.send(FRAME_TYPE.REQ_BODY, { id, seq: chunk.seq, end: chunk.end }, chunk.data);
        }
      } catch {
        // 发送失败：连接已坏（断连路径会全量终结）；兜底本地终结避免悬挂
        if (this.inflight.has(id)) {
          this.inflight.delete(id);
          session.terminal(id);
          handlers.onError({ id, code: "internal", message: "wire send failed" });
          handlers.onTerminate({ source: "local" });
        }
      }
    })();
    return {
      id,
      abort: (opts?: { ws?: boolean; code?: number }) => this.abortRequest(id, opts),
      sendData: (bytes: Uint8Array) => this.sendWsData(id, session, bytes),
    };
  }

  private abortRequest(id: string, opts?: { ws?: boolean; code?: number }): void {
    const session = this.session;
    const handlers = this.inflight.get(id);
    this.inflight.delete(id);
    this.dataUpSeq.delete(id);
    if (session === null || session.dead) return;
    if (opts?.ws === true) {
      const header: Record<string, unknown> = { id };
      if (opts.code !== undefined) header.code = opts.code;
      // CLOSE 是终结帧（send 内部登记 terminal → onTerminate → gateway 清理）
      void session.send(FRAME_TYPE.CLOSE, header).catch(() => undefined);
    } else {
      void session.send(FRAME_TYPE.ABORT, { id }).catch(() => undefined);
      session.terminal(id);
    }
    if (handlers !== undefined) handlers.onTerminate({ source: "local" });
  }

  private sendWsData(id: string, session: WireSession, bytes: Uint8Array): Promise<void> {
    if (!this.inflight.has(id)) return Promise.resolve(); // 已终结：静默丢弃
    const seq = this.dataUpSeq.get(id) ?? 0;
    this.dataUpSeq.set(id, seq + 1);
    return session.send(FRAME_TYPE.DATA_UP, { v: 1, id, seq }, bytes);
  }

  // ------------------------------------------------------------------
  // 连接 / AUTH / 重连
  // ------------------------------------------------------------------

  private setState(next: ProviderStateKind): void {
    if (this.state === next) return;
    this.state = next;
    this.onStateChange(this);
  }

  private async attemptConnect(): Promise<void> {
    if (this.stopped || this.connecting || this.session !== null) return;
    this.connecting = true;
    try {
      const raw = await this.factory.openSession();
      if (this.stopped) {
        await raw.teardown().catch(() => undefined);
        return;
      }
      this.intentionalTeardown = false;
      this.rawSession = raw;
      this.session = new WireSession({
        role: "consumer",
        transport: raw.transport,
        hooks: {
          onFrame: (f) => this.handleFrame(f),
          onPoison: (info) => this.handlePoison(info.id),
          onIdleTimeout: (id) => this.handleIdleTimeout(id),
          onDisconnect: (reason) => this.handleDisconnect(reason),
          onTerminate: (id, cause) => this.handleTerminate(id, cause),
        },
      });
      raw.onPathChange?.((status) => {
        if (this.state === "direct" || this.state === "relay") {
          this.setState(status === "relay" ? "relay" : status === "direct" ? "direct" : this.state);
        }
      });
      this.setState("connected-unauthed");
      if (this.ring.keys.length > 0) {
        await this.session.send(FRAME_TYPE.AUTH, { v: 1, keys: [...this.keys] });
      }
      // 钥环为空（join-only）：保持 connected-unauthed，不发起注定失败的 AUTH
    } catch (err) {
      this.lastError = (err as Error).message;
      this.setState("offline");
      this.scheduleRetry();
    } finally {
      this.connecting = false;
    }
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    if (this.retryTimer !== null) return;
    const delay = fullJitterDelayMs(this.attempt, this.backoff);
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.attemptConnect();
    }, delay);
  }

  private async teardownSession(reason: string): Promise<void> {
    const session = this.session;
    const raw = this.rawSession;
    this.session = null;
    this.rawSession = null;
    if (session !== null && !session.dead) session.dispose(reason);
    if (raw !== null) await raw.teardown().catch(() => undefined);
  }

  /** 主动重建（毒化/复核失败路径）：拆会话后立即重连（不经退避首发，但保留 attempt 防毒化热循环）。 */
  private async rebuild(reason: string): Promise<void> {
    if (this.stopped) return;
    if (this.state !== "key-all-invalid") this.setState("offline"); // 拆除期间如实呈现离线
    this.intentionalTeardown = true;
    await this.teardownSession(reason);
    void this.attemptConnect();
  }

  // ------------------------------------------------------------------
  // WireSession hooks
  // ------------------------------------------------------------------

  private handleFrame(frame: InboundFrame): void {
    switch (frame.type) {
      case FRAME_TYPE.AUTH_OK:
        this.handleAuthOk(frame.header);
        return;
      case FRAME_TYPE.AUTH_ERR:
        this.handleAuthErr();
        return;
      case FRAME_TYPE.RESP_META: {
        this.inflight.get(frame.header.id)?.onMeta(frame.header);
        return;
      }
      case FRAME_TYPE.RESP_CHUNK: {
        this.inflight.get(frame.header.id)?.onChunk(frame.body);
        return;
      }
      case FRAME_TYPE.RESP_END: {
        const h = this.inflight.get(frame.header.id);
        if (h !== undefined) {
          this.inflight.delete(frame.header.id);
          this.dataUpSeq.delete(frame.header.id);
          h.onEnd();
          h.onTerminate({ source: "peer", frameType: frame.type });
        }
        return;
      }
      case FRAME_TYPE.ERROR: {
        // ERROR.id 可选（无 id 时无从路由到具体请求，交由上层连接级处置）
        const errId = frame.header.id;
        if (errId !== undefined) {
          const h = this.inflight.get(errId);
          if (h !== undefined) {
            this.inflight.delete(errId);
            this.dataUpSeq.delete(errId);
            h.onError(frame.header);
            h.onTerminate({ source: "peer", frameType: frame.type });
          }
        }
        return;
      }
      case FRAME_TYPE.DATA_DOWN: {
        this.inflight.get(frame.header.id)?.onWsData(frame.body);
        return;
      }
      case FRAME_TYPE.CLOSE: {
        const h = this.inflight.get(frame.header.id);
        if (h !== undefined) {
          this.inflight.delete(frame.header.id);
          this.dataUpSeq.delete(frame.header.id);
          h.onWsClose(frame.header.code);
          h.onTerminate({ source: "peer", frameType: frame.type });
        }
        return;
      }
      case FRAME_TYPE.PING:
        return; // 活度信号（mux 空闲计时已重置）；无业务动作
      default:
        return; // ABORT（对端不发）/AUTH 族已处理；方向违规帧 mux 已静默丢弃
    }
  }

  private handleAuthOk(header: AuthOkHeader): void {
    const session = this.session;
    if (session === null) return;
    session.markAuthed();
    this.attempt = 0; // AUTH 通过：退避窗口复位
    this.lastError = undefined;
    // 目录全量替换（初次与 refresh 同构）+ 密钥元数据回填 + 持久化
    const services: ServiceEntry[] = [];
    const seen = new Set<string>();
    for (const g of header.groups) {
      for (const s of g.services) {
        if (!seen.has(s.serviceId)) {
          seen.add(s.serviceId);
          services.push(s);
        }
      }
    }
    // 磁盘侧 actualPorts 可能已被引擎监听回写更新（端口自动错开）——目录同步
    // 若用构造期内存快照整体落盘会覆写清空；应用前先取磁盘现值
    const persisted = loadKeyring(this.root, this.ring.endpointId);
    const base = persisted === undefined ? this.ring : { ...this.ring, actualPorts: persisted.actualPorts };
    let ring = applyCatalog(base, { alias: header.alias, relayUrls: header.relayUrls, services });
    ring = reconcileKeyMetadata(ring, header.groups.map((g) => ({ keyId: g.keyId, group: g.group })));
    this.ring = ring;
    this.alias = ring.alias;
    saveKeyring(this.root, ring);
    this.onCatalog(this, ring);
    // 路径类型落地（AUTH 之前先置直接可用态，随后按 linkStatus 修正 direct/relay）
    this.setState("direct");
    void this.rawSession
      ?.linkStatus()
      .then((s) => {
        if (s === "relay") this.setState("relay");
        else if (s === "direct") this.setState("direct");
      })
      .catch(() => undefined);
  }

  private handleAuthErr(): void {
    // 全部密钥被拒：不重试 AUTH（单次即断语义），等待 key add（环变化触发恢复）
    this.lastError = "all keys rejected by provider";
    this.setState("key-all-invalid");
    this.intentionalTeardown = true;
    void this.teardownSession("auth-err");
  }

  private handlePoison(id: string): void {
    // protocol_seq：该 id 已由 mux 终结（onTerminate 路由），此处重建整个连接
    void id;
    void this.rebuild("protocol-seq");
  }

  private handleIdleTimeout(id: string): void {
    const session = this.session;
    const handlers = this.inflight.get(id);
    this.inflight.delete(id);
    this.dataUpSeq.delete(id);
    if (session !== null && !session.dead) {
      void session.send(FRAME_TYPE.ABORT, { id }).catch(() => undefined);
      session.terminal(id);
    }
    handlers?.onTerminate({ source: "local" });
  }

  private handleDisconnect(reason: string | undefined): void {
    const handlers = [...this.inflight.entries()];
    this.inflight.clear();
    this.dataUpSeq.clear();
    this.session = null;
    this.rawSession = null;
    const cause: TerminateCause = reason === undefined ? { source: "disconnected" } : { source: "disconnected", reason };
    for (const [, h] of handlers) h.onTerminate(cause);
    if (this.stopped || this.intentionalTeardown) {
      this.intentionalTeardown = false; // rebuild/stop/auth-err 主动拆除：状态由调用方接管
      return;
    }
    this.lastError = reason ?? "connection lost";
    this.setState("offline");
    this.scheduleRetry();
  }

  private handleTerminate(id: string, cause: TerminateCause): void {
    // 注意次序：mux 对对端终结帧先触发 onTerminate、后 deliver 帧本体——peer 情况必须
    // 留给 handleFrame（RESP_END/ERROR/CLOSE）路由并清理，此处只处置本地/断连类终结。
    if (cause.source === "peer") return;
    const handlers = this.inflight.get(id);
    if (handlers === undefined) return;
    this.inflight.delete(id);
    this.dataUpSeq.delete(id);
    handlers.onTerminate(cause);
  }

  // ------------------------------------------------------------------
  // 30s 低频复核（事件丢失兜底）+ key_all_invalid 环变化监视
  // ------------------------------------------------------------------

  private async poll(): Promise<void> {
    if (this.stopped) return;
    if (this.state === "key-all-invalid") {
      // AUTH 全拒后的恢复路径：钥环文件变化（另一进程 key add）→ 重连重 AUTH
      const fresh = this.reloadRing(this.endpointId);
      if (fresh === undefined) return;
      const snapshot = JSON.stringify(fresh.keys.map((k) => k.key));
      if (snapshot !== this.lastKeySnapshot) {
        this.ring = fresh;
        this.alias = fresh.alias;
        this.lastKeySnapshot = snapshot;
        this.setState("offline");
        void this.attemptConnect();
      }
      return;
    }
    if (this.rawSession === null || this.session === null) return;
    if (this.state !== "direct" && this.state !== "relay" && this.state !== "connected-unauthed") return;
    try {
      const s = await this.rawSession.linkStatus();
      if (s === "unknown" && !this.stopped && this.session !== null) {
        // 事件丢失兜底：连接事实已不存在 → 重建
        await this.rebuild("link-status-unknown");
      }
    } catch {
      // linkStatus 查询失败不作为断连依据（可能瞬时）
    }
  }

  /** key add 等外部环变更接入（运行中引擎热更新钥环）。 */
  refreshRing(ring: Keyring): void {
    this.ring = ring;
    this.alias = ring.alias;
    const snapshot = JSON.stringify(ring.keys.map((k) => k.key));
    const changed = snapshot !== this.lastKeySnapshot;
    this.lastKeySnapshot = snapshot;
    if (changed && this.state === "key-all-invalid") {
      this.setState("offline");
      void this.attemptConnect();
    } else if (changed && (this.state === "direct" || this.state === "relay") && this.session !== null) {
      // 在线追加密钥：重复 AUTH 以最后一次为准（重授权语义）
      void this.session
        .send(FRAME_TYPE.AUTH, { v: 1, keys: [...this.keys] })
        .catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// 管理器：多提供者并存（P1 离线不影响 P2）
// ---------------------------------------------------------------------------

export interface ProviderManagerOptions {
  rings: readonly Keyring[];
  /** consumers 根目录（目录刷新落盘）。 */
  root: string;
  sessionFactory: (ring: Keyring) => ProviderTransportSessionFactory;
  backoff?: BackoffOpts;
  pollIntervalMs?: number;
  onCatalog?: (providerId: string, alias: string, services: readonly ServiceEntry[], ports: Readonly<Record<string, number>>) => void;
  onStateChange?: (providerId: string, state: ProviderStateKind) => void;
}

export class ProviderManager {
  private readonly conns = new Map<string, ProviderConnection>();

  constructor(private readonly opts: ProviderManagerOptions) {
    for (const ring of opts.rings) {
      this.conns.set(ring.endpointId, new ProviderConnection({
        ring,
        root: opts.root,
        factory: opts.sessionFactory(ring),
        ...(opts.backoff !== undefined ? { backoff: opts.backoff } : {}),
        ...(opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {}),
        onCatalog: (conn, updated) => {
          // 停用服务不进入网关物化视图（service-lifecycle：目录同步不复活停用服务）
          const visible = updated.services.filter((s) => !updated.disabledServices.includes(s.serviceId));
          opts.onCatalog?.(conn.endpointId, updated.alias, visible, updated.ports);
        },
        onStateChange: (conn) => {
          opts.onStateChange?.(conn.endpointId, conn.state);
        },
        reloadRing: (endpointId) => loadKeyring(opts.root, endpointId),
      }));
    }
  }

  start(): void {
    for (const conn of this.conns.values()) conn.start();
  }

  async stop(): Promise<void> {
    await Promise.all([...this.conns.values()].map((c) => c.stop()));
  }

  snapshot(): ProviderStatus[] {
    return [...this.conns.values()].map((c) => c.status());
  }

  routeFor(providerId: string): ProviderRoute | undefined {
    return this.conns.get(providerId);
  }

  connection(providerId: string): ProviderConnection | undefined {
    return this.conns.get(providerId);
  }
}
