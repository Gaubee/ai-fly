// 提供方引擎装配（opendweb-kernel-migration）：Fabric peer-connected -> per-peer
// `Fabric.serveHttp` HTTP 引擎（内核 accept 循环）-> handler 分流：
// - POST /_aifly/auth：AUTH 校验 + AUTH_OK 目录脱敏视图（既有 auth.ts 纯逻辑
//   全量复用）；鉴权结果按 peer 缓存（同一 serveHttp 引擎承接该 peer 的全部
//   会话——传输断线经内核 RESUME 续传不重 AUTH；provider 重启缓存随进程消失，
//   消费端重建会话后重新 AUTH）；
// - GET /_aifly/catalog-watch：目录刷新长轮询（<30s——内核 fetchHttp 响应头
//   等待窗；变更回 200 refresh 全量视图，未变更回 204 + 当前 seq）。旧
//   AUTH_OK 推送帧退役后的刷新通道等价物；
// - 其他：既有上游转发管线（upstream.ts/ws-upstream.ts 的 routes/strip/append/
//   auth/headers/③④ 脚本阶段、超时族、错误分族零变更）经 ResponseSink 载体
//   聚齐为静态 chunks 响应（本阶段 NAPI 承载面形态；流式供给归 SDK 后续 phase）。
// serve.ts 负责 Fabric 打开与横幅；本文件只做会话与转发逻辑（Fabric 与
// serveHttp 实现均注入，测试可用内存假体，无需原生 SDK）。
// 正交意图（本文件不实现）：
// - 上游转发细节（upstream.ts / ws-upstream.ts；引擎持有 AbortController 做中止）；
// - 存储变更的发现（serve.ts watcher 调 reloadStore；CLI 与 daemon 是不同进程）。

import type { Fabric } from "@jixo/opendweb-client-sdk";
import {
  AUTH_HEADER_SCHEMA,
  ERROR_CODE,
  HTTP_METHODS,
  type AuthHeader,
  type AuthOkHeader,
  type ErrorHeader,
  type ReqHeader,
  type RespMetaHeader,
} from "../wire/frames.ts";
import {
  AIFLY_AUTH_PATH,
  AIFLY_WATCH_PATH,
  AIFLY_CONTROL_HEADERS,
  AIFLY_SERVICE_HEADER,
  CATALOG_WATCH_TIMEOUT_MS,
  REQUEST_BODY_LIMIT_BYTES,
  encodeWsCloseTrailer,
} from "../wire/http-protocol.ts";
import { ERROR_HTTP_MAPPING, buildErrorJson } from "../shared/http-errors.ts";
import { ProviderStore } from "./store.ts";
import type { ServiceConfig } from "./store.ts";
import { LimitEnforcer, UsageLog } from "./limits.ts";
import {
  authDirectoryFromStore,
  buildAuthOk,
  evaluateKeyring,
  handleAuthFrame,
  KeySessionIndex,
  type AuthDirectory,
  type AuthSessionBinding,
  type KeyGrant,
} from "./auth.ts";
import { isWebSocketUpgradeRequest } from "./rewrite.ts";
import { forwardRequest, UpstreamAbortError, type ResponseSink, type UpstreamTimeouts } from "./upstream.ts";
import { HookMissingError, HookStageError } from "./hook.ts";
import type { WsRelayHandle } from "./ws-upstream.ts";
import type { EnvSource, SecretSource } from "./rewrite.ts";

export interface ProviderEngineOptions {
  alias?: string | undefined;
  logUsage?: boolean | undefined;
  timeouts?: Partial<UpstreamTimeouts> | undefined;
  /** $env 解析源（默认 process.env；测试注入）。 */
  env?: EnvSource | undefined;
  /** $secret 解析源（密钥库读取面；缺省由 serve 装配为 dataDir 下的 SecretsStore）。 */
  secrets?: SecretSource | undefined;
  /**
   * ①②③④ 脚本库 home 基准（复核 R2-P1-B）：与 RPC/Store 同一注入 home 贯穿到
   * forwardRequest——沙盒 HOME 下保存的 codex/用户 hook 在运行时也从同一 home
   * 解析（缺省 os.homedir()）。
   */
  home?: string | undefined;
}

// ---------------------------------------------------------------------------
// serveHttp 承载面结构类型（@jixo/opendweb-client-sdk/http 的结构子集；
// 真实实现由 serve 层动态 import /http 胶水注入，测试注入内存假体——vitest
// worker 池不触原生模块）
// ---------------------------------------------------------------------------

export interface CarrierRequest {
  requestId: number;
  streamId: number;
  /** 请求所属逻辑会话（hex；SDK 0.6.0——授权隔离键，spec 3.2）。 */
  sessionId: string;
  /** 对端取消信号（SDK 0.6.0：RESET/会话终态遗弃 → abort；正常完成不触发）。 */
  signal: AbortSignal;
  method: string;
  path: string;
  headers: Array<{ name: string; value: string }>;
  bodyNext(): Promise<Buffer | null>;
  /** 流式结算（B1/B2）：立即下发响应头，返回写句柄（已结算/晚到 → null）。 */
  respondStreaming(
    status: number,
    headers?: Array<{ name: string; value: string }>,
  ): StreamWriterHandle | null;
}

