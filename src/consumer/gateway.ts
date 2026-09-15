// 本地网关（consumer spec「端口映射与冲突」「转发、流式还原与接收侧兜底」）：
// 每个已授权服务一个独立 127.0.0.1 http server（hono app + @hono/node-server 适配，
// 服务间监听与冲突处理彼此隔离）+ node:http 'upgrade' 事件直挂 WS 中继（ws 库）。
// HTTP：请求→REQ 帧（剥离凭据头；contentType 独立字段；body ≤256KiB 内联否则
// splitBody 续帧）；RESP_META→写头、RESP_CHUNK→逐块 flush（SSE 透传）、RESP_END→
// 结束、ERROR→HTTP 映射 + OpenAI 风格 error JSON；客户端断开→ABORT。
// 接收侧兜底：每请求待消费缓冲默认 4MiB（WS 双向各自计），超限 ABORT + 本地连接
// 错误关闭 + buffer_overflow 记账（显式字节计数 + drain 追踪，进程内存有界）。
// WS：本地握手由 ws 库 handleUpgrade 完成（accept=base64(sha1(key+GUID)) 自算，
// 客户端校验由此保证）；上游侧 ws 库自管握手 key，其 accept 与本地无恒等关系，
// 不做比对（避免恒 destroy）。
// 正交意图：只做本地端点与流还原；wire 帧语义、Fabric、重连在 wire//providers.ts。

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { Hono } from "hono";
import { createAdaptorServer, type HttpBindings } from "@hono/node-server";
import { WebSocketServer, type WebSocket as WsSocket, type RawData } from "ws";
import { HTTP_METHODS, type ErrorCodeValue, type RespMetaHeader, type ServiceEntry } from "../wire/frames.ts";
import type { TerminateCause } from "../wire/mux.ts";
import {
  OfflineError,
  type ForwardHandle,
  type ForwardHandlers,
  type ForwardInput,
  type ProviderRoute,
} from "./providers.ts";
import { listenWithFallback, desiredPortFor, LOOPBACK_HOST } from "./ports.ts";

export const DEFAULT_RECEIVE_BUFFER_LIMIT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
/** 每次 pull 从待消费队列搬入 ReadableStream 的批量上限（约束 controller 内排队）。 */
const PUMP_BATCH_BYTES = 256 * 1024;
/** null-body 状态码：Response 构造不允许携带正文。 */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

// ---------------------------------------------------------------------------
// 错误码 → HTTP 映射（表驱动；null = 连接错误关闭，不回 HTTP 实体）
// ---------------------------------------------------------------------------

export interface HttpErrorMapping {
  status: number | null;
  /** OpenAI 风格 error.type。 */
  type: string;
}

export const ERROR_HTTP_MAPPING: Readonly<Record<ErrorCodeValue, HttpErrorMapping>> = {
  rate_limited: { status: 429, type: "rate_limit_error" },
  quota_exceeded: { status: 429, type: "rate_limit_error" },
  forbidden_method: { status: 405, type: "invalid_request_error" },
  forbidden_header: { status: 400, type: "invalid_request_error" },
  body_too_large: { status: 413, type: "invalid_request_error" },
  unknown_service: { status: 404, type: "invalid_request_error" },
  // 服务声明了路由表但路径未命中任何标准前缀：本地拒绝（零上游请求）——
  // 只转发声明的 API 标准面，防 /user、/balance 等个人信息端点被凭据打穿。
  path_not_offered: { status: 404, type: "invalid_request_error" },
  unauthorized: { status: 401, type: "authentication_error" },
  key_all_invalid: { status: 503, type: "api_error" },
  upstream_unreachable: { status: 502, type: "api_error" },
  // 上游错误状态正常路径走 RESP_META/CHUNK/END 流原样透传；裸 ERROR(upstream_status)
  // 帧不携带 status 载荷，只能以 502 兜底（裁决记录于报告）。
  upstream_status: { status: 502, type: "api_error" },
  // 提供方密钥库无此引用（$secret 未知名）：提供方配置问题，消费方视角 502。
  secret_missing: { status: 502, type: "api_error" },
  // ②③④ 生命周期脚本失效（绑定缺席/抛错/形状非法/流中途失败）：HTTP 生命周期
  // 分流（hooks-lifecycle 4.4）——pending 阶段（RESP_META 未下发）经下方
  // errorResponseFor 映射 502 + 脱敏 message JSON；已进入流式后由 onError 的
  // failStream 分支关闭本地连接终结（不回退状态码，观感与上游流中断一致）。
  hook_failed: { status: 502, type: "api_error" },
  protocol_version: { status: 500, type: "api_error" },
  protocol_seq: { status: 500, type: "api_error" },
  protocol_error: { status: 500, type: "api_error" },
  internal: { status: 500, type: "api_error" },
  // 客户端已断开/本地中止/超时/超限：无实体可回，语义是连接错误关闭。
  aborted: { status: null, type: "api_error" },
  idle_timeout: { status: null, type: "api_error" },
  buffer_overflow: { status: null, type: "api_error" },
};

