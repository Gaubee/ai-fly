// aifly1 帧多路复用会话（角色中立、传输无关）：request-id 生命周期（不复用）、
// 同 id 出站保序与本地队列上限（64 帧）、入站解复用（AUTH 门控 → 方向 → schema →
// id 路由 → seq 连续性）、重组上限（8MiB）、per-id 空闲计时（含提供方首字节等待期
// 豁免）、毒化标记（protocol_seq → onPoison，由上层重建连接）、终结语义与断连全量
// 终结。
// 正交意图（本文件不实现）：
// - AUTH 密钥校验与目录语义（§3 auth.ts / §4 providers.ts；本层只做门控与帧交付，
//   markAuthed() 由上层在 AUTH_OK 交换完成后调用）；
// - 业务转发（上游请求 / 重写 / 限额 / 本地端口 —— §3/§4）；
// - 传输层 envelope 收发（WireTransport 注入；Fabric 适配在引擎层，测试用内存
//   loopback 成对传输）。
// 检查顺序（spec「帧方向与未知标识符」）：未 AUTH 门控先于方向检查；方向先于 schema；
// schema 先于 id 路由；id 先于 seq。

import { encodeFrame, type DecodedFrame } from "./codec.ts";
import {
  classifySchemaFailure,
  ERROR_CODE,
  FRAME_HEADER_SCHEMAS,
  FRAME_TYPE,
  FRAME_TYPE_NAME,
  SERVICE_DETAIL_SCHEMA,
  type AuthErrHeader,
  type AuthHeader,
  type AuthOkHeader,
  type ErrorCodeValue,
  type AbortHeader,
  type CloseHeader,
  type DataHeader,
  type ErrorHeader,
  type FrameTypeValue,
  type PingHeader,
  type ReqBodyHeader,
  type ReqHeader,
  type RespChunkHeader,
  type RespEndHeader,
  type RespMetaHeader,
} from "./frames.ts";
import { randomZ32 } from "./z32.ts";

export type { DecodedFrame } from "./codec.ts";

export type WireRole = "provider" | "consumer";

/** request-id 随机字节数（16B → z32 26 字符，spec「请求多路复用」）。 */
export const REQUEST_ID_BYTES = 16;

export const DEFAULT_IDLE_TIMEOUT_MS = 300_000; // 请求级空闲（双端各自执行）
export const DEFAULT_MAX_QUEUED_PER_ID = 64; // 同 id 在途未终结分片队列上限
export const DEFAULT_REASSEMBLY_LIMIT_BYTES = 8 * 1024 * 1024; // 重组总上限
export const DEFAULT_UNAUTH_FRAME_LIMIT = 32; // 未 AUTH 帧丢弃计数断连阈值

const NO_BODY = new Uint8Array(0);

/**
 * 传输抽象（Fabric.send 的对偶）：send 为底层 envelope 发送；onFrame 交付 decodeFrame
 * 的结果（含 unknown-version / unknown-type / malformed 标记——非 aifly 家族在适配层
 * 静默丢弃）；close 触发双端 disconnected（onClose）。
 */
export interface WireTransport {
  send(data: Uint8Array): Promise<void>;
  onFrame(cb: (frame: DecodedFrame) => void): void;
  close(reason?: string): void;
  onClose(cb: (reason?: string) => void): void;
}

