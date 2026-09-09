// 提供方引擎装配：Fabric 事件 -> per-peer WireSession（provider 角色）-> AUTH 门控/
// REQ 重组与派发/限额接线/目录刷新推送/撤钥处置。serve.ts 负责 Fabric 打开与横幅，
// 本文件只做会话与转发逻辑（Fabric 经接口注入，测试可用内存假体，无需原生 SDK）。
// 正交意图（本文件不实现）：
// - 帧编解码/方向/schema/seq 校验（wire 层；引擎只消费合法入站帧）；
// - 上游转发细节（upstream.ts / ws-upstream.ts；引擎持有 AbortController 做中止）；
// - 存储变更的发现（serve.ts watcher 调 reloadStore；CLI 与 daemon 是不同进程）。

import type { Fabric } from "@jixo/opendweb-client-sdk";
import { FabricWireAdapter } from "../wire/fabric-adapter.ts";
import { WireSession } from "../wire/mux.ts";
import type { InboundFrame } from "../wire/mux.ts";
import { ERROR_CODE, FRAME_TYPE } from "../wire/frames.ts";
import type {
  AbortHeader,
  AuthHeader,
  AuthOkHeader,
  CloseHeader,
  DataHeader,
  ReqBodyHeader,
  ReqHeader,
} from "../wire/frames.ts";
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
import { forwardRequest, UpstreamAbortError, type UpstreamTimeouts } from "./upstream.ts";
import type { WsRelayHandle } from "./ws-upstream.ts";
import type { EnvSource } from "./rewrite.ts";

export interface ProviderEngineOptions {
  alias?: string | undefined;
  logUsage?: boolean | undefined;
  timeouts?: Partial<UpstreamTimeouts> | undefined;
  /** $env 解析源（默认 process.env；测试注入）。 */
  env?: EnvSource | undefined;
}

interface ActiveForward {
  ctrl: AbortController;
  keyId: string;
  group: string;
  ws: WsRelayHandle | undefined;
}

interface IncomingRequest {
  req: ReqHeader;
  parts: Uint8Array[];
  keyId: string;
  group: string;
}

export class ProviderEngine {
  private readonly fabric: Fabric;
  private readonly dataDir: string;
  private readonly limitsEnforcer: LimitEnforcer;
  private readonly usageLog: UsageLog | undefined;
  readonly opts: ProviderEngineOptions;
  private storeRef: ProviderStore;
  private readonly peers = new Map<string, ProviderPeerSession>();
  private readonly keyIndex = new KeySessionIndex();
  private relayUrlsCache: string[] = [];
  private unsubscribeFabric: (() => void) | null = null;
  private stopped = false;

