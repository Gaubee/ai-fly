// 使用方提供者管理器（consumer spec「提供者在线性与离线语义」「目录同步处理」；
// opendweb-kernel-migration）：每个已导入提供者一个 Fabric 实例 + 内核
// SessionHandle（Fabric.openSession——auto-resume 驱动在 SDK 内核，断线续传对
// JS 透明）；状态机消费 SessionHandle.onState（design §1 映射表：negotiating→
// not-connected；active+未 AUTH→connected-unauthed；active+AUTH 过→按
// continuitySnapshot.path 投影 direct/relay；recovering→offline 瞬断语义（在途
// 挂起不提前 503）；dead/closed→offline 终态（新请求 503 provider_offline））。
// 第二套连接生命周期（full-jitter 退避重连/linkStatus 30s 轮询/peer-disconnected
// 事件重建/REQ-RESP 多路复用记账）全部退役——仅在会话 dead（恢复窗口耗尽或
// REQUEST_STATE_LOST）后重建会话（openSession 收敛重试有界，失败按退避重试）。
// AUTH HTTP 化：session active 后 POST /_aifly/auth（空钥环保持
// connected-unauthed；全拒 → key-all-invalid，不重建会话）；目录刷新经
// /_aifly/catalog-watch 长轮询（refresh 全量替换，走既有 onCatalog 路径）。
// 正交意图：
// - Fabric 事实全部经 FabricLike/FabricFactory 结构接口注入（vitest 与 SDK 原生模块
//   隔离；真实接线在 CLI 层 lazy import SDK）；
// - 会话事实经 SessionHandleLike 结构接口注入（真实 SessionHandle 结构满足；
//   单测用内存假体）；
// - 请求转发只经内核 HTTP 投影（fetchHttp/keepOpen 隧道）；本地端口/HTTP/WS
//   还原在 gateway.ts。

import {
  AIFLY_AUTH_PATH,
  AIFLY_WATCH_PATH,
  AIFLY_SERVICE_HEADER,
  AIFLY_WS_CLOSE_HEADER,
  looksLikeWsCloseTrailer,
  decodeWsCloseTrailer,
} from "../wire/http-protocol.ts";
import {
  AUTH_OK_HEADER_SCHEMA,
  RESP_META_HEADER_WHITELIST,
  SERVICE_DETAIL_SCHEMA,
  type AuthOkHeader,
  type ErrorHeader,
  type RespMetaHeader,
  type ServiceDetail,
  type ServiceEntry,
} from "../wire/frames.ts";
import { applyCatalog, reconcileKeyMetadata, saveKeyring, loadKeyring, type Keyring } from "./store.ts";

// ---------------------------------------------------------------------------
// Fabric / Session 结构接口（SDK 消费侧子集；真实结构满足此接口）
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

/** fetchHttp 请求初始化（SDK FetchHttpInit 结构子集）。 */
export interface FetchHttpInitLike {
  method: string;
  path: string;
  headers?: Array<{ name: string; value: string }>;
  body?: Array<Uint8Array> | null;
  keepOpen?: boolean;
  /** 响应头等待上限毫秒（默认 30s——watch 长轮询按需放宽）。 */
  headTimeoutMs?: number;
}

/** fetchHttp 响应（SDK HttpClientResponseJs 结构子集；pull-first bodyNext）。 */
export interface FetchHttpResponseLike {
  status: number;
  headers: Array<{ name: string; value: string }>;
  streamId: number;
  bodyNext(): Promise<Buffer | null>;
  /** keepOpen 隧道 client→provider 方向（WS 101 后）。 */
  sendTunnel?(data: Buffer): Promise<void>;
  /** per-request 取消（SDK B1/B2 轮补齐面：取消内核流并终结在途 bodyNext）。 */
  abort?(): void;
}

/** 会话状态快照（SDK SessionStateSnapshotJs 结构子集）。 */
export interface SessionStateLike {
  peerId: string;
  sessionId: string;
  phase: string;
  streamCount?: number | undefined;
  journalBytes?: number | undefined;
}