/** 校验通过的入站业务帧（schema 已过、门控/方向/id/seq 检查已过）。 */
export type InboundFrame =
  | { type: typeof FRAME_TYPE.AUTH; header: AuthHeader }
  | {
      type: typeof FRAME_TYPE.AUTH_OK;
      header: AuthOkHeader;
      /**
       * 二阶段目录投影失败原因（hooks-lifecycle v2）：载荷内 detail 不合
       * SERVICE_DETAIL_SCHEMA 时由 mux 标注——帧本身已通过帧级 schema 并照常
       * 交付（上层仍应完成 AUTH 记账，会话保持 authed），但目录视图不得应用；
       * 触发 onCatalogError，不走普通帧丢弃路径。
       */
      catalogError?: string;
    }
  | { type: typeof FRAME_TYPE.AUTH_ERR; header: AuthErrHeader }
  | { type: typeof FRAME_TYPE.REQ; header: ReqHeader; body: Uint8Array }
  | { type: typeof FRAME_TYPE.REQ_BODY; header: ReqBodyHeader; body: Uint8Array }
  | { type: typeof FRAME_TYPE.RESP_META; header: RespMetaHeader }
  | { type: typeof FRAME_TYPE.RESP_CHUNK; header: RespChunkHeader; body: Uint8Array }
  | { type: typeof FRAME_TYPE.RESP_END; header: RespEndHeader }
  | { type: typeof FRAME_TYPE.ERROR; header: ErrorHeader }
  | { type: typeof FRAME_TYPE.ABORT; header: AbortHeader }
  | { type: typeof FRAME_TYPE.PING; header: PingHeader }
  | { type: typeof FRAME_TYPE.DATA_UP; header: DataHeader; body: Uint8Array }
  | { type: typeof FRAME_TYPE.DATA_DOWN; header: DataHeader; body: Uint8Array }
  | { type: typeof FRAME_TYPE.CLOSE; header: CloseHeader };

/** 终结原因（onTerminate 载荷）。 */
export type TerminateCause =
  | { source: "peer"; frameType: number } // 收到对端终结帧（RESP_END / ERROR / CLOSE）
  | { source: "local" } // 本地显式终结 / 发送终结帧 / 协议违规回敬
  | { source: "protocol-seq" } // 分片序号缺断（毒化）
  | { source: "body-too-large" } // 重组超限
  | { source: "disconnected"; reason?: string }; // 对端断开 / 传输关闭

export interface WireSessionHooks {
  /** 合法入站帧交付（含 AUTH 族、PING、ABORT 等控制帧；由上层决定业务动作）。 */
  onFrame?(frame: InboundFrame): void;
  /**
   * 目录同步失败（hooks-lifecycle v2 二阶段）：AUTH_OK 载荷内 detail 投影不合
   * 当前 SERVICE_DETAIL_SCHEMA（典型为提供者运行旧版本——同版本约束）。帧已
   * 通过帧级 schema 并交付（catalogError 标注），会话保持 authed，不触发普通
   * 帧丢弃路径；上层保留旧视图、记录本地错误态。
   */
  onCatalogError?(providerId: string, message: string): void;
  /** 连接毒化（seq 缺断 → 流已不可信）：上层负责终结请求并重建连接。 */
  onPoison?(info: { id: string; reason: "protocol_seq" }): void;
  /** 请求级空闲超时：上层终结清理（提供方回送 ERROR(idle_timeout)、使用方本地动作）。
   * 本层不自动登记终结，清理由上层 terminal()/send 终结帧完成。 */
  onIdleTimeout?(id: string): void;
  /** 未 AUTH 帧丢弃计数超过阈值（默认 32）即将断连。 */
  onUnauthViolation?(dropped: number): void;
  /** 传输关闭（对端断开 / 本地 close）。 */
  onDisconnect?(reason?: string): void;
  /** 某 id 终结（每 id 至多一次；断连时对全部在途 id 触发）。 */
  onTerminate?(id: string, cause: TerminateCause): void;
}

export interface WireSessionOptions {
  role: WireRole;
  transport: WireTransport;
  /**
   * 对端 endpointId（consumer 角色下即提供者身份；onCatalogError 的 providerId
   * 取自该值——目录同步失败按提供者呈现，未配置时为空串）。
   */
  peerEndpointId?: string;
  idleTimeoutMs?: number;
  maxQueuedPerId?: number;
  reassemblyLimitBytes?: number;
  unauthFrameLimit?: number;
  hooks?: WireSessionHooks;
}

export interface WireSessionStats {
  unauthDropped: number;
  directionDropped: number;
  schemaDropped: number;
  /** AUTH_OK 二阶段目录投影失败计数（不占 schemaDropped——跨版本目录安全拒绝）。 */
  catalogDropped: number;
  unknownIdDropped: number;
  terminalDropped: number;
  malformedDropped: number;
  unknownTypeIgnored: number;
  unknownVersionDropped: number;
  poisonedDropped: number;
  authed: boolean;
  poisoned: boolean;
  dead: boolean;
}