export interface ErrorJsonBody {
  error: { message: string; type: string; code: string };
}

export function buildErrorJson(code: string, message: string, type: string): ErrorJsonBody {
  return { error: { message, type, code } };
}

function errorResponse(status: number, code: string, message: string, type: string): Response {
  return new Response(JSON.stringify(buildErrorJson(code, message, type)) + "\n", {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** ERROR 帧 → 本地 HTTP 响应/连接处置。返回 null 表示按连接错误关闭处置。 */
export function errorResponseFor(code: ErrorCodeValue, message: string): Response | null {
  const m = ERROR_HTTP_MAPPING[code];
  if (m.status === null) return null;
  return errorResponse(m.status, code, message, m.type);
}

// ---------------------------------------------------------------------------
// 请求头过滤（凭据类剥离；WS 握手头端到端透传）
// ---------------------------------------------------------------------------

/** 剥离集合：凭据类（协议双向零过桥）+ 由帧内专门字段/提供方配置承载的归属类 + 逐跳头。 */
const STRIP_REQUEST_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-type",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "expect",
  "set-cookie",
]);

/** WS 握手透传头（connection/upgrade/sec-websocket-*；spec REQ 条款放行集）。 */
const WS_HANDSHAKE_PASS = new Set([
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
]);

export interface FilteredHeaders {
  headers: Record<string, string> | undefined;
  contentType: string | undefined;
}

/**
 * 本地请求头 → REQ.headers：小写键、去凭据/归属/逐跳；非升级请求剥 WS 握手头，
 * 升级请求放行 WS_HANDSHAKE_PASS（sec-websocket-key 端到端透传，使上游 accept 与
 * 本地计算恒等）。content-type 抽到独立字段。超过 32 项抛 LocalHeaderOverflow。
 */
export function filterRequestHeaders(raw: IncomingMessage["headers"], isUpgrade: boolean): FilteredHeaders {
  const out: Record<string, string> = {};
  let contentType: string | undefined;
  const ct = raw["content-type"];
  if (typeof ct === "string") contentType = ct;
  else if (Array.isArray(ct)) {
    const first = ct[0];
    if (first !== undefined) contentType = first;
  }
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== "string") continue; // 数组值（set-cookie 等）不透传
    const isWsHandshake = WS_HANDSHAKE_PASS.has(name);
    if (STRIP_REQUEST_HEADERS.has(name) && !(isUpgrade && isWsHandshake)) continue;
    if (name.startsWith("sec-websocket-") && !isWsHandshake) continue;
    if (!isUpgrade && isWsHandshake) continue;
    out[name] = value;
  }
  return { headers: Object.keys(out).length > 0 ? out : undefined, contentType };
}

/** 本地请求头数超限（REQ.headers ≤32）：本地即拒，不发起转发。 */
export class LocalHeaderOverflowError extends Error {
  constructor() {
    super("too many headers");
    this.name = "LocalHeaderOverflowError";
  }
}

export function assertHeaderCount(filtered: FilteredHeaders): void {
  if (filtered.headers !== undefined && Object.keys(filtered.headers).length > 32) {
    throw new LocalHeaderOverflowError();
  }
}

/** 本地请求正文超限（与提供方 8MiB 重组上限同值；本地先拒，节省注定失败的转发）。 */
export class LocalBodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`request body exceeds local limit of ${limit} bytes`);
    this.name = "LocalBodyTooLargeError";
  }
}

async function readRequestBody(incoming: IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of incoming) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limit) throw new LocalBodyTooLargeError(limit);
    chunks.push(buf);
  }
  if (chunks.length === 1) return new Uint8Array(chunks[0]!);
  return new Uint8Array(Buffer.concat(chunks));
}

// ---------------------------------------------------------------------------
// 网关
// ---------------------------------------------------------------------------

export interface GatewayOptions {
  /** 按提供者取转发入口（离线时 forward 抛 OfflineError → 503）。 */
  resolveRoute: (providerId: string) => ProviderRoute | undefined;
  strictPorts?: boolean;
  receiveBufferLimitBytes?: number;
  requestBodyLimitBytes?: number;
  onNotice?: (line: string) => void;
}

export interface ListenerInfo {
  providerId: string;
  alias: string;
  serviceId: string;
  name: string;
  port: number;
  requested: number;
  autoAssigned: boolean;
}

/** 每服务一个监听 + 其在途本地请求上下文（服务删除时终结）。 */
interface ServiceListener {
  providerId: string;
  alias: string;
  serviceId: string;
  name: string;
  server: Server;
  port: number;
  requested: number;
  autoAssigned: boolean;
  sockets: Set<Duplex>;
  inflight: Set<LocalCtx>;
}