/** 内核会话句柄（SDK SessionHandle 结构子集；auto-resume 驱动内建）。 */
export interface SessionHandleLike {
  readonly peerId: string;
  readonly sessionId: string;
  state(): Promise<SessionStateLike>;
  onState(callback: (state: SessionStateLike) => void): () => void;
  close(): Promise<void>;
  fetchHttp(init: FetchHttpInitLike): Promise<FetchHttpResponseLike>;
}

export interface FabricLike {
  readonly endpointId: string;
  connect(endpointId: string): Promise<void>;
  disconnect(endpointId: string): Promise<void>;
  on(callback: (event: FabricEventLike) => void): () => void;
  members(): Promise<FabricMember[]>;
  relayStatus(): Promise<{ urls: string[] }>;
  shutdown(): Promise<void>;
  /** 内核会话唯一创建入口（幂等：active/recovering 返回既有；dead 后新建）。 */
  openSession(peerId: string): Promise<SessionHandleLike>;
  /** 对端连接路径快照（direct/relay/unknown；path 投影用）。 */
  continuitySnapshot(peerId: string): Promise<{ path: string }>;
}

/** Fabric 工厂（join/open）；CLI 层以 lazy import SDK 实现，测试注入 fake。 */
export interface FabricFactory {
  open(opts: { dataDir: string; relayUrls?: string[] }): Promise<FabricLike>;
  joinWithToken(opts: { dataDir: string; relayUrls?: string[] }, token: string): Promise<FabricLike>;
}

// ---------------------------------------------------------------------------
// 会话重建退避（full jitter 指数，1s→60s；纯函数便于边界测试）
// ---------------------------------------------------------------------------
// 语义变化（kernel-migration）：退避不再用于传输层重连竞速（内核 auto-resume
// 承接 recovering），仅用于会话 dead 后的 openSession 重建重试（对端长期离线时
// 避免热循环）。

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_CAP_MS = 60_000;
/** 钥环文件复核间隔（key add 等外部进程写入的发现；与传输层轮询无关——
 *  在线性归内核会话状态，此处仅复核磁盘钥环）。 */
export const RING_POLL_MS = 30_000;

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

/** 本地请求 → 内核 fetchHttp 的入参（gateway 已剥离凭据头；contentType 独立字段承载）。 */
export interface ForwardInput {
  serviceId: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  contentType?: string;
  body: Uint8Array;
  /** true = WS 升级请求（握手头透传；走 keepOpen 字节隧道）。 */
  upgrade: boolean;
}

/** 请求终结原因（旧 wire 帧终结语义的承载面无关投影；gateway 消费）。 */
export type TerminateCause =
  | { source: "peer" }
  | { source: "local" }
  | { source: "disconnected"; reason?: string };

export interface ForwardHandlers {
  onMeta(header: RespMetaHeader): void;
  onChunk(body: Uint8Array): void;
  onEnd(): void;
  onError(header: ErrorHeader): void;
  /** WS：提供方隧道下行字节。 */
  onWsData(body: Uint8Array): void;
  /** WS：提供方关闭（终结；code 缺省 = 无码关闭）。 */
  onWsClose(code: number | undefined): void;
  /** 请求终结（本地中止/会话终态等；对端终结已先行经 onEnd/onError/onWsClose 路由）。 */
  onTerminate(cause: TerminateCause): void;
}