/** 本地误用（出站方向违规 / 未知类型 / 已关闭后发送）。 */
export class WireSessionError extends Error {
  readonly code: "closed" | "misuse";
  constructor(code: WireSessionError["code"], message: string) {
    super(message);
    this.name = "WireSessionError";
    this.code = code;
  }
}

type FrameDirection = "c2p" | "p2c" | "both";
type SeqStream = "reqBody" | "respChunk" | "dataUp" | "dataDown";

interface FrameMetaEntry {
  dir: FrameDirection;
  /** RESP_END / ERROR / CLOSE：发送或接收后该 id 终结。 */
  terminal?: boolean;
  /** 入站 seq 连续性跟踪的流键。 */
  seqStream?: SeqStream;
}

/** 帧方向表（spec：ERROR 仅提供方发出；CLOSE 双向；使用方侧终结均为本地动作）。 */
const FRAME_META: Readonly<Record<number, FrameMetaEntry | undefined>> = {
  [FRAME_TYPE.AUTH]: { dir: "c2p" },
  [FRAME_TYPE.AUTH_OK]: { dir: "p2c" },
  [FRAME_TYPE.AUTH_ERR]: { dir: "p2c" },
  [FRAME_TYPE.REQ]: { dir: "c2p" },
  [FRAME_TYPE.REQ_BODY]: { dir: "c2p", seqStream: "reqBody" },
  [FRAME_TYPE.RESP_META]: { dir: "p2c" },
  [FRAME_TYPE.RESP_CHUNK]: { dir: "p2c", seqStream: "respChunk" },
  [FRAME_TYPE.RESP_END]: { dir: "p2c", terminal: true },
  [FRAME_TYPE.ERROR]: { dir: "p2c", terminal: true },
  [FRAME_TYPE.ABORT]: { dir: "c2p" },
  [FRAME_TYPE.PING]: { dir: "p2c" },
  [FRAME_TYPE.DATA_UP]: { dir: "c2p", seqStream: "dataUp" },
  [FRAME_TYPE.DATA_DOWN]: { dir: "p2c", seqStream: "dataDown" },
  [FRAME_TYPE.CLOSE]: { dir: "both", terminal: true },
};

interface LaneHolder {
  sendLane: Promise<void>;
  queuedCount: number;
  slotWaiters: Array<() => void>;
}

interface ReqCtx extends LaneHolder {
  readonly id: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleSuspended: boolean;
  terminal: boolean;
  reassembledBytes: number;
  readonly expectedSeq: Map<SeqStream, number>;
}

/** 提供方自动回送 ERROR 的脱敏 message（英文 ASCII，产品约定）。 */
function autoErrorMessage(code: ErrorCodeValue): string {
  switch (code) {
    case ERROR_CODE.forbidden_method:
      return "http method not allowed";
    case ERROR_CODE.forbidden_header:
      return "http header not allowed";
    case ERROR_CODE.protocol_seq:
      return "chunk sequence gap";
    case ERROR_CODE.body_too_large:
      return "request body exceeds reassembly limit";
    case ERROR_CODE.protocol_version:
      return "unsupported aifly protocol version";
    default:
      return "wire protocol violation";
  }
}

export class WireSession {
  readonly role: WireRole;
  private readonly transport: WireTransport;
  private readonly hooks: WireSessionHooks;
  private readonly peerEndpointId: string | undefined;
  private readonly idleTimeoutMs: number;
  private readonly maxQueuedPerId: number;
  private readonly reassemblyLimitBytes: number;
  private readonly unauthFrameLimit: number;

  private readonly ids = new Map<string, ReqCtx>();
  private readonly usedIds = new Set<string>();
  private readonly globalLane: LaneHolder = { sendLane: Promise.resolve(), queuedCount: 0, slotWaiters: [] };
  private readonly counters = {
    unauthDropped: 0,
    directionDropped: 0,
    schemaDropped: 0,
    catalogDropped: 0,
    unknownIdDropped: 0,
    terminalDropped: 0,
    malformedDropped: 0,
    unknownTypeIgnored: 0,
    unknownVersionDropped: 0,
    poisonedDropped: 0,
  };