/** 本地请求上下文公共面（HTTP 与 WS 各自实现 finish/强制中止）。 */
interface LocalCtx {
  finished: boolean;
  forceAbort(): void;
}

type HonoEnv = { Bindings: HttpBindings };

export class Gateway {
  private readonly listeners = new Map<string, ServiceListener>(); // key = providerId/serviceId
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly strictPorts: boolean;
  private readonly receiveLimit: number;
  private readonly bodyLimit: number;
  private readonly onNotice: (line: string) => void;
  private readonly resolveRoute: (providerId: string) => ProviderRoute | undefined;
  private stopped = false;

  constructor(opts: GatewayOptions) {
    this.resolveRoute = opts.resolveRoute;
    this.strictPorts = opts.strictPorts ?? false;
    this.receiveLimit = opts.receiveBufferLimitBytes ?? DEFAULT_RECEIVE_BUFFER_LIMIT_BYTES;
    this.bodyLimit = opts.requestBodyLimitBytes ?? DEFAULT_REQUEST_BODY_LIMIT_BYTES;
    this.onNotice = opts.onNotice ?? (() => undefined);
  }

  listenerInfo(): ListenerInfo[] {
    return [...this.listeners.values()].map((l) => ({
      providerId: l.providerId,
      alias: l.alias,
      serviceId: l.serviceId,
      name: l.name,
      port: l.port,
      requested: l.requested,
      autoAssigned: l.autoAssigned,
    }));
  }

  /**
   * 目录同步（AUTH_OK 初次/refresh 全量替换）：新增服务建监听（冲突自动错开 + NOTICE），
   * 被移除服务关端口 + 终结其在途请求；既有服务仅刷新展示元数据（端口偏好改动需重启
   * 网关生效——ports 命令是独立进程，裁决记录于报告）。
   */
  async syncProviderServices(
    providerId: string,
    alias: string,
    services: readonly ServiceEntry[],
    ports: Readonly<Record<string, number>>,
  ): Promise<void> {
    if (this.stopped) return;
    const desired = new Map(services.map((s) => [s.serviceId, s]));
    // 删除：refresh 视图不含的服务
    for (const key of [...this.listeners.keys()]) {
      const l = this.listeners.get(key)!;
      if (l.providerId === providerId && !desired.has(l.serviceId)) {
        this.removeService(key, "service removed by provider");
      }
    }
    // 新增
    for (const service of services) {
      const key = `${providerId}/${service.serviceId}`;
      const existing = this.listeners.get(key);
      if (existing !== undefined) {
        existing.alias = alias;
        existing.name = service.name;
        continue;
      }
      await this.addService(providerId, alias, service, ports);
    }
  }

  /**
   * 单服务停用/启用热生效（service-lifecycle）：stop 关端口 + 终结在途请求；
   * start 建监听（冲突自动错开 + NOTICE）。幂等（停用无监听、启用已监听均为
   * no-op）。条目与端口偏好由调用方从钥环提供（Gateway 不读磁盘）。
   */
  async setServiceEnabled(
    providerId: string,
    alias: string,
    service: ServiceEntry,
    ports: Readonly<Record<string, number>>,
    enabled: boolean,
  ): Promise<void> {
    if (this.stopped) return;
    const key = `${providerId}/${service.serviceId}`;
    if (!enabled) {
      this.removeService(key, "disabled locally");
      return;
    }
    if (this.listeners.has(key)) return;
    await this.addService(providerId, alias, service, ports);
  }