export interface ForwardHandle {
  readonly id: string;
  /**
   * 本地客户端断开：停止回调投递并放弃内核响应流（本阶段 NAPI 无 per-request
   * cancel 通道——提供端靠内核 journal 上限有界收敛；SDK 补齐后接流取消）。
   */
  abort(opts?: { ws?: boolean; code?: number }): void;
  /** WS 上行隧道字节（keepOpen sendTunnel；101 前到达静默丢弃）。 */
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
  | "not-connected" // 未连接（启动前/会话建立中）
  | "connected-unauthed" // 会话 active 且 AUTH 未过（含钥环为空只入网的提供者）
  | "direct" // active 且 AUTH 过，路径直连
  | "relay" // active 且 AUTH 过，路径经 relay
  | "offline" // 会话 recovering（瞬断，在途挂起）或 dead/closed（终态，新请求 503）
  | "key-all-invalid"; // AUTH_ERR：全部密钥被拒（等待 key add / 重新签发）

export interface ProviderStatus {
  endpointId: string;
  alias: string;
  state: ProviderStateKind;
  services: ServiceEntry[];
  ports: Record<string, number>;
  servedCount: number;
  /** 退役记账（kernel-migration：背压归内核 journal；恒 0，观测面为 journalBytes）。 */
  bufferOverflows: number;
  lastError?: string;
}

/** gateway 路由面：按提供者取转发入口。 */
export interface ProviderRoute {
  readonly alias: string;
  readonly state: ProviderStateKind;
  forward(input: ForwardInput, handlers: ForwardHandlers): ForwardHandle;
  /** 兼容占位（bufferOverflows 记账退役；no-op）。 */
  noteBufferOverflow(): void;
}

// ---------------------------------------------------------------------------
// 底层 fabric 工厂抽象
// ---------------------------------------------------------------------------

export interface ProviderSessionFactory {
  /** 打开/复用底层 fabric（幂等；consumer 进程生命周期内一个实例）。 */
  open(): Promise<FabricLike>;
  /** 底层实例彻底关闭（进程退出路径）。 */
  shutdown(): Promise<void>;
}

/**
 * 真实接线：一个 Fabric 实例（open 一次复用）。会话由 ProviderConnection 经
 * Fabric.openSession 管理。FabricLike 是 SDK Fabric 的结构子集，经 unknown
 * 收窄（SDK 类型仅 type import，vitest 不触原生模块）。
 */
export function createFabricSessionFactory(
  factory: FabricFactory,
  info: {
    dataDir: string;
    providerEndpointId: string;
    /** 该 ring 内嵌的 relay 入口（链接带来；缺省走工厂层解析）。 */
    relayUrls?: string[];
  },
): ProviderSessionFactory {
  let fabric: FabricLike | undefined;
  return {
    open: async () => {
      fabric ??= await factory.open({
        dataDir: info.dataDir,
        ...(info.relayUrls !== undefined && info.relayUrls.length > 0
          ? { relayUrls: info.relayUrls }
          : {}),
      });
      return fabric;
    },
    shutdown: async () => {
      const f = fabric;
      fabric = undefined;
      if (f !== undefined) await f.shutdown().catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// 单提供者连接（内核会话状态机 + AUTH + 目录 + watch）
// ---------------------------------------------------------------------------

interface BackoffOpts {
  baseMs?: number;
  capMs?: number;
}

/** 白名单响应头挑选（小写键；RESP_META 白名单三头约束保持）。 */
function pickWhitelist(headers: Array<{ name: string; value: string }>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const h of headers) {
    if (RESP_META_HEADER_WHITELIST.has(h.name.toLowerCase())) out[h.name.toLowerCase()] = h.value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function headerValue(headers: Array<{ name: string; value: string }>, name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name)?.value;
}

export class ProviderConnection implements ProviderRoute {
  readonly endpointId: string;
  alias: string;
  state: ProviderStateKind = "not-connected";

  private readonly root: string;
  private readonly factory: ProviderSessionFactory;
  private readonly backoff: BackoffOpts;
  private readonly ringPollMs: number;
  private ringTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onCatalog: (conn: ProviderConnection, ring: Keyring) => void;
  private readonly onCatalogError: (providerId: string, message: string) => void;
  private readonly onStateChange: (conn: ProviderConnection) => void;
  private readonly reloadRing: (endpointId: string) => Keyring | undefined;

  private ring: Keyring;
  private fabric: FabricLike | null = null;
  private session: SessionHandleLike | null = null;
  private offState: (() => void) | null = null;
  private offPathEvent: (() => void) | null = null;
  /** 已完成 AUTH 的会话 id（会话重建后置空 → 重新 AUTH）。 */
  private authedSessionId: string | null = null;
  /** 会话缓存相位（forward 快速失败判定：dead/closed 才 503）。 */
  private sessionPhase: string = "closed";
  /** watch 循环代次（会话替换/停止时递增使旧循环退出）。 */
  private watchGen = 0;
  /** AUTH 进行中（防 active 抖动重入）。 */
  private authInFlight: Promise<void> | null = null;
  private ensuringSession = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastKeySnapshot = "";
  private reqSeq = 0;
  private stopped = false;
  servedCount = 0;
  bufferOverflows = 0;
  lastError: string | undefined;

  constructor(opts: {
    ring: Keyring;
    root: string;
    factory: ProviderSessionFactory;
    backoff?: BackoffOpts;
    ringPollMs?: number;
    onCatalog?: (conn: ProviderConnection, ring: Keyring) => void;
    /** 目录同步失败通知（AUTH_OK 二阶段 detail 投影解析失败；保留旧视图）。 */
    onCatalogError?: (providerId: string, message: string) => void;
    onStateChange?: (conn: ProviderConnection) => void;
    reloadRing?: (endpointId: string) => Keyring | undefined;
  }) {
    this.ring = opts.ring;
    this.endpointId = opts.ring.endpointId;
    this.alias = opts.ring.alias;
    this.root = opts.root;
    this.factory = opts.factory;
    this.backoff = opts.backoff ?? {};
    this.ringPollMs = opts.ringPollMs ?? RING_POLL_MS;
    this.onCatalog = opts.onCatalog ?? (() => undefined);
    this.onCatalogError = opts.onCatalogError ?? (() => undefined);
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
      bufferOverflows: 0,
    };
    if (this.lastError !== undefined) s.lastError = this.lastError;
    return s;
  }

  noteBufferOverflow(): void {
    // 退役记账（内核 journal 反压承接）；保留方法以兼容 gateway 路由面。
  }

  // ------------------------------------------------------------------
  // 生命周期
  // ------------------------------------------------------------------

  start(): void {
    if (this.stopped) return;
    // 钥环文件复核（key add/外部进程写入的发现；key_all_invalid 恢复路径）
    if (this.ringTimer === null) {
      this.ringTimer = setInterval(() => this.pollRing(), this.ringPollMs);
      this.ringTimer.unref?.();
    }
    void this.ensureSession();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.watchGen++;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ringTimer !== null) {
      clearInterval(this.ringTimer);
      this.ringTimer = null;
    }
    const session = this.session;
    this.detachSession();
    await session?.close().catch(() => undefined);
    await this.factory.shutdown().catch(() => undefined);
  }

  // ------------------------------------------------------------------
  // 转发面（fetchHttp / keepOpen 隧道）
  // ------------------------------------------------------------------

  forward(input: ForwardInput, handlers: ForwardHandlers): ForwardHandle {
    if (this.state === "key-all-invalid") {
      throw new OfflineError("key_all_invalid", this.alias);
    }
    const session = this.session;
    // dead/closed（终态）才快速失败；recovering 期间在途/新请求挂起等续传
    // （fetchHttp/bodyNext 在内核侧挂起，auto-resume 后原序继续）。
    if (session === null || this.sessionPhase === "dead" || this.sessionPhase === "closed") {
      throw new OfflineError("provider_offline", this.alias);
    }
    this.servedCount++;
    const id = `r${++this.reqSeq}`;
    const headers: Array<{ name: string; value: string }> = [];
    for (const [name, value] of Object.entries(input.headers ?? {})) headers.push({ name, value });
    if (input.contentType !== undefined && input.contentType !== "") {
      headers.push({ name: "content-type", value: input.contentType });
    }
    headers.push({ name: AIFLY_SERVICE_HEADER, value: input.serviceId });
    let aborted = false;
    let tunnel: FetchHttpResponseLike | null = null;
    const pump = (async () => {
      try {
        const resp = await session.fetchHttp({
          method: input.method,
          path: input.path,
          headers,
          ...(input.body.length > 0 ? { body: [input.body] } : {}),
          ...(input.upgrade ? { keepOpen: true } : {}),
        });
        if (aborted) {
          // 竞态收口：等待头期间本地已中止——刚完成的响应必须即刻取消
          //（否则 provider 侧请求继续运行直至其自身超时）
          try {
            await resp.abort?.();
          } catch {
            // 取消面失败不阻断本地中止
          }
          return;
        }
        tunnel = resp;
        const contentType = headerValue(resp.headers, "content-type") ?? "";
        const picked = pickWhitelist(resp.headers);
        const meta: RespMetaHeader = { id, status: resp.status, contentType, ...(picked !== undefined ? { headers: picked } : {}) };
        if (input.upgrade && resp.status === 101) {
          handlers.onMeta(meta);
          // 关闭码带内尾块（流式载体）：形态命中先扣留——下一读为 EOF 则按尾块
          // 解释，否则按数据冲刷（内核保 write 分块边界，前瞻可靠）。
          let held: Buffer | null = null;
          for (;;) {
            const c = await resp.bodyNext();
            if (aborted) return;
            if (c === null) break;
            if (held !== null) {
              handlers.onWsData(new Uint8Array(held));
              held = null;
            }
            if (looksLikeWsCloseTrailer(c)) {
              held = c;
              continue;
            }
            handlers.onWsData(new Uint8Array(c));
          }
          if (aborted) return;
          let closeCode: number | undefined;
          if (held !== null) {
            const decoded = decodeWsCloseTrailer(held);
            if (decoded !== null) closeCode = decoded;
            else handlers.onWsData(new Uint8Array(held)); // 非 trailer 形态：冲刷
          }
          if (closeCode === undefined) {
            // 兼容兜底：静态载体时代的响应头透传
            const closeRaw = headerValue(resp.headers, AIFLY_WS_CLOSE_HEADER);
            const code = closeRaw !== undefined ? Number(closeRaw) : undefined;
            if (code !== undefined && Number.isInteger(code) && code >= 1000 && code <= 65535) closeCode = code;
          }
          handlers.onWsClose(closeCode);
          handlers.onTerminate({ source: "peer" });
          return;
        }
        handlers.onMeta(meta);
        for (;;) {
          const c = await resp.bodyNext();
          if (aborted) return;
          if (c === null) break;
          handlers.onChunk(new Uint8Array(c));
        }
        if (aborted) return;
        handlers.onEnd();
        handlers.onTerminate({ source: "peer" });
      } catch {
        if (aborted) return;
        // 确定错误（会话终态终结在途请求 / 内核响应头等待超时）：504 语义。
        // code 超出 wire 帧枚举（帧族退役；shared 映射表按字符串查表）。
        handlers.onError({ id, code: "session_lost", message: "provider session ended" } as unknown as ErrorHeader);
        handlers.onTerminate({ source: "disconnected", reason: "session ended" });
      }
    })();
    void pump.catch(() => undefined);
    return {
      id,
      abort: () => {
        // 本地中止：停止回调投递 + best-effort 取消内核请求（SDK abort() 为
        // B1/B2 轮补齐面——当前版本缺席时仅本地停泵；到位后取消内核流并使
        // provider 侧在途 handler 经取消结算收敛）。
        aborted = true;
        try {
          tunnel?.abort?.();
        } catch {
          // 取消面失败不阻断本地中止
        }
      },
      sendData: (bytes: Uint8Array) => {
        if (aborted || tunnel === null || tunnel.sendTunnel === undefined) return Promise.resolve();
        return tunnel.sendTunnel(Buffer.from(bytes)).catch(() => undefined);
      },
    };
  }

  // ------------------------------------------------------------------
  // 会话生命周期（openSession / onState 驱动 / dead 重建）
  // ------------------------------------------------------------------

  private setState(next: ProviderStateKind): void {
    if (this.state === next) return;
    this.state = next;
    this.onStateChange(this);
  }

  private detachSession(): void {
    this.offState?.();
    this.offState = null;
    this.session = null;
    this.sessionPhase = "closed";
    this.authedSessionId = null;
  }

  private async ensureSession(): Promise<void> {
    if (this.stopped || this.ensuringSession || this.session !== null) return;
    this.ensuringSession = true;
    try {
      this.fabric ??= await this.factory.open();
      const fabric = this.fabric;
      const session = await fabric.openSession(this.endpointId);
      if (this.stopped) {
        await session.close().catch(() => undefined);
        return;
      }
      this.session = session;
      this.offState = session.onState((s) => this.handleState(s));
      this.offPathEvent ??= fabric.on((event) => {
        if (
          event.type === "path-changed" &&
          event.endpointId === this.endpointId &&
          (this.state === "direct" || this.state === "relay")
        ) {
          this.setState(event.status === "relay" ? "relay" : event.status === "direct" ? "direct" : this.state);
        }
      });
      const initial = await session.state().catch(() => undefined);
      this.sessionPhase = initial?.phase ?? "active";
      this.handleState({ peerId: session.peerId, sessionId: session.sessionId, phase: this.sessionPhase });
    } catch (err) {
      this.lastError = (err as Error).message;
      this.setState("offline");
      this.scheduleRetry();
    } finally {
      this.ensuringSession = false;
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer !== null) return;
    const delay = fullJitterDelayMs(this.attempt, this.backoff);
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.ensureSession();
    }, delay);
  }