  private authedFlag = false;
  private authPending = false; // 使用方已发出 AUTH（未发送前连 AUTH_OK 也属未授权流量）
  private poisonedFlag = false;
  private deadFlag = false;
  private unauthClosed = false;

  constructor(opts: WireSessionOptions) {
    this.role = opts.role;
    this.transport = opts.transport;
    this.hooks = opts.hooks ?? {};
    this.peerEndpointId = opts.peerEndpointId;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxQueuedPerId = opts.maxQueuedPerId ?? DEFAULT_MAX_QUEUED_PER_ID;
    this.reassemblyLimitBytes = opts.reassemblyLimitBytes ?? DEFAULT_REASSEMBLY_LIMIT_BYTES;
    this.unauthFrameLimit = opts.unauthFrameLimit ?? DEFAULT_UNAUTH_FRAME_LIMIT;
    this.transport.onFrame((frame) => this.handleIncoming(frame));
    this.transport.onClose((reason) => this.handleClosed(reason));
  }

  // -----------------------------------------------------------------------
  // 状态与生命周期
  // -----------------------------------------------------------------------

  /** AUTH_OK 交换完成后由上层调用（provider 发出 AUTH_OK 后 / consumer 收到并接受后）。 */
  markAuthed(): void {
    this.authedFlag = true;
    this.authPending = false;
  }

  get authed(): boolean {
    return this.authedFlag;
  }

  get poisoned(): boolean {
    return this.poisonedFlag;
  }

  get dead(): boolean {
    return this.deadFlag;
  }

  /** 观测计数（静默丢弃路径均有计数，供状态上报与测试断言）。 */
  stats(): WireSessionStats {
    return { ...this.counters, authed: this.authedFlag, poisoned: this.poisonedFlag, dead: this.deadFlag };
  }

  /** 关闭传输（触发双端 disconnected → 全量在途 id 终结）。 */
  dispose(reason?: string): void {
    this.transport.close(reason ?? "local-dispose");
  }

  // -----------------------------------------------------------------------
  // request-id
  // -----------------------------------------------------------------------

  /** 分配全局唯一 request-id（randomZ32(16)）；一经分配永不复用。 */
  allocId(): string {
    for (;;) {
      const id = randomZ32(REQUEST_ID_BYTES);
      if (!this.usedIds.has(id)) {
        this.usedIds.add(id);
        return id;
      }
    }
  }

  /** 显式本地终结（不发帧）：之后该 id 出入站帧均静默丢弃。 */
  terminal(id: string): void {
    this.finishId(id, { source: "local" });
  }

  // -----------------------------------------------------------------------
  // 出站（同 id 保序 + 队列上限）
  // -----------------------------------------------------------------------

