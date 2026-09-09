// webui RPC 客户端（B 3.1）：
// - 同源 ws(s)://host/ws/rpc（鉴权走 HttpOnly 会话 cookie——web-server 在
//   token 兑换后写入，ws 升级时浏览器自动携带；无 token 处理）。
// - RPCLink + createORPCClient 构造全类型 client（写法基准：skill-creator-v2
//   的 webui/src/lib/rpc-client.ts，按 cookie 鉴权裁剪）。
// - 断线指数重连（1s 起步、30s 封顶、带抖动；成功打开后归零），RPC 与
//   notify 两条通道各自独立重连；notify 重连成功后向总线派发 __reconcile
//   伪事件，触发前端全量对账（spec「断线对账」）。
// - 通知仅为触发器：收到事件 → 按类型标脏 → 拉取对应 status（app store）。
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import { rpcContract, type RpcContract } from "$shared/rpc-contract.ts";

/** 强类型 RPC client，签名由契约推导。 */
export type RpcClient = ContractRouterClient<RpcContract>;

/** 引擎通知事件（与 src/app/engine-host.ts 的 NotifyEvent 同形）。 */
export interface NotifyEvent {
  type: string;
  payload: Record<string, unknown>;
}

/** 连接状态：connecting（首次）/ open / reconnecting（掉线重连中）。 */
export type RpcConnectionStatus = "connecting" | "open" | "reconnecting";

/** 规整后的调用错误（六码 + 引擎英文消息；未归类归 INTERNAL）。 */
export interface RpcError {
  code: string;
  message: string;
}

/** 把任意抛出的错误规整为 {code, message}（ORPCError 携带稳定 code）。 */
export function toRpcError(error: unknown): RpcError {
  if (typeof error === "object" && error !== null && "code" in error) {
    const candidate = error as { code: unknown; message?: unknown };
    const code = String(candidate.code);
    const message = typeof candidate.message === "string" ? candidate.message : "request failed";
    return { code: code || "INTERNAL", message };
  }
  if (error instanceof Error) return { code: "INTERNAL", message: error.message };
  return { code: "INTERNAL", message: String(error) };
}