  constructor(deps: {
    fabric: Fabric;
    store: ProviderStore;
    dataDir: string;
    limits?: LimitEnforcer | undefined;
    opts?: ProviderEngineOptions | undefined;
  }) {
    this.fabric = deps.fabric;
    this.storeRef = deps.store;
    this.dataDir = deps.dataDir;
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
        this.addPeer(event.endpointId);
      } else if (event.type === "peer-disconnected") {
        this.removePeer(event.endpointId, "peer-disconnected");
      } else if (event.type === "relay-online" || event.type === "relay-offline") {
        // relayUrls 随目录刷新同步：入口变化推 refresh AUTH_OK。
        void this.refreshRelayUrls().then(() => this.broadcastRefresh());
      }
    });
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
    const fresh = ProviderStore.open(this.dataDir); // 失败抛出（保留旧存储，由调用方记录）
    if (fresh.revision === this.storeRef.revision) return;
    this.storeRef = fresh;
    this.limitsEnforcer.syncFromStore(fresh);
    await this.broadcastRefresh();
  }

  /** 全量刷新：视图变化推送 refresh AUTH_OK；全钥失效断会话。 */
  async broadcastRefresh(): Promise<void> {
    for (const ps of [...this.peers.values()]) {
      await this.refreshSession(ps);
    }
  }

  private async refreshSession(ps: ProviderPeerSession): Promise<void> {
    if (!ps.session.authed) return;
    const dir = this.directory();
    const { valid } = evaluateKeyring(ps.keyring, dir);
    if (valid.length === 0) {
      this.removePeer(ps.peerId, "all keys invalid");
      return;
    }
    const header = buildAuthOk(valid, dir, { refresh: true });
    const json = JSON.stringify(header);
    if (json === ps.lastView) return;
    await ps.pushRefresh(header);
    ps.grants = valid;
  }

  private addPeer(peerId: string): void {
    if (this.stopped) return;
    if (this.peers.has(peerId)) this.removePeer(peerId, "replaced");
    this.peers.set(
      peerId,
      new ProviderPeerSession(this, peerId, this.fabric, (reason) => this.removePeer(peerId, reason)),
    );
  }

  private removePeer(peerId: string, reason: string): void {
    const ps = this.peers.get(peerId);
    if (ps === undefined) return;
    this.peers.delete(peerId);
    this.keyIndex.untrack(ps);
    ps.disposeLocal(reason);
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
// per-peer 会话（AUTH / REQ 重组 / 限额 / 中止接线）
// ---------------------------------------------------------------------------

class ProviderPeerSession implements AuthSessionBinding {
  readonly peerId: string;
  readonly session: WireSession;
  readonly adapter: FabricWireAdapter;
  private readonly engine: ProviderEngine;
  private readonly fabric: Fabric;
  private readonly removeSelf: (reason: string) => void;

  /** 最近一次 AUTH 呈交的钥环原文（仅内存；撤钥后重算用；MUST NOT 进日志）。 */
  keyring: string[] = [];
  grants: KeyGrant[] = [];
  lastView = "";

  private readonly incoming = new Map<string, IncomingRequest>();
  private readonly active = new Map<string, ActiveForward>();
  private readonly acquired = new Map<string, { keyId: string; group: string }>();
  private disposed = false;

  constructor(
    engine: ProviderEngine,
    peerId: string,
    fabric: Fabric,
    removeSelf: (reason: string) => void,
  ) {
    this.engine = engine;
    this.peerId = peerId;
    this.fabric = fabric;
    this.removeSelf = removeSelf;
    this.adapter = new FabricWireAdapter(fabric, peerId);
    this.session = new WireSession({
      role: "provider",
      transport: this.adapter,
      hooks: {
        onFrame: (frame) => this.handleFrame(frame),
        // 毒化即重建（对端负责重连）：关闭会话即可。
        onPoison: () => this.removeSelf("protocol-seq poisoned"),
        onIdleTimeout: (id) => this.handleIdleTimeout(id),
        onDisconnect: () => this.removeSelf("transport closed"),
        onTerminate: (id) => this.settle(id),
      },
    });
  }

  // AuthSessionBinding 实现
  get keys(): readonly string[] {
    return this.keyring;
  }

  get keyIds(): ReadonlySet<string> {
    return new Set(this.grants.map((g) => g.keyId));
  }

  async pushRefresh(header: AuthOkHeader): Promise<void> {
    try {
      await this.session.send(FRAME_TYPE.AUTH_OK, header);
      this.lastView = JSON.stringify(header);
    } catch {
      // 发送失败：断连路径会清理
    }
  }

  disconnect(reason: string): void {
    this.session.dispose(reason);
  }

  // -----------------------------------------------------------------------
  // 入站分发（mux 已完成门控/方向/schema/id/seq 校验）
  // -----------------------------------------------------------------------

  private handleFrame(frame: InboundFrame): void {
    switch (frame.type) {
      case FRAME_TYPE.AUTH:
        void this.handleAuth(frame.header as AuthHeader);
        return;
      case FRAME_TYPE.REQ:
        this.handleReq(frame.header as ReqHeader, frame.body);
        return;
      case FRAME_TYPE.REQ_BODY:
        this.handleReqBody(frame.header as ReqBodyHeader, frame.body);
        return;
      case FRAME_TYPE.ABORT:
        this.handleAbort(frame.header as AbortHeader);
        return;
      case FRAME_TYPE.DATA_UP:
        this.active.get((frame.header as DataHeader).id)?.ws?.pushUp(frame.body);
        return;
      case FRAME_TYPE.CLOSE:
        this.handleClose(frame.header as CloseHeader);
        return;
      default:
        return; // 其余帧方向上不可达（mux 已挡）
    }
  }

  /** AUTH（重复 AUTH 以最后一次为准：钥环变更 = 重授权）。 */
  private async handleAuth(header: AuthHeader): Promise<void> {
    if (this.disposed) return;
    const decision = handleAuthFrame(header, this.engine.directory());
    if (decision.kind === "err") {
      // 全无效：单次即断（AUTH_ERR 后关传输）。
      try {
        await this.session.send(FRAME_TYPE.AUTH_ERR, decision.header);
      } catch {
        // 连接已坏
      }
      this.disconnect("auth failed: all keys invalid");
      return;
    }
    this.keyring = decision.keys;
    this.grants = decision.valid;
    this.session.markAuthed(); // 先置位再发 AUTH_OK，避免在途 REQ 被当未授权丢弃
    try {
      await this.session.send(FRAME_TYPE.AUTH_OK, decision.header);
      this.lastView = JSON.stringify(decision.header);
      this.engine.keySessionIndex().track(this);
    } catch {
      // 发送失败：断连路径清理
    }
  }

  private handleReq(header: ReqHeader, body: Uint8Array): void {
    if (this.grants.length === 0) return; // 未授权（mux 门控兜底）
    const service = this.engine.store.getService(header.serviceId);
    const grant =
      service === undefined
        ? undefined
        : this.grants.find((g) => this.engine.groupHasService(g.group, header.serviceId));
    // 未授权/未知统一 unknown_service（防枚举）。
    if (service === undefined || grant === undefined) {
      this.sendError(header.id, ERROR_CODE.unknown_service, "service not available");
      return;
    }
    // 限额在拨号前（REQ 接受即占用并发/日限）。
    const acquired = this.engine.limits.acquire(grant.keyId, grant.group);
    if (!acquired.ok) {
      this.sendError(header.id, acquired.code, acquired.code === "rate_limited" ? "group concurrency limit reached" : "daily request quota reached");
      return;
    }
    this.acquired.set(header.id, { keyId: grant.keyId, group: grant.group });
    if (header.bodyLen === body.length) {
      this.dispatch(header, body, grant.keyId, grant.group, service);
      return;
    }
    if (header.bodyLen < body.length) {
      this.sendError(header.id, ERROR_CODE.protocol_error, "request body length mismatch");
      return;
    }
    this.incoming.set(header.id, { req: header, parts: [body], keyId: grant.keyId, group: grant.group });
  }

  private handleReqBody(header: ReqBodyHeader, body: Uint8Array): void {
    const inc = this.incoming.get(header.id);
    if (inc === undefined) return;
    inc.parts.push(body);
    const total = inc.parts.reduce((n, p) => n + p.length, 0);
    if (total > inc.req.bodyLen) {
      this.sendError(header.id, ERROR_CODE.protocol_error, "request body length mismatch");
      return;
    }
    if (!header.end) return;
    if (total !== inc.req.bodyLen) {
      this.sendError(header.id, ERROR_CODE.protocol_error, "request body length mismatch");
      return;
    }
    const merged = concatBytes(inc.parts);
    const { req, keyId, group } = inc;
    const service = this.engine.store.getService(req.serviceId);
    this.incoming.delete(header.id);
    if (service === undefined) {
      this.sendError(header.id, ERROR_CODE.unknown_service, "service not available");
      return;
    }
    this.dispatch(req, merged, keyId, group, service);
  }

  private dispatch(
    req: ReqHeader,
    body: Uint8Array,
    keyId: string,
    group: string,
    service: ServiceConfig,
  ): void {
    const ctrl = new AbortController();
    const act: ActiveForward = { ctrl, keyId, group, ws: undefined };
    this.active.set(req.id, act);
    void forwardRequest({
      session: this.session,
      id: req.id,
      service,
      req,
      body,
      signal: ctrl.signal,
      keyId,
      timeouts: this.engine.opts.timeouts,
      onUsage: this.engine.opts.logUsage === true ? (r) => this.engine.recordUsage(r) : undefined,
      env: this.engine.opts.env,
      onWsRelay: (relay) => {
        act.ws = relay;
      },
    }).catch(async () => {
      // 兜底：转发意外抛出时终结该 id（正常路径由 onTerminate 清理）。
      if (this.active.has(req.id)) {
        this.sendError(req.id, ERROR_CODE.internal, "internal forward failure");
      }
    });
  }

  private handleAbort(header: AbortHeader): void {
    const act = this.active.get(header.id);
    if (act !== undefined) {
      // 上游中止 + ERROR(aborted) 回送由转发层完成。
      act.ctrl.abort(new UpstreamAbortError(ERROR_CODE.aborted, true));
      return;
    }
    if (this.incoming.has(header.id)) {
      this.sendError(header.id, ERROR_CODE.aborted, "request aborted by consumer");
    }
  }

  private handleClose(_header: CloseHeader): void {
    // CLOSE 为 WS 终结帧（双向）：mux 在交付前已 finishId -> onTerminate -> settle
    // （中止上游/关闭 WS、释放限额），此处无需再动作。
    return;
  }

  private handleIdleTimeout(id: string): void {
    const act = this.active.get(id);
    if (act !== undefined) {
      act.ctrl.abort(new UpstreamAbortError(ERROR_CODE.idle_timeout, true));
      return;
    }
    if (this.incoming.has(id)) {
      this.sendError(id, ERROR_CODE.idle_timeout, "request idle timeout");
    }
  }

  /** id 终结清理（幂等）：释放限额占用、中止上游（含 WS 关闭）、清表。 */
  private settle(id: string): void {
    const acquired = this.acquired.get(id);
    if (acquired !== undefined) {
      this.engine.limits.release(acquired.group);
      this.acquired.delete(id);
    }
    this.incoming.delete(id);
    const act = this.active.get(id);
    if (act !== undefined) {
      this.active.delete(id);
      // 正常终结后为 no-op；异常路径确保上游连接中止（WS relay 随信号 teardown）。
      act.ctrl.abort(new UpstreamAbortError(ERROR_CODE.internal, false));
    }
  }

  private sendError(id: string, code: (typeof ERROR_CODE)[keyof typeof ERROR_CODE], message: string): void {
    void this.session
      .send(FRAME_TYPE.ERROR, { id, code, message })
      .catch(() => undefined);
  }

  /** 本地善后（断连/毒化/引擎关闭）：中止全部在途、释放限额、断开 fabric 会话。 */
  disposeLocal(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.active.keys()]) {
      this.settle(id);
    }
    for (const id of [...this.acquired.keys()]) {
      this.settle(id);
    }
    this.adapter.dispose();
    this.session.dispose(reason);
    // fabric 级断开（AUTH_ERR 即断 / 毒化重建 / 优雅退出）：adapter.close 只触本地
    // onClose，对端感知依赖 fabric 会话断开（对未连接成员为安全 no-op）。
    void this.fabric.disconnect(this.peerId).catch(() => undefined);
  }
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