  /**
   * 发送一帧（编码断言失败抛 WireEncodeError；出站方向违规抛 WireSessionError）。
   * - 同 id 帧经内部 promise 链顺序 await，保证交付顺序（不同 id 之间无顺序承诺）；
   * - 该 id 在途未终结分片 ≥ maxQueuedPerId 时，本次 send 等待队列回落（上层可改用
   *   waitOutboundQueue 实现“暂停读上游”）；
   * - 终结帧（RESP_END / ERROR / CLOSE）发送即登记终结，且不受队列门控（必然出队）。
   */
  async send(type: FrameTypeValue, header: object, body: Uint8Array = NO_BODY): Promise<void> {
    if (this.deadFlag) throw new WireSessionError("closed", "wire session is closed");
    const meta = FRAME_META[type];
    if (meta === undefined) {
      throw new WireSessionError("misuse", `unknown frame type 0x${type.toString(16)}`);
    }
    if (!this.outboundDirectionOk(meta)) {
      throw new WireSessionError(
        "misuse",
        `${FRAME_TYPE_NAME[type] ?? type} is not outbound for role '${this.role}'`,
      );
    }
    if (type === FRAME_TYPE.AUTH && this.role === "consumer") {
      this.authPending = true; // 未发送 AUTH 前的入站 AUTH_OK 属未授权流量（目录同步条款）
    }

    const rawId = (header as { id?: unknown }).id;
    const id = typeof rawId === "string" ? rawId : undefined;
    let ctx: ReqCtx | undefined;
    if (id !== undefined) {
      ctx = this.ids.get(id);
      if (ctx !== undefined && ctx.terminal) {
        this.counters.terminalDropped++;
        return;
      }
      if (ctx === undefined && !meta.terminal) {
        ctx = this.registerId(id); // 活动流帧自动登记（consumer 的 REQ 即在此建档）
      }
      if (ctx !== undefined) {
        if (
          this.role === "provider" &&
          ctx.idleSuspended &&
          (type === FRAME_TYPE.RESP_META || type === FRAME_TYPE.RESP_CHUNK || type === FRAME_TYPE.DATA_DOWN)
        ) {
          ctx.idleSuspended = false; // 首字节/首片到达：首字节等待期豁免结束
        }
        if (meta.terminal) {
          this.finishId(id, { source: "local" });
        } else {
          this.touchIdle(ctx);
        }
      }
    }

    const bytes = encodeFrame({ type, header, body });

    if (ctx !== undefined && !meta.terminal) {
      while (ctx.queuedCount >= this.maxQueuedPerId) {
        if (this.deadFlag) throw new WireSessionError("closed", "wire session is closed");
        await new Promise<void>((resolve) => ctx.slotWaiters.push(resolve));
        if (ctx.terminal) {
          // 等待期间该 id 已被终结（如对端 ERROR）：不再出站。
          this.counters.terminalDropped++;
          return;
        }
      }
    }
    await this.transmit(ctx ?? this.globalLane, bytes);
  }

  /** 该 id 在途未终结分片数（本地队列观测）。 */
  outboundQueueDepth(id: string): number {
    return this.ids.get(id)?.queuedCount ?? 0;
  }

  /** 等待该 id 队列回落到 maxDepth 以下（默认上限-1；上层“暂停读上游”用）。
   *  id 终结（对端 ERROR/本地失败）或会话断连时立即返回——队列永不再回落，
   *  挂起会让调用方永久等待（复核 R2-F3）。 */
  async waitOutboundQueue(id: string, maxDepth: number = this.maxQueuedPerId - 1): Promise<void> {
    const ctx = this.ids.get(id);
    if (ctx === undefined) return;
    while (ctx.queuedCount > maxDepth) {
      if (this.deadFlag || ctx.terminal) return;
      await new Promise<void>((resolve) => ctx.slotWaiters.push(resolve));
    }
  }

  // -----------------------------------------------------------------------
  // 提供方首字节等待期豁免
  // -----------------------------------------------------------------------

  /**
   * 挂起该 id 的空闲计时（provider 专用：请求已派发上游、等待首字节阶段；活度由
   * PING 发送节奏与上游首字节超时管辖）。首个 RESP_META / RESP_CHUNK / DATA_DOWN
   * 出站时自动恢复，也可显式 resumeProviderIdle。
   */
  suspendProviderIdle(id: string): void {
    if (this.role !== "provider") return;
    const ctx = this.ids.get(id);
    if (ctx === undefined || ctx.terminal) return;
    ctx.idleSuspended = true;
    if (ctx.idleTimer !== null) {
      clearTimeout(ctx.idleTimer);
      ctx.idleTimer = null;
    }
  }

  /** 显式恢复该 id 的空闲计时（自恢复点重计完整窗口）。 */
  resumeProviderIdle(id: string): void {
    if (this.role !== "provider") return;
    const ctx = this.ids.get(id);
    if (ctx === undefined || ctx.terminal || !ctx.idleSuspended) return;
    ctx.idleSuspended = false;
    this.armIdle(ctx);
  }

  // -----------------------------------------------------------------------
  // 内部：入站处理
  // -----------------------------------------------------------------------