  private async addService(
    providerId: string,
    alias: string,
    service: ServiceEntry,
    ports: Readonly<Record<string, number>>,
  ): Promise<void> {
    const key = `${providerId}/${service.serviceId}`;
    // 延后绑定：hono 回调经 listenerRef 取 listener（server 与 listener 互相引用）
    let listenerRef: ServiceListener | undefined;
    const app = new Hono<HonoEnv>();
    app.all("*", (c) => {
      const l = listenerRef;
      if (l === undefined) {
        return errorResponse(503, "internal", "service listener not ready", "api_error");
      }
      return this.handleHttp(c.env.incoming, c.env.outgoing, l);
    });
    // 适配器返回类型是 http1/http2 联合；本网关恒用 http1 server（未传 http2 选项）
    const server = createAdaptorServer({ fetch: app.fetch }) as unknown as Server;
    const listener: ServiceListener = {
      providerId,
      alias,
      serviceId: service.serviceId,
      name: service.name,
      server,
      port: 0,
      requested: desiredPortFor(service, ports),
      autoAssigned: false,
      sockets: new Set(),
      inflight: new Set(),
    };
    listenerRef = listener;
    server.on("connection", (s: Duplex) => {
      listener.sockets.add(s);
      s.on("close", () => listener.sockets.delete(s));
    });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (req.headers.upgrade?.toLowerCase() !== "websocket") {
        socket.destroy();
        return;
      }
      this.handleUpgrade(req, socket, head, listener);
    });
    try {
      const assignment = await listenWithFallback(server, { desired: listener.requested, strict: this.strictPorts });
      listener.port = assignment.port;
      listener.autoAssigned = assignment.autoAssigned;
      if (assignment.autoAssigned && assignment.reason !== undefined) {
        this.onNotice(
          `NOTICE: service '${service.name}' - ${assignment.reason} - listening on ${LOOPBACK_HOST}:${assignment.port} instead of ${LOOPBACK_HOST}:${assignment.requested}`,
        );
      }
    } catch (err) {
      server.close();
      throw err;
    }
    this.listeners.set(key, listener);
  }

  /** 关闭某服务监听：终结在途（ABORT/CLOSE + 本地连接错误关闭）并断开全部 socket。 */
  private removeService(key: string, reason: string): void {
    const listener = this.listeners.get(key);
    if (listener === undefined) return;
    this.listeners.delete(key);
    for (const ctx of [...listener.inflight]) ctx.forceAbort();
    listener.server.close();
    for (const s of [...listener.sockets]) s.destroy();
    this.onNotice(`NOTICE: service '${listener.name}' closed (${reason})`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const key of [...this.listeners.keys()]) {
      const listener = this.listeners.get(key)!;
      for (const ctx of [...listener.inflight]) ctx.forceAbort();
      listener.server.close();
      for (const s of [...listener.sockets]) s.destroy();
      this.listeners.delete(key);
    }
    this.wss.close();
  }

  private routeOr503(listener: ServiceListener): ProviderRoute | Response {
    const route = this.resolveRoute(listener.providerId);
    if (route === undefined) {
      return errorResponse(503, "provider_offline", `provider '${listener.alias}' is offline`, "api_error");
    }
    return route;
  }

  // ------------------------------------------------------------------
  // HTTP 路径
  // ------------------------------------------------------------------

  private async handleHttp(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    listener: ServiceListener,
  ): Promise<Response> {
    if (this.stopped) return errorResponse(503, "provider_offline", "gateway is shutting down", "api_error");
    const method = (incoming.method ?? "GET").toUpperCase();
    if (!(HTTP_METHODS as readonly string[]).includes(method)) {
      return errorResponse(405, "forbidden_method", `http method not allowed: ${method}`, "invalid_request_error");
    }
    let path = incoming.url ?? "/";
    if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) {
      return errorResponse(400, "protocol_error", "invalid request path", "invalid_request_error");
    }
    if (path.length > 4 * 1024) {
      return errorResponse(400, "protocol_error", "request path exceeds 4 KiB", "invalid_request_error");
    }
    const filtered = filterRequestHeaders(incoming.headers, false);
    try {
      assertHeaderCount(filtered);
    } catch {
      return errorResponse(400, "protocol_error", "too many request headers (> 32)", "invalid_request_error");
    }
    let body: Uint8Array;
    try {
      body = method === "GET" || method === "HEAD" ? new Uint8Array(0) : await readRequestBody(incoming, this.bodyLimit);
    } catch (err) {
      if (err instanceof LocalBodyTooLargeError) {
        return errorResponse(413, "body_too_large", err.message, "invalid_request_error");
      }
      throw err;
    }
    const route = this.routeOr503(listener);
    if (route instanceof Response) return route;

    const input: ForwardInput = {
      serviceId: listener.serviceId,
      method,
      path,
      body,
      upgrade: false,
      ...(filtered.headers !== undefined ? { headers: filtered.headers } : {}),
      ...(filtered.contentType !== undefined ? { contentType: filtered.contentType } : {}),
    };

    const ctx = new HttpStreamCtx(listener, this.receiveLimit, (pid) => this.noteBufferOverflow(pid), method);
    listener.inflight.add(ctx);
    // 先登记 resolve 再 forward：对端可能在 forward 返回前同步回包（onMeta/onError）
    const responsePromise = new Promise<Response>((resolve) => {
      ctx.resolveMeta = resolve;
    });
    let handle: ForwardHandle;
    try {
      handle = route.forward(input, ctx.handlers());
    } catch (err) {
      listener.inflight.delete(ctx);
      if (err instanceof OfflineError) {
        return errorResponse(503, err.code, `${err.message} (provider '${err.alias}')`, "api_error");
      }
      throw err;
    }
    ctx.attach(handle);
    // 客户端断开（首字节前）：ABORT + 请求侧清理；流式期的断开经 stream.cancel 路径
    outgoing.on("close", () => ctx.clientClosed());
    // 兜底路径 controller.error → 适配器以错误 destroy 响应对象：吞掉 error 事件，
    // 连接错误关闭的清理由本网关自行完成（避免未捕获 error 冒泡进程）
    outgoing.on("error", () => undefined);
    return await responsePromise;
  }

  // ------------------------------------------------------------------
  // WS 升级路径
  // ------------------------------------------------------------------

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, listener: ServiceListener): void {
    if (this.stopped) {
      socket.destroy();
      return;
    }
    const route = this.resolveRoute(listener.providerId);
    if (route === undefined) {
      writeRawJsonError(socket, 503, "provider_offline", `provider '${listener.alias}' is offline`);
      return;
    }
    const path = req.url ?? "/";
    if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) {
      writeRawJsonError(socket, 400, "protocol_error", "invalid request path");
      return;
    }
    const filtered = filterRequestHeaders(req.headers, true);
    const input: ForwardInput = {
      serviceId: listener.serviceId,
      method: "GET",
      path,
      body: new Uint8Array(0),
      upgrade: true,
      ...(filtered.headers !== undefined ? { headers: filtered.headers } : {}),
    };
    const ctx = new WsStreamCtx(listener, this, this.receiveLimit, (pid) => this.noteBufferOverflow(pid));
    listener.inflight.add(ctx);
    let handle: ForwardHandle;
    try {
      handle = route.forward(input, ctx.beginUpgrade(req, socket, head));
    } catch (err) {
      listener.inflight.delete(ctx);
      if (err instanceof OfflineError) {
        writeRawJsonError(socket, 503, err.code, `${err.message} (provider '${err.alias}')`);
      } else {
        writeRawJsonError(socket, 500, "internal", (err as Error).message);
      }
      return;
    }
    ctx.attach(handle);
    socket.on("close", () => ctx.clientClosed());
    socket.on("error", () => ctx.clientClosed());
  }

  /** ws 库本地握手入口（WsStreamCtx 在 RESP_META(101) 后调用）。 */
  acceptWsUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, cb: (ws: WsSocket) => void): void {
    this.wss.handleUpgrade(req, socket, head, cb);
  }

  /** 接收缓冲超限记账（ctx 兜底路径 → 对应提供者连接的 bufferOverflows 计数）。 */
  private noteBufferOverflow(providerId: string): void {
    this.resolveRoute(providerId)?.noteBufferOverflow();
  }
}