  private handleState(s: SessionStateLike): void {
    const session = this.session;
    if (session === null || s.sessionId !== session.sessionId) return; // 旧会话尾事件
    this.sessionPhase = s.phase;
    switch (s.phase) {
      case "negotiating":
        this.setState("not-connected");
        return;
      case "recovering":
        // 瞬断不直达：在途/新请求挂起（内核 auto-resume）；状态如实呈现 offline。
        // 授权不随恢复重呈（spec：同 session 恢复不重 AUTH——提供端授权随会话
        // 存续）；撤钥收敛改由 watch 401 失效路径承接（restartWatch 于 active）。
        this.setState("offline");
        return;
      case "active":
        this.attempt = 0;
        if (this.authedSessionId === session.sessionId || this.ring.keys.length === 0) {
          if (this.ring.keys.length === 0) {
            this.setState("connected-unauthed"); // 空钥环（join-only）：不发起 AUTH
          } else {
            void this.projectPath();
            this.restartWatch(session);
          }
          return;
        }
        this.setState("connected-unauthed");
        void this.runAuth(session);
        return;
      case "dead":
      case "closed": {
        // 终态：在途请求由 bodyNext 抛错终结（forward pump 已映射）；重建会话
        //（provider 重启 REQUEST_STATE_LOST / 恢复窗口耗尽）并重新 AUTH。
        const wasAuthed = this.authedSessionId !== null;
        this.offState?.();
        this.offState = null;
        this.session = null;
        this.sessionPhase = s.phase;
        this.authedSessionId = null;
        this.watchGen++;
        if (wasAuthed) this.lastError = `session ${s.phase}`;
        // recovering 已置 offline——终态离线语义升级（瞬断→终态，新请求 503），
        // 显式补发通知（setState 对同值 no-op）。
        if (this.state === "offline") this.onStateChange(this);
        this.setState("offline");
        if (!this.stopped) void this.ensureSession();
        return;
      }
      default:
        return;
    }
  }