/** 流式响应写句柄（SDK respondStreaming 投影；对端 abort/RESET 时 write 报错）。 */
export interface StreamWriterHandle {
  write(chunk: Uint8Array): Promise<void>;
  finish(): void;
  readonly finished: boolean;
}

export interface CarrierResponse {
  status: number;
  headers?: Array<{ name: string; value: string }>;
  bodyChunks?: Array<Uint8Array>;
}

export interface CarrierServer {
  close(reason?: string): Promise<void>;
}

export type ServeHttpFn = (
  fabric: Fabric,
  peerId: string,
  handler: (req: CarrierRequest) => Promise<CarrierResponse | null>,
) => Promise<CarrierServer>;

interface ActiveForward {
  ctrl: AbortController;
  keyId: string;
  group: string;
  ws: WsRelayHandle | undefined;
}

/** per-peer 并发授权会话容量（LRU 逐出——内核暂无会话终结通知的防泄漏上限）。 */
const SESSION_AUTH_CAP = 32;

/** 错误码 → 载体响应（shared 映射表；null status（本地中止族）→ 504 语义）。 */
function errorCarrierResponse(code: string, message: string): CarrierResponse {
  const m = ERROR_HTTP_MAPPING[code] ?? { status: 502, type: "api_error" };
  return {
    status: m.status ?? 504,
    headers: [
      { name: "content-type", value: "application/json" },
      { name: "x-aifly-error-code", value: code },
    ],
    bodyChunks: [Buffer.from(JSON.stringify(buildErrorJson(code, message, m.type)) + "\n")],
  };
}

export class ProviderEngine {
  private readonly fabric: Fabric;
  private readonly dataDir: string;
  private readonly limitsEnforcer: LimitEnforcer;
  private readonly usageLog: UsageLog | undefined;
  private readonly serveHttpImpl: ServeHttpFn;
  readonly opts: ProviderEngineOptions;
  private storeRef: ProviderStore;
  private readonly peers = new Map<string, ProviderPeerServer>();
  private readonly keyIndex = new KeySessionIndex();
  private relayUrlsCache: string[] = [];
  private unsubscribeFabric: (() => void) | null = null;
  /** 目录代次（watch 长轮询 since 基准；每次视图变更 +1）。 */
  private catalogSeq = 0;
  private stopped = false;

  constructor(deps: {
    fabric: Fabric;
    store: ProviderStore;
    dataDir: string;
    serveHttp?: ServeHttpFn | undefined;
    limits?: LimitEnforcer | undefined;
    opts?: ProviderEngineOptions | undefined;
  }) {
    this.fabric = deps.fabric;
    this.storeRef = deps.store;
    this.dataDir = deps.dataDir;
    this.serveHttpImpl =
      deps.serveHttp ??
      (() => Promise.reject(new Error("serveHttp implementation not injected")));
    this.limitsEnforcer = deps.limits ?? new LimitEnforcer({ dataDir: deps.dataDir });
    this.limitsEnforcer.syncFromStore(deps.store);
    this.opts = deps.opts ?? {};
    this.usageLog = this.opts.logUsage === true ? new UsageLog(deps.dataDir) : undefined;
  }

  get store(): ProviderStore {
    return this.storeRef;
  }

  get limits(): LimitEnforcer {
    return this.limitsEnforcer;
  }

  /** 订阅 fabric 事件并初始化 relay 缓存（幂等）。 */
  async start(): Promise<void> {
    if (this.unsubscribeFabric !== null) return;
    await this.refreshRelayUrls();
    this.unsubscribeFabric = this.fabric.on((event) => {
      if (this.stopped) return;
      if (event.type === "peer-connected") {
        void this.addPeer(event.endpointId);
      } else if (event.type === "roster-updated") {
        // 名册同步：新成员起 HTTP 引擎；被移除成员拆引擎（跨进程 revoke 的
        // 一致性——SDK 不主动断既有会话，同进程 revoke 才断）。
        void this.reconcileMembers();
      } else if (event.type === "relay-online" || event.type === "relay-offline") {
        // relayUrls 随目录刷新同步：入口变化推 refresh 目录（watch 通道）。
        void this.refreshRelayUrls().then(() => this.broadcastRefresh());
      }
      // peer-disconnected：传输层瞬断——内核 RESUME 续传（鉴权缓存与会话保留），
      // 不拆 peer server（design §3：断线恢复不重 AUTH）。
    });
    // 主动为当前名册成员起 HTTP 引擎：入站会话传输不触发 peer-connected
    // （真内核 e2e 实证——openSession 的 SESSION_INIT_OK 由 serve 引擎的
    // accept 循环应答，须先就位）。
    await this.reconcileMembers();
  }

  /** 名册对账：新成员 addPeer；消失成员拆引擎 + 断 fabric 会话。 */
  private async reconcileMembers(): Promise<void> {
    let memberIds: string[];
    try {
      memberIds = (await this.fabric.members()).map((m) => m.endpointId);
    } catch {
      // 快照不可得（SDK 异常）：保守不动，等下一次事件复核
      return;
    }
    for (const id of memberIds) {
      if (!this.peers.has(id)) void this.addPeer(id);
    }
    for (const id of [...this.peers.keys()]) {
      if (!memberIds.includes(id)) {
        this.removePeer(id, "removed from roster");
        // 主动断开 fabric 会话（removePeer 只清引擎侧；SDK 同进程 revoke 才自动断）
        try {
          await this.fabric.disconnect(id);
        } catch {
          // 会话可能已断：忽略
        }
      }
    }
  }