/** 升级前的原始 socket 写 JSON 错误（尚无 hono Response 通道）。 */
function writeRawJsonError(socket: Duplex | undefined, status: number, code: string, message: string): void {
  if (socket === undefined || socket.destroyed || !socket.writable) return;
  const type = ERROR_HTTP_MAPPING[code as ErrorCodeValue]?.type ?? "api_error";
  const body = JSON.stringify(buildErrorJson(code, message, type));
  socket.write(
    `HTTP/1.1 ${status} ${reasonFor(status)}\r\ncontent-type: application/json\r\nconnection: close\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  socket.end();
}

function reasonFor(status: number): string {
  const known: Record<number, string> = {
    400: "Bad Request",
    404: "Not Found",
    405: "Method Not Allowed",
    413: "Payload Too Large",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
  };
  return known[status] ?? "Error";
}

// ---------------------------------------------------------------------------
// HTTP 本地流上下文（待消费缓冲 + 逐块 flush + 兜底）
// ---------------------------------------------------------------------------

class HttpStreamCtx implements LocalCtx {
  finished = false;
  handle: ForwardHandle | undefined;
  /** forward 返回前对端已同步触发中止（overflow 等）——handle 就绪后补发。 */
  private abortPending = false;
  resolveMeta: ((r: Response) => void) | undefined;
  private state: "pending" | "streaming" | "done" = "pending";
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  private readonly queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private ended = false;
  private nullBody = false;
  private readonly dropBody: boolean;
  private status = 200;
  private contentType = "application/octet-stream";
  private extraHeaders: Record<string, string> = {};

  constructor(
    private readonly listener: ServiceListener,
    private readonly limit: number,
    private readonly noteOverflow: (providerId: string) => void,
    method: string,
  ) {
    this.dropBody = method === "HEAD";
  }

  handlers(): ForwardHandlers {
    return {
      onMeta: (h) => this.onMeta(h),
      onChunk: (b) => this.onChunk(b),
      onEnd: () => this.onEnd(),
      onError: (h) => this.onError(h),
      onWsData: () => undefined,
      onWsClose: () => undefined,
      onTerminate: (cause) => this.onTerminate(cause),
    };
  }

  private onMeta(header: RespMetaHeader): void {
    if (this.finished || this.state !== "pending") return;
    this.status = header.status;
    this.contentType = header.contentType;
    const extra: Record<string, string> = {};
    const rid = header.headers?.["x-request-id"];
    if (rid !== undefined) extra["x-request-id"] = rid;
    const retry = header.headers?.["retry-after"];
    if (retry !== undefined) extra["retry-after"] = retry;
    this.extraHeaders = extra;
    this.state = "streaming";
    this.nullBody = NULL_BODY_STATUSES.has(header.status) || this.dropBody;
    if (this.nullBody) {
      this.resolveMeta?.(this.metaResponse(null));
      this.resolveMeta = undefined;
      return;
    }
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
        this.pump();
      },
      pull: () => this.pump(),
      cancel: () => this.clientClosed(),
    });
    this.resolveMeta?.(this.metaResponse(stream));
    this.resolveMeta = undefined;
  }

  private metaResponse(body: ReadableStream<Uint8Array> | null): Response {
    const headers: Record<string, string> = { "content-type": this.contentType, ...this.extraHeaders };
    return new Response(body, { status: this.status, headers });
  }

  private onChunk(bytes: Uint8Array): void {
    if (this.finished || this.state !== "streaming" || this.nullBody) return;
    // 接收侧兜底：待消费（已收未吐给本地客户端）超限 → ABORT + 连接错误关闭
    if (this.queuedBytes + bytes.length > this.limit) {
      this.overflow();
      return;
    }
    this.queue.push(bytes);
    this.queuedBytes += bytes.length;
    // 背压主体仍是 pull 驱动（queuedBytes 即待消费信号）；但 pull 空返回后 V8 不会
    // 重调 pull，需在有消费需求（desiredSize>0，含挂起读）时主动补驱，否则分片
    // 滞留到 onEnd 才集中投递、SSE 逐块 flush 失效。流内部队列受默认 HWM=1 约束，
    // 多搬的量有界（≤PUMP_BATCH_BYTES），不破坏 4MiB 兜底语义。
    const desired = this.controller?.desiredSize;
    if (desired !== undefined && desired !== null && desired > 0) {
      this.pump();
    }
  }

  /**
   * 搬运：把待消费队列批量移入 ReadableStream（≤PUMP_BATCH_BYTES），并对应扣减
   * queuedBytes。仅由 pull 与 onEnd 驱动——pull 由本地消费方读取触发（真实背压）。
   */
  private pump(): void {
    const controller = this.controller;
    if (controller === undefined || this.state !== "streaming") return;
    let moved = 0;
    // desiredSize≤0（流内部队列满，HWM=1 计数策略）即停——保证 queuedBytes 仍是
    // 真实待消费信号（接收侧兜底依据），同时 pull/onChunk 双驱动消除空 pull 死锁。
    while (this.queue.length > 0 && moved < PUMP_BATCH_BYTES && (controller.desiredSize ?? 0) > 0) {
      const chunk = this.queue.shift()!;
      moved += chunk.length;
      this.queuedBytes -= chunk.length;
      controller.enqueue(chunk);
    }
    if (this.ended && this.queue.length === 0 && !this.finished) {
      this.state = "done";
      this.finish();
      try {
        controller.close();
      } catch {
        // 已 cancel 的流重复 close：忽略
      }
    }
  }

  private onEnd(): void {
    if (this.finished) return;
    if (this.state === "pending") {
      // 无 RESP_META 的终结：协议异常，按 502 回敬
      this.finish();
      this.resolveMeta?.(errorResponse(502, "internal", "response ended without meta", "api_error"));
      this.resolveMeta = undefined;
      return;
    }
    this.ended = true;
    if (this.nullBody) {
      this.state = "done";
      this.finish();
      return;
    }
    this.pump();
  }

  private onError(header: { code: ErrorCodeValue; message: string }): void {
    if (this.finished) return;
    if (this.state === "pending") {
      const mapped = errorResponseFor(header.code, header.message);
      this.finish();
      if (mapped === null) {
        // 客户端等待期收到 idle_timeout/buffer_overflow/aborted：无实体语义，回 504 并关闭
        this.resolveMeta?.(errorResponse(504, header.code, header.message, "api_error"));
      } else {
        this.resolveMeta?.(mapped);
      }
      this.resolveMeta = undefined;
      return;
    }
    // 流中途 ERROR：本地连接以错误关闭（controller.error → 适配器 destroy socket）
    this.failStream();
  }

  private onTerminate(cause: TerminateCause): void {
    if (this.finished) return;
    if (cause.source === "peer") return; // 对端终结帧已由 onEnd/onError 处置
    if (this.state === "pending") {
      this.finish();
      this.resolveMeta?.(
        errorResponse(502, "upstream_unreachable", `connection lost while waiting for response: ${cause.source}`, "api_error"),
      );
      this.resolveMeta = undefined;
      return;
    }
    this.failStream();
  }

  clientClosed(): void {
    if (this.finished) return;
    this.finish();
    this.requestAbort(); // HTTP：ABORT 帧 + 本地终结
  }

  forceAbort(): void {
    if (this.finished) return;
    this.finish();
    this.requestAbort();
    this.failStream();
  }

  private overflow(): void {
    // buffer_overflow：ABORT + 本地连接错误关闭 + 记账
    this.noteOverflow(this.listener.providerId);
    this.finish();
    this.requestAbort();
    this.failStream();
  }

  /** handle 可能晚于 forward 内的同步回调就绪——就绪前挂起、就绪后补发。 */
  private requestAbort(): void {
    if (this.handle !== undefined) this.handle.abort();
    else this.abortPending = true;
  }

  /** forward 返回后由网关绑定 handle；若期间已请求中止则补发。 */
  attach(handle: ForwardHandle): void {
    this.handle = handle;
    if (this.abortPending) handle.abort();
  }

  private failStream(): void {
    const controller = this.controller;
    this.controller = undefined;
    if (controller !== undefined) {
      try {
        controller.error(new Error("gateway: local response stream failed"));
      } catch {
        // 已关闭/取消：忽略
      }
    }
  }

  private finish(): void {
    this.finished = true;
    this.listener.inflight.delete(this);
  }
}

// ---------------------------------------------------------------------------
// WS 本地流上下文（升级协商 + 双向 DATA 中继 + 双向兜底）
// ---------------------------------------------------------------------------

class WsStreamCtx implements LocalCtx {
  finished = false;
  handle: ForwardHandle | undefined;
  private abortPending: { ws: boolean; code?: number } | undefined;
  private ws: WsSocket | undefined;
  /** 本地握手完成前暂存的 DATA_DOWN 字节（计入下行缓冲上限）。 */
  private readonly pendingDown: Uint8Array[] = [];
  private pendingDownBytes = 0;
  private state: "pending" | "upgrading" | "ws" | "raw" = "pending";
  private uplinkInFlight = 0;

  constructor(
    private readonly listener: ServiceListener,
    private readonly gateway: Gateway,
    private readonly limit: number,
    private readonly noteOverflow: (providerId: string) => void,
  ) {}

  /** 升级协商所需的本地侧材料（RESP_META 到达后驱动）。 */
  beginUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): ForwardHandlers {
    this.req = req;
    this.socket = socket;
    this.head = head;
    return this.handlers();
  }

  private req: IncomingMessage | undefined;
  private socket: Duplex | undefined;
  private head: Buffer | undefined;

  handlers(): ForwardHandlers {
    return {
      onMeta: (h) => this.onMeta(h),
      onChunk: (b) => this.onRawChunk(b),
      onEnd: () => this.onRawEnd(),
      onError: (h) => this.onError(h),
      onWsData: (b) => this.onWsData(b),
      onWsClose: (code) => this.onWsClose(code),
      onTerminate: (cause) => this.onTerminate(cause),
    };
  }

  private onMeta(header: RespMetaHeader): void {
    if (this.finished || this.state !== "pending") return;
    if (header.status !== 101) {
      // 上游握手失败：按 upstream_status 语义原样回送 status 与正文（正文走 chunk 流）
      this.state = "raw";
      const ct = header.contentType;
      const rid = header.headers?.["x-request-id"];
      const head =
        `HTTP/1.1 ${header.status} ${reasonFor(header.status)}\r\ncontent-type: ${ct}\r\nconnection: close\r\n` +
        (rid !== undefined ? `x-request-id: ${rid}\r\n` : "");
      this.socket?.write(head + "\r\n");
      return;
    }
    // 101：本地握手由 ws 库按客户端 key 自算 accept（客户端校验由它保证）。上游侧
    // 因 ws 库自管握手 key（不可注入帧内 key），上游 accept 对应的是提供方 ws 客户端
    // 的 key，与本地计算值无恒等关系——不做比对（曾因该矛盾恒 destroy，§5 e2e 实证）。
    const req = this.req;
    const socket = this.socket;
    const head = this.head ?? Buffer.alloc(0);
    if (req === undefined || socket === undefined) {
      this.finish();
      return;
    }
    this.state = "upgrading";
    this.gateway.acceptWsUpgrade(req, socket, head, (ws) => this.onLocalWs(ws));
  }

  private onLocalWs(ws: WsSocket): void {
    if (this.finished) {
      ws.terminate();
      return;
    }
    this.ws = ws;
    this.state = "ws";
    if (this.head !== undefined && this.head.length > 0) {
      void this.sendData(this.head).catch(() => undefined);
      this.head = undefined;
    }
    // 升级完成前到达的 DATA_DOWN 字节按序补投
    for (const pending of this.pendingDown.splice(0)) {
      this.deliverDown(ws, pending);
    }
    ws.on("message", (data: RawData) => {
      const bytes = rawToBytes(data);
      if (this.finished) return;
      // 上行兜底：在途未确认字节超限 → ABORT + 本地终止
      if (this.uplinkInFlight + bytes.length > this.limit) {
        this.overflow();
        return;
      }
      void this.sendData(bytes).catch(() => undefined);
    });
    ws.on("close", (code: number) => {
      if (this.finished) return;
      this.finish();
      this.requestAbort({ ws: true, code }); // WS：CLOSE 帧终结
    });
    ws.on("error", () => {
      if (this.finished) return;
      this.finish();
      this.requestAbort({ ws: true });
      ws.terminate();
    });
  }

  private sendData(bytes: Uint8Array): Promise<void> {
    this.uplinkInFlight += bytes.length;
    const sent = this.handle?.sendData(bytes) ?? Promise.resolve();
    return sent.finally(() => {
      this.uplinkInFlight -= bytes.length;
    });
  }

  private onWsData(bytes: Uint8Array): void {
    if (this.finished) return;
    const ws = this.ws;
    if (ws === undefined) {
      // 本地握手未完成（handleUpgrade 异步）：暂存并计入下行缓冲（超限同规）
      if (this.state === "upgrading") {
        if (this.pendingDownBytes + bytes.length > this.limit) {
          this.overflow();
          return;
        }
        this.pendingDown.push(bytes);
        this.pendingDownBytes += bytes.length;
      }
      return;
    }
    this.deliverDown(ws, bytes);
  }

  /** 下行投递 + 本地 socket 缓冲堆积超限兜底。 */
  private deliverDown(ws: WsSocket, bytes: Uint8Array): void {
    ws.send(bytes);
    if (ws.bufferedAmount > this.limit) {
      this.overflow();
    }
  }

  private onWsClose(code: number | undefined): void {
    if (this.finished) return;
    this.finish();
    this.ws?.close(code);
  }

  private onRawChunk(bytes: Uint8Array): void {
    if (this.finished || this.state !== "raw") return;
    this.socket?.write(bytes);
  }

  private onRawEnd(): void {
    if (this.finished) return;
    this.finish();
    if (this.state === "raw") this.socket?.end();
  }

  private onError(header: { code: ErrorCodeValue; message: string }): void {
    if (this.finished) return;
    const mapped = errorResponseFor(header.code, header.message);
    if (this.state === "pending" || this.state === "upgrading") {
      this.finish();
      if (mapped === null || this.socket === undefined) this.socket?.destroy();
      else writeRawJsonError(this.socket, mapped.status, header.code, header.message);
      return;
    }
    if (this.state === "raw") {
      this.finish();
      this.socket?.destroy();
      return;
    }
    // ws 流中途错误：本地连接错误关闭
    this.finish();
    this.ws?.terminate();
  }

  private onTerminate(cause: TerminateCause): void {
    if (this.finished) return;
    if (cause.source === "peer") return;
    this.finish();
    if (this.state === "ws") this.ws?.terminate();
    else if (this.socket !== undefined && !this.socket.destroyed) this.socket.destroy();
  }

  clientClosed(): void {
    if (this.finished) return;
    this.finish();
    this.requestAbort({ ws: true });
  }

  forceAbort(): void {
    if (this.finished) return;
    this.finish();
    this.requestAbort({ ws: true });
    this.ws?.terminate();
    if (this.socket !== undefined && !this.socket.destroyed) this.socket.destroy();
  }

  private requestAbort(opts: { ws: boolean; code?: number }): void {
    if (this.handle !== undefined) {
      const o: { ws?: boolean; code?: number } = { ws: opts.ws };
      if (opts.code !== undefined) o.code = opts.code;
      this.handle.abort(o);
    } else {
      this.abortPending = { ws: opts.ws, ...(opts.code !== undefined ? { code: opts.code } : {}) };
    }
  }

  /** forward 返回后由网关绑定 handle；若期间已请求中止则补发（CLOSE/ABORT）。 */
  attach(handle: ForwardHandle): void {
    this.handle = handle;
    const pending = this.abortPending;
    if (pending !== undefined) {
      const o: { ws?: boolean; code?: number } = { ws: pending.ws };
      if (pending.code !== undefined) o.code = pending.code;
      handle.abort(o);
    }
  }

  private overflow(): void {
    this.noteOverflow(this.listener.providerId);
    this.finish();
    this.requestAbort({ ws: false }); // ABORT + buffer_overflow 语义（整请求终结）
    this.ws?.terminate();
    if (this.socket !== undefined && !this.socket.destroyed) this.socket.destroy();
  }

  private finish(): void {
    this.finished = true;
    this.listener.inflight.delete(this);
  }
}

function rawToBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(Buffer.from(data as ArrayBuffer));
}