  private handleIncoming(frame: DecodedFrame): void {
    if (this.deadFlag) return;
    if (this.poisonedFlag) {
      this.counters.poisonedDropped++;
      return;
    }
    if (frame.kind === "unknown-version") {
      this.counters.unknownVersionDropped++;
      if (this.role === "provider") {
        this.replyError(ERROR_CODE.protocol_version, undefined);
      }
      return;
    }
    if (frame.kind === "unknown-type") {
      this.counters.unknownTypeIgnored++;
      return;
    }
    if (frame.kind === "malformed") {
      this.counters.malformedDropped++;
      return;
    }

    const meta = FRAME_META[frame.type];
    if (meta === undefined) {
      this.counters.unknownTypeIgnored++;
      return;
    }
    const { type, header, body } = frame;

    // 1) 未 AUTH 门控（先于方向检查；provider 放行 AUTH，consumer 仅在已发出 AUTH
    //    后放行 AUTH_OK/AUTH_ERR——未发起握手前的一切入站帧含 unsolicited AUTH_OK
    //    均按未授权流量丢弃计数）。
    if (!this.authedFlag) {
      const allowed =
        this.role === "provider"
          ? type === FRAME_TYPE.AUTH
          : this.authPending && (type === FRAME_TYPE.AUTH_OK || type === FRAME_TYPE.AUTH_ERR);
      if (!allowed) {
        this.counters.unauthDropped++;
        if (this.counters.unauthDropped > this.unauthFrameLimit && !this.unauthClosed) {
          this.unauthClosed = true;
          this.hooks.onUnauthViolation?.(this.counters.unauthDropped);
          this.transport.close("too-many-preauth-frames");
        }
        return;
      }
    }

    // 2) 方向检查（provider 回敬 protocol_error——可定位 id 时随帧终结；consumer 静默计数）。
    if (!this.inboundDirectionOk(meta)) {
      if (this.role === "provider") {
        const rawId = (header as { id?: unknown }).id;
        const id = typeof rawId === "string" ? rawId : undefined;
        if (id !== undefined) this.finishId(id, { source: "local" });
        this.replyError(ERROR_CODE.protocol_error, id);
      }
      this.counters.directionDropped++;
      return;
    }

    // 3) schema 校验（strict；失败按分类回敬或静默计数）。
    const parsed = FRAME_HEADER_SCHEMAS[type as FrameTypeValue].safeParse(header);
    if (!parsed.success) {
      const failure = classifySchemaFailure(type, header);
      if (this.role === "provider") {
        if (failure.id !== undefined) this.finishId(failure.id, { source: "local" });
        this.replyError(failure.code, failure.id);
      }
      this.counters.schemaDropped++;
      return;
    }
    const parsedHeader = parsed.data as Record<string, unknown>;

    // 4) id 路由（无 id：AUTH 族与无 id ERROR，直接交付）。
    const rawId = parsedHeader.id;
    const id = typeof rawId === "string" ? rawId : undefined;
    if (id === undefined) {
      // 4a) AUTH_OK 二阶段：帧级 schema 已过（detail 宽松承载），此处按
      //     SERVICE_DETAIL_SCHEMA 严格复核载荷内 detail 投影。失败 = 该提供者
      //     目录同步失败（跨版本安全拒绝）：计数 catalogDropped、触发
      //     onCatalogError、帧带 catalogError 标注后照常交付（会话记账由上层
      //     完成，保持 authed；不走普通帧丢弃路径——schemaDropped 不动）。
      if (type === FRAME_TYPE.AUTH_OK) {
        const catalogError = this.checkCatalogProjection(parsedHeader);
        if (catalogError !== undefined) {
          this.counters.catalogDropped++;
          this.hooks.onCatalogError?.(this.peerEndpointId ?? "", catalogError);
          this.deliver(type, parsedHeader, body, catalogError);
          return;
        }
      }
      this.deliver(type, parsedHeader, body);
      return;
    }

    if (type === FRAME_TYPE.REQ) {
      // REQ 只会出现在 provider 入站（方向检查已过）：首个 REQ 登记 id。
      if (this.ids.has(id)) {
        this.counters.unknownIdDropped++; // 重复 REQ / 已登记 id：异常路由，静默丢弃
        return;
      }
      const ctx = this.registerId(id);
      const bodyLen = parsedHeader.bodyLen as number;
      if (bodyLen > this.reassemblyLimitBytes || body.length > this.reassemblyLimitBytes) {
        this.finishId(id, { source: "body-too-large" });
        this.replyError(ERROR_CODE.body_too_large, id);
        return;
      }
      ctx.reassembledBytes = body.length;
      this.deliver(type, parsedHeader, body);
      return;
    }

    const ctx = this.ids.get(id);
    if (ctx === undefined) {
      this.counters.unknownIdDropped++; // 未知 id（含丢批后首批丢失）：静默丢弃
      return;
    }
    if (ctx.terminal) {
      this.counters.terminalDropped++; // 已终结 id 的迟到帧：静默丢弃
      return;
    }

    // 5) seq 连续性（REQ_BODY / RESP_CHUNK / DATA_* 各自独立从 0 递增）。
    if (meta.seqStream !== undefined) {
      const stream = meta.seqStream;
      const expected = ctx.expectedSeq.get(stream) ?? 0;
      const seq = parsedHeader.seq as number;
      if (seq !== expected) {
        // 毒化：流已不可信。provider 回送 ERROR(protocol_seq) 并终结；consumer 本地
        // 终结（不发 ERROR——ERROR 仅提供方发出）；连接标记毒化由上层重建。
        this.finishId(id, { source: "protocol-seq" });
        if (this.role === "provider") {
          this.replyError(ERROR_CODE.protocol_seq, id);
        }
        this.markPoisoned(id);
        return;
      }
      ctx.expectedSeq.set(stream, expected + 1);
    }

    // 6) 重组上限（REQ_BODY 累计，含 REQ 内联部分；超限终结该请求但不毒化连接）。
    if (type === FRAME_TYPE.REQ_BODY) {
      ctx.reassembledBytes += body.length;
      if (ctx.reassembledBytes > this.reassemblyLimitBytes) {
        this.finishId(id, { source: "body-too-large" });
        this.replyError(ERROR_CODE.body_too_large, id);
        return;
      }
    }

    // 7) 空闲重置（任意该 id 帧：入站含 PING / WS DATA 均重置）。
    this.touchIdle(ctx);

    // 8) 终结帧登记（RESP_END / ERROR / CLOSE；之后同 id 帧静默丢弃）。
    if (meta.terminal === true) {
      this.finishId(id, { source: "peer", frameType: type });
    }
    this.deliver(type, parsedHeader, body);
  }