  private async refreshRelayUrls(): Promise<void> {
    try {
      const status = await this.fabric.relayStatus();
      this.relayUrlsCache = [...status.urls];
    } catch {
      // 快照不可得（SDK 异常）：保留缓存
    }
  }

  sessionCount(): number {
    return this.peers.size;
  }

  peerIds(): string[] {
    return [...this.peers.keys()];
  }

  keySessionIndex(): KeySessionIndex {
    return this.keyIndex;
  }

  /** 目录代次（观测 / 测试）。 */
  currentCatalogSeq(): number {
    return this.catalogSeq;
  }

  alias(): string {
    return this.opts.alias ?? this.storeRef.alias ?? "provider";
  }

  directory(): AuthDirectory {
    return authDirectoryFromStore(this.storeRef, {
      alias: this.alias(),
      relayUrls: this.relayUrlsCache,
    });
  }

  /** 服务变更/密钥撤销（CLI 写盘后由 watcher 触发）：重读存储并刷新在线会话。 */
  async reloadStore(): Promise<void> {
    // home 透传（复核 R2-P1-B）：watcher 重读后的 store 保持同一脚本库基准，
    // addService 的预设模式阶段导出校验不因重载退回真实 os.homedir()。
    const fresh = ProviderStore.open(
      this.dataDir,
      this.opts.home === undefined ? {} : { home: this.opts.home },
    ); // 失败抛出（保留旧存储，由调用方记录）
    if (fresh.revision === this.storeRef.revision) return;
    this.storeRef = fresh;
    this.limitsEnforcer.syncFromStore(fresh);
    await this.broadcastRefresh();
  }

  /** 全量刷新：视图变化唤醒 watch 长轮询（refresh 全量目录）；全钥失效断会话。 */
  async broadcastRefresh(): Promise<void> {
    for (const ps of [...this.peers.values()]) {
      await this.refreshSession(ps);
    }
  }

  private async refreshSession(ps: ProviderPeerServer): Promise<void> {
    if (!ps.authed()) return;
    const dir = this.directory();
    let anyAlive = false;
    for (const sessionId of [...ps.sessionAuthIds()]) {
      const sa = ps.sessionAuthOf(sessionId);
      if (sa === undefined) continue;
      const { valid } = evaluateKeyring(sa.keyring, dir);
      if (valid.length === 0) {
        // 该会话全钥失效：摘除其授权态（其它已 AUTH 会话不受影响）。
        ps.dropSessionAuth(sessionId);
        continue;
      }
      anyAlive = true;
      const header = buildAuthOk(valid, dir, { refresh: true });
      const json = JSON.stringify(header);
      if (json === sa.lastView) {
        sa.grants = valid;
        continue;
      }
      this.catalogSeq++;
      sa.grants = valid;
      sa.lastView = json;
      ps.notifyWatch(sessionId, header);
    }
    if (!anyAlive) {
      // 全会话失效：不拆 serve 引擎/内核会话注册表（RESUME 续传承载面保留）——
      // 失效授权 + 唤醒 watch 等待者（401）+ 断开传输：消费端续传成功后重新
      // AUTH 得 403 → key_all_invalid（key add 后重呈即恢复）。
      this.keyIndex.untrack(ps);
      ps.notifyWatchInvalidated();
      void this.fabric.disconnect(ps.peerId).catch(() => undefined);
      return;
    }
    this.keyIndex.track(ps); // 授权集变更后重登记（撤键裁剪后索引防过期；track 为替换语义）
  }

  private async addPeer(peerId: string): Promise<void> {
    if (this.stopped) return;
    // 已存在：serveHttp 引擎与鉴权缓存跨传输断线存续（内核 RESUME 续传），不重建。
    if (this.peers.has(peerId)) return;
    const peer = new ProviderPeerServer(this, peerId, this.fabric);
    this.peers.set(peerId, peer);
    try {
      await peer.start(this.serveHttpImpl);
    } catch (err) {
      // serveHttp 启动失败（对端不可达等）：摘除后由下一次 peer-connected 重试
      this.peers.delete(peerId);
      process.stderr.write(`warn: serveHttp start failed for peer: ${(err as Error).message}\n`);
    }
  }

  removePeer(peerId: string, reason: string): void {
    const ps = this.peers.get(peerId);
    if (ps === undefined) return;
    this.peers.delete(peerId);
    this.keyIndex.untrack(ps);
    void ps.disposeLocal(reason);
  }

  /** 用量记录（forward 回调；--logUsage 关闭时引擎侧不挂回调）。 */
  recordUsage(record: Parameters<UsageLog["append"]>[0]): void {
    this.usageLog?.append(record);
  }