  /** active 后路径投影（continuitySnapshot.path → direct/relay；缺省 direct）。 */
  private async projectPath(): Promise<void> {
    const fabric = this.fabric;
    if (fabric === null) return;
    try {
      const snap = await fabric.continuitySnapshot(this.endpointId);
      if (snap.path === "relay") this.setState("relay");
      else this.setState("direct");
    } catch {
      this.setState("direct");
    }
  }

  // ------------------------------------------------------------------
  // AUTH（HTTP 端点）与目录 watch
  // ------------------------------------------------------------------

  private async runAuth(session: SessionHandleLike): Promise<void> {
    if (this.authInFlight !== null) return void (await this.authInFlight.catch(() => undefined));
    const run = (async () => {
      try {
        const payload = Buffer.from(JSON.stringify({ v: 1, keys: [...this.keys] }));
        const resp = await session.fetchHttp({
          method: "POST",
          path: AIFLY_AUTH_PATH,
          headers: [{ name: "content-type", value: "application/json" }],
          body: [payload],
        });
        const body = await readAllBody(resp);
        if (resp.status === 403) {
          // 全拒：不重建会话（会话是内核资产）；等待 key add（环变化触发恢复）。
          this.lastError = "all keys rejected by provider";
          this.setState("key-all-invalid");
          return;
        }
        if (resp.status !== 200) {
          this.lastError = `auth endpoint responded ${resp.status}`;
          this.setState("connected-unauthed");
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString("utf8"));
        } catch {
          this.lastError = "auth response body is not JSON";
          this.setState("connected-unauthed");
          return;
        }
        const header = AUTH_OK_HEADER_SCHEMA.safeParse(parsed);
        if (!header.success) {
          this.lastError = "auth response schema rejected";
          this.setState("connected-unauthed");
          return;
        }
        // 二阶段目录解析失败：AUTH 已通过（会话 authed）、保留旧视图（既有语义）。
        this.authedSessionId = session.sessionId;
        this.lastError = undefined;
        this.applyCatalog(header.data);
        await this.projectPath();
        const seq = Number(headerValue(resp.headers, "x-aifly-catalog-seq") ?? "0");
        this.restartWatch(session, Number.isFinite(seq) ? seq : 0);
      } catch (err) {
        // AUTH 交换失败（会话瞬断/终态）：等下一次 active 转换重试。
        this.lastError = `auth exchange failed: ${(err as Error).message}`;
      }
    })();
    this.authInFlight = run;
    try {
      await run;
    } finally {
      this.authInFlight = null;
    }
  }

  /** 目录刷新长轮询（会话替换/停止时旧循环退出）。 */
  private restartWatch(session: SessionHandleLike, since = 0): void {
    if (this.stopped || this.ring.keys.length === 0) return;
    this.watchGen++;
    const gen = this.watchGen;
    let seq = since;
    void (async () => {
      while (
        !this.stopped &&
        gen === this.watchGen &&
        this.session === session &&
        this.sessionPhase === "active"
      ) {
        try {
          const resp = await session.fetchHttp({
            method: "GET",
            path: `${AIFLY_WATCH_PATH}?since=${seq}`,
            // 长轮询响应头贴着提供端 20s 等待窗——留裕量防 30s 默认值边缘竞态
            headTimeoutMs: 35_000,
          });
          if (resp.status === 204) {
            const cur = Number(headerValue(resp.headers, "x-aifly-catalog-seq") ?? "0");
            if (Number.isFinite(cur)) seq = cur;
            continue;
          }
          if (resp.status === 401) {
            // 授权失效信号（提供端撤钥后 watch 等待者被 401 唤醒）：立即重呈
            // AUTH 复核——全拒 → key_all_invalid；误报 → 200 刷新视图续跑。
            void this.runAuth(session);
            return;
          }
          if (resp.status !== 200) return; // 其他异常：退出循环（active 转换重启）
          const body = await readAllBody(resp);
          const cur = Number(headerValue(resp.headers, "x-aifly-catalog-seq") ?? "0");
          if (Number.isFinite(cur)) seq = cur;
          const header = AUTH_OK_HEADER_SCHEMA.safeParse(JSON.parse(body.toString("utf8")));
          if (header.success) this.applyCatalog(header.data);
        } catch {
          return; // 会话终态/瞬断：由 onState 驱动重启
        }
      }
    })();
  }

  /** AUTH_OK 目录全量替换（初次与 refresh 同构）+ 密钥元数据回填 + 持久化。 */
  private applyCatalog(header: AuthOkHeader): void {
    const services: ServiceEntry[] = [];
    const seen = new Set<string>();
    let catalogError: string | undefined;
    for (const g of header.groups) {
      for (const s of g.services) {
        if (seen.has(s.serviceId)) continue;
        seen.add(s.serviceId);
        // detail 二阶段严格解析（SERVICE_DETAIL_SCHEMA；失败走 onCatalogError，
        // 保留旧视图——旧 mux 二阶段语义平移）。
        let detail: ServiceDetail | undefined;
        if (s.detail !== undefined) {
          const parsedDetail = SERVICE_DETAIL_SCHEMA.safeParse(s.detail);
          if (parsedDetail.success) detail = parsedDetail.data;
          else catalogError = `catalog detail projection rejected for service ${s.serviceId}`;
        }
        services.push({
          serviceId: s.serviceId,
          name: s.name,
          match: s.match,
          defaultPort: s.defaultPort,
          ...(detail !== undefined ? { detail } : {}),
        });
      }
    }
    if (catalogError !== undefined) {
      this.lastError = catalogError;
      this.onCatalogError(this.endpointId, catalogError);
      return;
    }
    this.lastError = undefined;
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
  }

  /** 磁盘钥环复核（key_all_invalid 等待 key add 的恢复路径）。 */
  private pollRing(): void {
    if (this.stopped) return;
    if (this.state !== "key-all-invalid" && this.state !== "offline") return;
    const fresh = this.reloadRing(this.endpointId);
    if (fresh === undefined) return;
    const snapshot = JSON.stringify(fresh.keys.map((k) => k.key));
    if (snapshot !== this.lastKeySnapshot) {
      this.ring = fresh;
      this.alias = fresh.alias;
      this.lastKeySnapshot = snapshot;
      if (this.state === "key-all-invalid") {
        this.setState("offline"); // 复核期如实呈现；重 AUTH 成功即恢复
        const session = this.session;
        if (session !== null && this.sessionPhase === "active") {
          void this.runAuth(session); // 会话仍在（403 不断会话）：重呈新钥
        } else {
          void this.ensureSession();
        }
      }
    }
  }

  /** key add 等外部环变更接入（运行中引擎热更新钥环）。 */
  refreshRing(ring: Keyring): void {
    this.ring = ring;
    this.alias = ring.alias;
    const snapshot = JSON.stringify(ring.keys.map((k) => k.key));
    const changed = snapshot !== this.lastKeySnapshot;
    this.lastKeySnapshot = snapshot;
    if (!changed) return;
    const session = this.session;
    if (session !== null && this.sessionPhase === "active") {
      // 在线追加密钥/撤后重呈：重复 AUTH 以最后一次为准（重授权语义）。
      void this.runAuth(session);
      return;
    }
    if (session === null && !this.stopped) {
      void this.ensureSession();
    }
  }
}