  /**
   * AUTH_OK 载荷内 detail 投影的严格复核（二阶段第二段）：任一服务携带不合
   * SERVICE_DETAIL_SCHEMA 的 detail 即整体目录同步失败（全量替换语义下无部分
   * 应用）。返回固定脱敏消息（不含 zod 细节与原始值）；全部通过返回 undefined。
   */
  private checkCatalogProjection(header: Record<string, unknown>): string | undefined {
    const groups = header.groups;
    if (!Array.isArray(groups)) return undefined; // 帧级 schema 已保证形状（防御）
    for (const group of groups) {
      const services = (group as { services?: unknown }).services;
      if (!Array.isArray(services)) continue;
      for (const service of services) {
        const detail = (service as { detail?: unknown }).detail;
        if (detail === undefined) continue;
        if (!SERVICE_DETAIL_SCHEMA.safeParse(detail).success) {
          return "provider catalog detail failed validation (provider/consumer version mismatch?)";
        }
      }
    }
    return undefined;
  }

  private deliver(type: number, header: Record<string, unknown>, body: Uint8Array, catalogError?: string): void {
    const frame = { type, header, body, ...(catalogError !== undefined ? { catalogError } : {}) } as unknown as InboundFrame;
    this.hooks.onFrame?.(frame);
  }

  private markPoisoned(id: string): void {
    if (this.poisonedFlag) return;
    this.poisonedFlag = true;
    this.hooks.onPoison?.({ id, reason: "protocol_seq" });
  }

  // -----------------------------------------------------------------------
  // 内部：id / 计时 / 终结
  // -----------------------------------------------------------------------

  private registerId(id: string): ReqCtx {
    const existing = this.ids.get(id);
    if (existing !== undefined) return existing;
    const ctx: ReqCtx = {
      id,
      idleTimer: null,
      idleSuspended: false,
      terminal: false,
      reassembledBytes: 0,
      expectedSeq: new Map(),
      sendLane: Promise.resolve(),
      queuedCount: 0,
      slotWaiters: [],
    };
    this.ids.set(id, ctx);
    this.usedIds.add(id);
    this.armIdle(ctx);
    return ctx;
  }