  /** 幂等关闭：断开全部会话（fabric 本身由 serve 层 shutdown）。 */
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribeFabric?.();
    this.unsubscribeFabric = null;
    for (const peerId of [...this.peers.keys()]) {
      this.removePeer(peerId, "engine shutdown");
    }
  }

  /** 组内是否含该服务（授权判定）。 */
  groupHasService(groupName: string, serviceId: string): boolean {
    const group = this.storeRef.getGroup(groupName);
    return group !== undefined && group.serviceIds.includes(serviceId);
  }
}

// ---------------------------------------------------------------------------
// per-peer HTTP 服务（AUTH 端点 / 目录 watch / 上游转发）
// ---------------------------------------------------------------------------

/**
 * per-session 授权态（0.6.0 sdk-lifecycle-signals：授权按 session_id 隔离，
 * spec 3.2）。同 peer 异 session 不继承授权——新 session 必须自行 AUTH；
 * 同 session 断线恢复（内核 RESUME）sessionId 稳定，授权缓存自然延续。
 */
interface SessionAuth {
  /** 该会话最近一次 AUTH 呈交的钥环原文（仅内存；MUST NOT 进日志）。 */
  keyring: string[];
  grants: KeyGrant[];
  /** 该会话最近一次 AUTH_OK 视图（refresh 去重）。 */
  lastView: string;
}

class ProviderPeerServer implements AuthSessionBinding {
  readonly peerId: string;
  private readonly engine: ProviderEngine;
  private readonly fabric: Fabric;
  private server: CarrierServer | undefined;
  private disposed = false;
  private readonly active = new Map<number, ActiveForward>();
  private readonly acquired = new Map<number, { keyId: string; group: string }>();

  /**
   * session_id → 授权态（LRU；上限防泄漏——内核暂无「会话终结」通知，旧
   * session 条目由容量逐出。恢复轮 sessionId 稳定，逐出只发生在远超活跃
   * 会话数的场景）。
   */
  private readonly sessionAuths = new Map<string, SessionAuth>();
  /** watch 长轮询等待者（目录变更按各自 session 视图唤醒；失效 → 401）。 */
  private readonly watchWaiters = new Map<string, Set<(view: AuthOkHeader | "invalid" | null) => void>>();

  constructor(engine: ProviderEngine, peerId: string, fabric: Fabric) {
    this.engine = engine;
    this.peerId = peerId;
    this.fabric = fabric;
  }

  async start(serveHttpImpl: ServeHttpFn): Promise<void> {
    this.server = await serveHttpImpl(this.fabric, this.peerId, (req) => this.handle(req));
  }

  /** 任一会话持有有效授权（peer 级观测）。 */
  authed(): boolean {
    for (const sa of this.sessionAuths.values()) {
      if (sa.grants.length > 0) return true;
    }
    return false;
  }

  /** 该会话的授权态（无 → undefined：未 AUTH/已失效/被逐出）。访问即提升
   * LRU 位次（Map 重插——访问序逐出，非仅插入序）。 */
  sessionAuthOf(sessionId: string): SessionAuth | undefined {
    const sa = this.sessionAuths.get(sessionId);
    if (sa !== undefined) {
      this.sessionAuths.delete(sessionId);
      this.sessionAuths.set(sessionId, sa);
    }
    return sa;
  }

  /** 会话 id 快照（engine.refreshSession 迭代用）。 */
  sessionAuthIds(): string[] {
    return [...this.sessionAuths.keys()];
  }

  /** 摘除会话授权态（refresh 裁剪路径——全钥失效的会话；watch 随之唤醒 401）。 */
  dropSessionAuth(sessionId: string): void {
    this.sessionAuths.delete(sessionId);
    this.invalidateWatch(sessionId);
  }

  /** 写入该会话授权态（LRU 容量逐出最旧）。 */
  private putSessionAuth(sessionId: string, keyring: string[], grants: KeyGrant[]): void {
    this.sessionAuths.delete(sessionId);
    this.sessionAuths.set(sessionId, { keyring, grants, lastView: "" });
    while (this.sessionAuths.size > SESSION_AUTH_CAP) {
      const oldest = this.sessionAuths.keys().next().value;
      if (oldest === undefined) break;
      this.sessionAuths.delete(oldest);
      this.invalidateWatch(oldest); // 被逐出会话的在途 watch 即刻 401（5.2-P2）
    }
  }

  // AuthSessionBinding 实现（跨会话并集——撤键/定位语义仍按 peer 收口）
  get keys(): readonly string[] {
    const out = new Set<string>();
    for (const sa of this.sessionAuths.values()) for (const k of sa.keyring) out.add(k);
    return [...out];
  }

  get keyIds(): ReadonlySet<string> {
    const out = new Set<string>();
    for (const sa of this.sessionAuths.values()) for (const g of sa.grants) out.add(g.keyId);
    return out;
  }

  /** 撤键/目录变更后的刷新：唤醒 watch 长轮询（全量视图；refresh 语义不变）。 */
  async pushRefresh(header: AuthOkHeader): Promise<void> {
    this.notifyWatchAll(header);
  }

  disconnect(reason: string): void {
    void this.disposeLocal(reason);
  }

  /** 会话授权失效（drop/无效 AUTH/逐出）：唤醒该会话全部 watch 等待者以
   * 401 收敛（5.2-P2——此前删集合不唤醒，在途长轮询干等到 20s 超时）。 */
  private invalidateWatch(sessionId: string): void {
    const waiters = this.watchWaiters.get(sessionId);
    if (waiters === undefined) return;
    for (const wake of [...waiters]) wake("invalid");
    this.watchWaiters.delete(sessionId);
  }