/** 读至 EOF 聚合（pull-first bodyNext）。 */
async function readAllBody(resp: FetchHttpResponseLike): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (;;) {
    const c = await resp.bodyNext();
    if (c === null) break;
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// 管理器：多提供者并存（P1 离线不影响 P2）
// ---------------------------------------------------------------------------

export interface ProviderManagerOptions {
  rings: readonly Keyring[];
  /** consumers 根目录（目录刷新落盘）。 */
  root: string;
  sessionFactory: (ring: Keyring) => ProviderSessionFactory;
  backoff?: BackoffOpts;
  ringPollMs?: number;
  onCatalog?: (providerId: string, alias: string, services: readonly ServiceEntry[], ports: Readonly<Record<string, number>>) => void;
  /** 目录同步失败通知（AUTH_OK 二阶段 detail 投影解析失败；UI 通知通道入口）。 */
  onCatalogError?: (providerId: string, message: string) => void;
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
        ...(opts.ringPollMs !== undefined ? { ringPollMs: opts.ringPollMs } : {}),
        onCatalog: (conn, updated) => {
          // 停用服务不进入网关物化视图（service-lifecycle：目录同步不复活停用服务；
          // 环级停用整环不物化）
          const visible = updated.disabled
            ? []
            : updated.services.filter((s) => !updated.disabledServices.includes(s.serviceId));
          opts.onCatalog?.(conn.endpointId, updated.alias, visible, updated.ports);
        },
        onCatalogError: (providerId, message) => {
          opts.onCatalogError?.(providerId, message);
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