  private touchIdle(ctx: ReqCtx): void {
    if (ctx.idleSuspended) return;
    this.armIdle(ctx);
  }

  private armIdle(ctx: ReqCtx): void {
    if (ctx.idleTimer !== null) clearTimeout(ctx.idleTimer);
    ctx.idleTimer = setTimeout(() => {
      ctx.idleTimer = null;
      if (this.deadFlag || ctx.terminal) return;
      this.hooks.onIdleTimeout?.(ctx.id);
    }, this.idleTimeoutMs);
  }

  /** 唤醒该 lane 全部排队等待者（不改变 queuedCount）：send 路径在唤醒后
   *  复查 terminal 走 terminalDropped；waitOutboundQueue 复查后直接返回。
   *  终结与断连必经（复核 R2-F3）——否则 transport 不再结算时等待者永久挂起。 */
  private wakeSlotWaiters(lane: LaneHolder): void {
    const waiters = lane.slotWaiters.splice(0);
    for (const wake of waiters) wake();
  }

  private finishId(id: string, cause: TerminateCause): void {
    const ctx = this.ids.get(id);
    if (ctx === undefined || ctx.terminal) return;
    ctx.terminal = true;
    if (ctx.idleTimer !== null) {
      clearTimeout(ctx.idleTimer);
      ctx.idleTimer = null;
    }
    this.wakeSlotWaiters(ctx);
    this.hooks.onTerminate?.(id, cause);
  }

  private handleClosed(reason?: string): void {
    if (this.deadFlag) return;
    this.deadFlag = true;
    const cause: TerminateCause =
      reason === undefined ? { source: "disconnected" } : { source: "disconnected", reason };
    for (const ctx of this.ids.values()) {
      if (ctx.idleTimer !== null) {
        clearTimeout(ctx.idleTimer);
        ctx.idleTimer = null;
      }
      if (!ctx.terminal) {
        ctx.terminal = true;
        this.hooks.onTerminate?.(ctx.id, cause);
      }
      this.wakeSlotWaiters(ctx); // 全局通道等待者同样唤醒（复核 R2-F3）
    }
    this.wakeSlotWaiters(this.globalLane);
    this.hooks.onDisconnect?.(reason);
  }

  // -----------------------------------------------------------------------
  // 内部：方向 / 出站通道
  // -----------------------------------------------------------------------

  private inboundDirectionOk(meta: FrameMetaEntry): boolean {
    if (meta.dir === "both") return true;
    return this.role === "provider" ? meta.dir === "c2p" : meta.dir === "p2c";
  }

  private outboundDirectionOk(meta: FrameMetaEntry): boolean {
    if (meta.dir === "both") return true;
    return this.role === "provider" ? meta.dir === "p2c" : meta.dir === "c2p";
  }

  /** 提供方自动回送 ERROR（无队列门控、经全局通道；发送失败静默——连接已坏时由关闭路径处置）。 */
  private replyError(code: ErrorCodeValue, id: string | undefined): void {
    const header: Record<string, unknown> = { code, message: autoErrorMessage(code) };
    if (id !== undefined) header.id = id;
    const bytes = encodeFrame({ type: FRAME_TYPE.ERROR, header });
    this.transmit(this.globalLane, bytes).catch(() => undefined);
  }

  private transmit(lane: LaneHolder, bytes: Uint8Array): Promise<void> {
    lane.queuedCount++;
    const attempt = lane.sendLane.then(() => this.transport.send(bytes));
    const settled = attempt.then(
      () => {
        this.slotReleased(lane);
      },
      (err: unknown) => {
        this.slotReleased(lane);
        throw err;
      },
    );
    // 链本身永不因单帧失败断裂（错误仍传递给当次调用者）。
    lane.sendLane = settled.catch(() => undefined);
    return settled;
  }

  private slotReleased(lane: LaneHolder): void {
    lane.queuedCount--;
    const waiters = lane.slotWaiters.splice(0);
    for (const wake of waiters) wake();
  }
}