  /** 唤醒指定会话的 watch 等待者（该会话自己的刷新视图）。 */
  notifyWatch(sessionId: string, view: AuthOkHeader): void {
    const waiters = this.watchWaiters.get(sessionId);
    if (waiters === undefined) return;
    for (const wake of [...waiters]) wake(view);
    this.watchWaiters.delete(sessionId);
  }

  /** 唤醒全部 watch 等待者（键重加等 peer 级推送：并集视图，各会话自行重同步）。 */
  notifyWatchAll(view: AuthOkHeader): void {
    for (const waiters of [...this.watchWaiters.values()]) {
      for (const wake of [...waiters]) wake(view);
    }
    this.watchWaiters.clear();
  }

  /** 授权失效：唤醒等待者以 401 收敛（watch 循环退出，由 active 转换重启）。 */
  notifyWatchInvalidated(): void {
    for (const waiters of [...this.watchWaiters.values()]) {
      for (const wake of [...waiters]) wake("invalid");
    }
    this.watchWaiters.clear();
  }

  /** 本地善后（撤钥/引擎关闭）：中止全部在途、释放限额、停 HTTP 引擎、断 fabric 会话。 */
  async disposeLocal(reason: string): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.acquired.keys()]) {
      this.settle(id);
    }
    for (const id of [...this.active.keys()]) {
      this.settle(id);
    }
    this.notifyWatch = () => undefined; // 已 disposed：等待者自然超时（204）
    try {
      await this.server?.close(reason);
    } catch {
      // 引擎已关：忽略
    }
    // fabric 级断开（全钥失效 / 撤销 / 优雅退出）：对未连接成员为安全 no-op。
    void this.fabric.disconnect(this.peerId).catch(() => undefined);
  }

  // -----------------------------------------------------------------------
  // handler 入口（AUTH / watch / forward 分流）
  // -----------------------------------------------------------------------

  private async handle(req: CarrierRequest): Promise<CarrierResponse | null> {
    // 已 disposed：回错误载体正常结算（SDK 结算面经 B6 加固后对 close 后
    // unknown-id 的晚到/拒绝结算幂等静默——永挂规避已无必要，且回避了 handler
    // 闭包与 server.close() 的无界等待）。
    if (this.disposed) {
      return errorCarrierResponse(ERROR_CODE.internal, "provider engine disposed");
    }
    const barePath = req.path.split("?", 1)[0]!;
    let result: CarrierResponse | null;
    if (barePath === AIFLY_AUTH_PATH && req.method === "POST") {
      result = await this.handleAuth(req);
    } else if (barePath === AIFLY_WATCH_PATH && req.method === "GET") {
      result = await this.handleWatch(req);
    } else if (barePath === AIFLY_AUTH_PATH || barePath === AIFLY_WATCH_PATH) {
      // 控制端点错误方法：本地 405，零上游触达（/_aifly/ 命名空间保留——错误
      // 方法不得落入 forward 变成对上游的请求）
      result = errorCarrierResponse(ERROR_CODE.forbidden_method, `method not allowed on control endpoint: ${req.method} ${barePath}`);
    } else if (barePath.startsWith("/_aifly/")) {
      // 保留命名空间内未知路径：本地 401（与未授权无差别，不暴露端点存在性）
      result = errorCarrierResponse(ERROR_CODE.unauthorized, "unauthorized");
    } else {
      result = await this.handleForward(req);
    }
    return result;
  }

  private jsonHeaders(extra: Record<string, string> = {}): Array<{ name: string; value: string }> {
    const out: Array<{ name: string; value: string }> = [{ name: "content-type", value: "application/json" }];
    for (const [name, value] of Object.entries(extra)) out.push({ name, value });
    return out;
  }

  /** AUTH（重复 AUTH 以最后一次为准：钥环变更 = 重授权；授权按 session_id 隔离）。 */
  private async handleAuth(req: CarrierRequest): Promise<CarrierResponse> {
    let parsedBody: unknown;
    try {
      const raw = await this.readBody(req);
      parsedBody = JSON.parse(raw.toString("utf8"));
    } catch {
      return errorCarrierResponse(ERROR_CODE.protocol_error, "auth body must be JSON");
    }
    const parsed = AUTH_HEADER_SCHEMA.safeParse(parsedBody);
    if (!parsed.success) {
      return errorCarrierResponse(ERROR_CODE.protocol_error, "auth body schema rejected");
    }
    const decision = handleAuthFrame(parsed.data as AuthHeader, this.engine.directory());
    if (decision.kind === "err") {
      // 全无效：403（会话不拆——消费端标记 key_all_invalid 等待 key add 后重新
      // 呈交；提供端失效**该 session** 此前的有效授权；其它已 AUTH 会话不受影响）。
      this.sessionAuths.delete(req.sessionId);
      this.invalidateWatch(req.sessionId); // 在途等待者即刻 401（不干等超时）
      if (!this.authed()) {
        this.engine.keySessionIndex().untrack(this);
      }
      return {
        status: 403,
        headers: this.jsonHeaders(),
        bodyChunks: [Buffer.from(JSON.stringify(decision.header))],
      };
    }
    this.putSessionAuth(req.sessionId, decision.keys, decision.valid);
    this.engine.keySessionIndex().track(this);
    return {
      status: 200,
      headers: this.jsonHeaders({ "x-aifly-catalog-seq": String(this.engine.currentCatalogSeq()) }),
      bodyChunks: [Buffer.from(JSON.stringify(decision.header))],
    };
  }

  /** 目录刷新长轮询：since 落后即时回；未变更挂起至视图变更（200）或超时（204）。 */
  private async handleWatch(req: CarrierRequest): Promise<CarrierResponse> {
    const sa = this.sessionAuthOf(req.sessionId);
    if (sa === undefined || sa.grants.length === 0) {
      return errorCarrierResponse(ERROR_CODE.unauthorized, "session is not authenticated");
    }
    const query = req.path.split("?", 2)[1] ?? "";
    const sinceRaw = Number(new URLSearchParams(query).get("since") ?? "0");
    const since = Number.isFinite(sinceRaw) && sinceRaw >= 0 ? Math.floor(sinceRaw) : 0;
    const current = this.engine.currentCatalogSeq();
    if (since < current) {
      const dir = this.engine.directory();
      const { valid } = evaluateKeyring(sa.keyring, dir);
      if (valid.length === 0) {
        return errorCarrierResponse(ERROR_CODE.unauthorized, "no valid key remains");
      }
      const header = buildAuthOk(valid, dir, { refresh: true });
      sa.grants = valid;
      return {
        status: 200,
        headers: this.jsonHeaders({ "x-aifly-catalog-seq": String(current) }),
        bodyChunks: [Buffer.from(JSON.stringify(header))],
      };
    }
    // 挂起等待视图变更（有界：内核 fetchHttp 响应头等待窗 30s 内）；授权失效
    // 以 "invalid" 唤醒 → 401（消费端 watch 循环退出，由下一次 active 重启）。
    const changed = await new Promise<AuthOkHeader | "invalid" | null>((resolve) => {
      const timer = setTimeout(() => {
        let waiters = this.watchWaiters.get(req.sessionId);
        waiters?.delete(wake);
        if (waiters !== undefined && waiters.size === 0) this.watchWaiters.delete(req.sessionId);
        resolve(null);
      }, CATALOG_WATCH_TIMEOUT_MS);
      const wake = (view: AuthOkHeader | "invalid" | null): void => {
        clearTimeout(timer);
        resolve(view);
      };
      let waiters = this.watchWaiters.get(req.sessionId);
      if (waiters === undefined) {
        waiters = new Set();
        this.watchWaiters.set(req.sessionId, waiters);
      }
      waiters.add(wake);
    });
    if (changed === "invalid") {
      return errorCarrierResponse(ERROR_CODE.unauthorized, "authorization invalidated");
    }
    // 唤醒后授权复查（5.2-P2）：等待期间会话可能已被撤销/逐出——迟到的
    // 全局推送（pushRefresh 并集视图）不得复活未授权会话的等待。
    if (changed !== null) {
      const saAfter = this.sessionAuthOf(req.sessionId);
      if (saAfter === undefined || saAfter.grants.length === 0) {
        return errorCarrierResponse(ERROR_CODE.unauthorized, "session is not authenticated");
      }
    }
    if (changed === null) {
      return { status: 204, headers: [{ name: "x-aifly-catalog-seq", value: String(current) }] };
    }
    return {
      status: 200,
      headers: this.jsonHeaders({ "x-aifly-catalog-seq": String(this.engine.currentCatalogSeq()) }),
      bodyChunks: [Buffer.from(JSON.stringify(changed))],
    };
  }

  // -----------------------------------------------------------------------
  // 上游转发（既有管线经 ResponseSink 载体）
  // -----------------------------------------------------------------------

  private async handleForward(req: CarrierRequest): Promise<CarrierResponse | null> {
    const sa = this.sessionAuthOf(req.sessionId);
    if (sa === undefined || sa.grants.length === 0) {
      return errorCarrierResponse(ERROR_CODE.unauthorized, "session is not authenticated");
    }
    // 预中止早期短路（5.2b-P1）：在限额占用/读体/probe 拨号**之前**——已
    // 取消的请求不得触达上游（probe 也建 TCP 连接）。
    if (req.signal.aborted) {
      return errorCarrierResponse(ERROR_CODE.aborted, "request cancelled before dispatch");
    }
    // serviceId 路由头（消费端注入；缺失/未知/未授权统一拒绝）
    const serviceHeader = req.headers.find((h) => h.name === AIFLY_SERVICE_HEADER)?.value;
    if (serviceHeader === undefined) {
      return errorCarrierResponse(ERROR_CODE.protocol_error, `missing ${AIFLY_SERVICE_HEADER} header`);
    }
    const method = req.method.toUpperCase();
    if (!(HTTP_METHODS as readonly string[]).includes(method)) {
      return errorCarrierResponse(ERROR_CODE.forbidden_method, `http method not allowed: ${method}`);
    }
    const service = this.engine.store.getService(serviceHeader);
    const grant =
      service === undefined
        ? undefined
        : sa.grants.find((g) => this.engine.groupHasService(g.group, serviceHeader));
    // 未授权/未知/停用统一 unknown_service（防枚举；service-lifecycle）。
    if (service === undefined || service.enabled === false || grant === undefined) {
      return errorCarrierResponse(ERROR_CODE.unknown_service, "service not available");
    }
    // 限额在拨号前（请求接受即占用并发/日限）。
    const acquired = this.engine.limits.acquire(grant.keyId, grant.group);
    if (!acquired.ok) {
      return errorCarrierResponse(
        acquired.code,
        acquired.code === "rate_limited" ? "group concurrency limit reached" : "daily request quota reached",
      );
    }
    this.acquired.set(req.requestId, { keyId: grant.keyId, group: grant.group });

    // headers：控制头剥离 + 小写化 last-wins（进既有 rewrite 头链）
    const headers: Record<string, string> = {};
    let contentType: string | undefined;
    for (const h of req.headers) {
      const name = h.name.toLowerCase();
      if (AIFLY_CONTROL_HEADERS.has(name)) continue;
      if (name === "content-type") {
        contentType = h.value;
        continue;
      }
      headers[name] = h.value;
    }
    const isWs = isWebSocketUpgradeRequest(headers);

    // 请求体重组（8MiB 上限；pull-first bodyNext）。WS（keepOpen）请求体即隧道
    // 上行方向——不半关，读至 EOF 会永挂：跳过重组（升级请求恒无正文），隧道
    // 字节由下方上行泵消费。
    let body: Uint8Array = new Uint8Array(0);
    if (!isWs) {
      try {
        body = await this.readBody(req);
      } catch (err) {
        this.settle(req.requestId);
        const code = err instanceof BodyTooLargeError ? ERROR_CODE.body_too_large : ERROR_CODE.protocol_error;
        return errorCarrierResponse(code, err instanceof Error ? err.message : "request body read failed");
      }
    }
    const reqHeader: ReqHeader = {
      v: 1,
      id: String(req.requestId),
      serviceId: serviceHeader,
      method: method as ReqHeader["method"],
      path: req.path,
      headers,
      ...(contentType !== undefined ? { contentType } : {}),
      bodyLen: body.length,
    };

    const outcome = new CarrierOutcome((status, headers) => req.respondStreaming(status, headers));
    const ctrl = new AbortController();
    // 对端取消（SDK 0.6.0 signal：RESET/会话终态遗弃 → 事件驱动 abort）——
    // 挂起等上游的慢任务不再依赖「下一次 write 报错」间接感知，秒停直达
    // 上游拨号（forwardRequest 的 signal 链）。reply 必须为 true：经
    // finishWithError 结算 sink/error（outcome.done 收口——reply:false 的本地
    // 清理路径不回帧，会让 handler 悬挂在 done 上）。真实内核下对端已不可
    // 达，回帧写失败为静默 no-op。正常完成不触发。
    const abortUpstream = (): void => {
      ctrl.abort(new UpstreamAbortError(ERROR_CODE.aborted, true));
    };
    req.signal.addEventListener("abort", abortUpstream, { once: true });
    // 5.2-P1：预中止检查——已 aborted 的 signal 不再触发监听（SDK 在 handler
    // 微任务执行前取消时，仅注册监听会漏发），同步补发。
    if (req.signal.aborted) abortUpstream();
    const act: ActiveForward = { ctrl, keyId: grant.keyId, group: grant.group, ws: undefined };
    this.active.set(req.requestId, act);

    // WS：隧道上行泵（keepOpen 请求体不半关——客户端帧持续经 bodyNext 到达；
    // 载体终结后停泵——不 await 泵体，避免隧道尾字节阻塞响应 resolve）。
    if (isWs) {
      void (async () => {
        try {
          for (;;) {
            const next = req.bodyNext();
            const winner = await Promise.race([
              next.then((c) => (c === null ? ("eof" as const) : ({ chunk: c } as const))),
              outcome.done.then(() => "settled" as const),
            ]);
            if (winner === "eof" || winner === "settled") break;
            act.ws?.pushUp(new Uint8Array(winner.chunk));
          }
        } catch {
          // 会话终态/流取消：中止上游（静默——客户端已不可达）
          ctrl.abort(new UpstreamAbortError(ERROR_CODE.aborted, false));
        }
      })();
    }

    try {
      await forwardRequest({
        sink: outcome.sink(),
        id: reqHeader.id,
        service,
        req: reqHeader,
        body,
        signal: ctrl.signal,
        keyId: grant.keyId,
        timeouts: this.engine.opts.timeouts,
        onUsage: this.engine.opts.logUsage === true ? (r) => this.engine.recordUsage(r) : undefined,
        env: this.engine.opts.env,
        secrets: this.engine.opts.secrets,
        home: this.engine.opts.home,
        onWsRelay: (relay) => {
          act.ws = relay;
        },
      });
      await outcome.done;
    } catch (err) {
      // 兜底：转发意外抛出（正常路径经 sink error 终结）。脚本失败类先于 internal。
      const code =
        err instanceof HookStageError
          ? ERROR_CODE.hook_failed
          : err instanceof HookMissingError
            ? ERROR_CODE.secret_missing
            : ERROR_CODE.internal;
      const message =
        err instanceof HookStageError || err instanceof HookMissingError ? err.message : "internal forward failure";
      outcome.fail({ id: reqHeader.id, code, message });
    } finally {
      this.settle(req.requestId);
    }
    return outcome.carrier();
  }

  /** 请求体读至 EOF（8MiB 上限；超限/读失败抛错）。 */
  private async readBody(req: CarrierRequest): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const c = await req.bodyNext();
      if (c === null) break;
      total += c.length;
      if (total > REQUEST_BODY_LIMIT_BYTES) throw new BodyTooLargeError();
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  /** id 终结清理（幂等）：释放限额占用、中止上游（含 WS 关闭）、清表。 */
  private settle(id: number): void {
    const acquired = this.acquired.get(id);
    if (acquired !== undefined) {
      this.engine.limits.release(acquired.group);
      this.acquired.delete(id);
    }
    const act = this.active.get(id);
    if (act !== undefined) {
      this.active.delete(id);
      // 正常终结后为 no-op；异常路径确保上游连接中止（WS relay 随信号 teardown）。
      act.ctrl.abort(new UpstreamAbortError(ERROR_CODE.internal, false));
    }
  }
}