/** 推导同源 ws 地址（dev 靠 vite 代理，release 由 daemon 直接托管）。 */
export function wsUrl(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

/** 从一个已建立的 WebSocket 构造强类型 oRPC client。 */
export function createRpcClient(ws: WebSocket): RpcClient {
  const link = new RPCLink({ websocket: ws });
  return createORPCClient<RpcClient>(link);
}

// ---------------------------------------------------------------------------
// 断线重连 socket（RPC 与 notify 共用）
// ---------------------------------------------------------------------------

interface SocketHooks {
  /** 成功打开（reopened = 非首次打开，用于触发对账）。 */
  onOpen(ws: WebSocket, reopened: boolean): void;
  /** 文本帧（notify 通道用；rpc 通道由 RPCLink 自管，不用此钩子）。 */
  onMessage(data: string): void;
  /** 非用户关闭（掉线；随后必然重连）。 */
  onClose(): void;
  onStatus(status: RpcConnectionStatus): void;
}

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const RETRY_JITTER_MS = 250;

/** 指数退避重连的单条 WebSocket 通道。 */
class ReconnectingSocket {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private everOpened = false;

  constructor(
    private readonly path: string,
    private readonly hooks: SocketHooks,
  ) {
    this.spawn();
  }

  private spawn(): void {
    if (this.closedByUser) return;
    this.hooks.onStatus(this.everOpened ? "reconnecting" : "connecting");
    const ws = new WebSocket(wsUrl(this.path));
    this.ws = ws;
    ws.addEventListener("open", () => {
      const reopened = this.everOpened;
      this.everOpened = true;
      this.attempts = 0;
      this.hooks.onStatus("open");
      this.hooks.onOpen(ws, reopened);
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") this.hooks.onMessage(event.data);
    });
    // error 之后浏览器必然派发 close——统一在 close 里重连
    ws.addEventListener("close", () => {
      if (this.closedByUser) return;
      this.ws = null;
      this.hooks.onClose();
      this.hooks.onStatus("reconnecting");
      const delay = Math.min(RETRY_BASE_MS * 2 ** this.attempts, RETRY_MAX_MS) + Math.random() * RETRY_JITTER_MS;
      this.attempts += 1;
      this.timer = setTimeout(() => this.spawn(), delay);
    });
  }

  close(): void {
    this.closedByUser = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }
}

// ---------------------------------------------------------------------------
// 连接门面：RPC 调用 + notify 订阅
// ---------------------------------------------------------------------------

const OPEN_WAIT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 60_000;

/** 单页应用生命周期的 RPC 连接（rpc + notify 双通道）。 */
export class RpcConnection {
  private client: RpcClient | null = null;
  private readonly openWaiters = new Set<() => void>();
  private readonly notifyListeners = new Set<(event: NotifyEvent) => void>();
  private readonly statusListeners = new Set<(status: RpcConnectionStatus) => void>();
  private readonly rpcSocket: ReconnectingSocket;
  private readonly notifySocket: ReconnectingSocket;

  constructor() {
    this.rpcSocket = new ReconnectingSocket("/ws/rpc", {
      onOpen: (ws) => {
        this.client = createRpcClient(ws);
        for (const resolve of this.openWaiters) resolve();
        this.openWaiters.clear();
      },
      onMessage: () => undefined, // rpc 通道帧由 RPCLink 自管
      onClose: () => {
        // 掉线即刻弃用旧 client：后续 call 在 waitForOpen 等新连接，
        // 而非把请求塞进死链路
        this.client = null;
      },
      onStatus: (status) => {
        for (const listener of this.statusListeners) listener(status);
      },
    });
    this.notifySocket = new ReconnectingSocket("/ws/notify", {
      onOpen: (_ws, reopened) => {
        // notify 闪断恢复 → 全量对账伪事件（spec「断线对账」）
        if (reopened) this.dispatch({ type: "__reconcile", payload: {} });
      },
      onMessage: (data) => {
        try {
          const parsed = JSON.parse(data) as NotifyEvent;
          if (typeof parsed?.type === "string") this.dispatch(parsed);
        } catch {
          // 非 JSON 帧忽略（通道只下行）
        }
      },
      onClose: () => undefined,
      onStatus: () => undefined, // 状态条只反映 rpc 通道
    });
  }

  private dispatch(event: NotifyEvent): void {
    for (const listener of this.notifyListeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者异常不波及总线
      }
    }
  }

  /** 订阅通知事件（含 __reconcile）；返回取消函数。 */
  subscribeNotify(listener: (event: NotifyEvent) => void): () => void {
    this.notifyListeners.add(listener);
    return () => this.notifyListeners.delete(listener);
  }

  /** 订阅连接状态变化；返回取消函数。 */
  onStatus(listener: (status: RpcConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** 等待 rpc 通道打开（带上限，避免 UI 无限 pending）。 */
  private waitForOpen(): Promise<boolean> {
    if (this.client !== null) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.openWaiters.delete(resolveNow);
        resolve(false);
      }, OPEN_WAIT_MS);
      const resolveNow = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.openWaiters.add(resolveNow);
    });
  }

  /**
   * 执行一次 RPC 调用：等待通道打开后以当前 client 调用；
   * 整体带看门狗（长操作如 import.apply 也有上限）。
   */
  async call<T>(fn: (client: RpcClient) => Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const opened = await this.waitForOpen();
    if (!opened || this.client === null) {
      throw { code: "UNAVAILABLE", message: "cannot reach the local ai-fly service" } satisfies RpcError;
    }
    const client = this.client;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(client),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject({ code: "UNAVAILABLE", message: "request timed out" } satisfies RpcError),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