class BodyTooLargeError extends Error {
  constructor() {
    super(`request body exceeds ${REQUEST_BODY_LIMIT_BYTES} bytes`);
    this.name = "BodyTooLargeError";
  }
}

// ---------------------------------------------------------------------------
// 载体收尾（ResponseSink 聚齐为静态 chunks 响应）
// ---------------------------------------------------------------------------

/**
 * 单请求载体结果（流式形态，B1/B2）：meta 到达即经 respondStreaming 下发
 * 响应头（SSE 首包/WS 101 早发），chunk/wsData 逐块 write（内核背压传导）；
 * WS 关闭码走带内尾块。done 在终结（end/error/wsClose）时 resolve。
 * 头未发出即终结（错误/兜底）→ carrier() 供静态结算路径。
 */
class CarrierOutcome {
  private settled = false;
  private headSent = false;
  private writer: StreamWriterHandle | null = null;
  private meta: RespMetaHeader | undefined;
  private err: ErrorHeader | undefined;
  readonly done: Promise<void>;
  private resolveDone: (() => void) | undefined;
  private readonly stream: (
    status: number,
    headers: Array<{ name: string; value: string }>,
  ) => StreamWriterHandle | null;

  constructor(
    stream: (status: number, headers: Array<{ name: string; value: string }>) => StreamWriterHandle | null,
  ) {
    this.stream = stream;
    this.done = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  sink(): ResponseSink {
    return {
      meta: (h) => {
        if (this.settled) return;
        this.meta = h;
        const headers: Array<{ name: string; value: string }> = [
          { name: "content-type", value: h.contentType === "" ? "application/octet-stream" : h.contentType },
        ];
        for (const [name, value] of Object.entries(h.headers ?? {})) {
          headers.push({ name, value });
        }
        this.writer = this.stream(h.status, headers);
        this.headSent = this.writer !== null;
      },
      chunk: (b) => {
        if (this.settled || this.writer === null) return;
        return this.writer.write(b);
      },
      end: () => {
        if (this.settled) return;
        this.settled = true;
        this.writer?.finish();
        this.resolveDone?.();
      },
      error: (h) => {
        if (this.settled) return;
        this.settled = true;
        // 已发头：流式面无错误投影通道——半关终结（观感 = 上游中断）。
        this.writer?.finish();
        if (!this.headSent) this.err = h;
        this.resolveDone?.();
      },
      wsData: (b) => {
        if (this.settled || this.writer === null) return;
        return this.writer.write(b);
      },
      wsClose: (code) => {
        if (this.settled) return;
        this.settled = true;
        const writer = this.writer;
        if (writer === null) {
          this.resolveDone?.();
          return;
        }
        // 关闭码走带内尾块（消费端一 chunk 前瞻解释）；尾块送达后半关。
        void writer
          .write(encodeWsCloseTrailer(code))
          .catch(() => undefined)
          .finally(() => {
            writer.finish();
            this.resolveDone?.();
          });
      },
    };
  }

  /** 兜底失败（forwardRequest 抛出时）。 */
  fail(header: ErrorHeader): void {
    if (this.settled) return;
    this.settled = true;
    this.writer?.finish();
    if (!this.headSent) this.err = header;
    this.resolveDone?.();
  }

  /** 头已发出（流式已结算）——handle 返回 null 让 SDK 胶水跳过静态兜底。 */
  get streamed(): boolean {
    return this.headSent;
  }

  /** 静态载体（仅头未发出路径：错误/兜底；流式路径的分块不在此聚合）。 */
  carrier(): CarrierResponse | null {
    if (this.streamed) return null;
    if (this.err !== undefined) {
      return errorCarrierResponse(this.err.code, this.err.message);
    }
    const status = this.meta?.status ?? 200;
    return {
      status,
      headers: [
        { name: "content-type", value: this.meta?.contentType === "" || this.meta?.contentType === undefined ? "application/octet-stream" : this.meta.contentType },
      ],
      bodyChunks: [],
    };
  }
}
