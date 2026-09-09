// UI daemon 的 HTTP/WS 服务（A3 五件套，架构照抄 skill-creator-v2 的
// src/daemon/web-server.ts，含其生产坑修复）：
//   [1] `/`：webui/dist 静态托管 + SPA 回退 index.html；dist 缺席时返回指引页。
//   [2] token 门禁：issueUiToken() 一次性（用后即焚，重复使用被拒）——首次以
//       ?token= 携带访问时兑换为 HttpOnly 会话 cookie（后续静态与 ws 升级凭
//       cookie）；无 token 且无会话的本机浏览器只得到指引页。
//   [3] `/ws/rpc`：orpc over ws（RPCHandler.upgrade）。
//   [4] `/ws/notify`：裸 JSON 推送 {type, payload}（通知仅为触发器）。
//   [5] guardRpcSocket：oRPC ws 适配器对畸形帧会抛未捕获 rejection
//       （@orpc/server 1.14.6 实测，见 skill-creator-v2 生产坑注释）——以 Proxy
//       包一层，message 监听器同步异常吞掉、返回的 Promise rejection 兜底，
//       畸形帧只断开该连接，不打穿进程。业务过程错误仍由 oRPC 协议面自报。

import { existsSync, promises as fs } from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { RPCHandler } from "@orpc/server/ws";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";
import type { NotifyEvent, NotifySink } from "./engine-host.ts";

/** WebServer 启动配置。 */
export interface WebServerOptions {
  /** webui 构建产物目录（webui/dist）。 */
  webuiDir: string;
  /** orpc router（createRpcRouter 产物）。 */
  router: ConstructorParameters<typeof RPCHandler>[0];
}

/** 停止宽限。 */
export interface WebServerStopOptions {
  graceMs?: number;
}

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg; charset=utf-8",
  ".jpeg": "image/jpeg; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

const SESSION_COOKIE = "aifly_ui_session";

/**
 * guardRpcSocket（skill-creator-v2 生产坑修复原样搬运）：畸形帧只断该连接。
 */
function guardRpcSocket(websocket: WsWebSocket): WsWebSocket {
  const wrapListener = (listener: (...args: unknown[]) => unknown) => {
    return (...args: unknown[]): void => {
      try {
        const result = listener(...args);
        if (result instanceof Promise) {
          result.catch(() => {
            // 异步反序列化失败（实测路径）：断开该连接而非击穿进程。
            try {
              websocket.close();
            } catch {
              // 已断开：无操作。
            }
          });
        }
      } catch {
        try {
          websocket.close();
        } catch {
          // 已断开：无操作。
        }
      }
    };
  };
  return new Proxy(websocket, {
    get(target, property, receiver) {
      if (property === "on" || property === "once" || property === "addEventListener") {
        return (event: string, listener: (...args: unknown[]) => unknown, ...rest: unknown[]) => {
          const wrapped =
            event === "message" && typeof listener === "function" ? wrapListener(listener) : listener;
          const register = Reflect.get(target, property, receiver) as unknown as (
            ...callArgs: unknown[]
          ) => unknown;
          return register.call(target, event, wrapped, ...rest);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** 单生命周期地承载 webui 静态服务、token 门禁与两条 ws 通道。 */
export class WebServer {
  private server?: http.Server | undefined;
  private stopPromise?: Promise<void> | undefined;
  private readonly connections = new Set<Socket>();
  private readonly rpcWsServer = new WebSocketServer({ noServer: true });
  private readonly notifyWsServer = new WebSocketServer({ noServer: true });
  private readonly rpcHandler: RPCHandler<Record<never, never>>;
  /** 已签发未消费的一次性 token。 */
  private readonly pendingTokens = new Set<string>();
  /** 已建立的会话 cookie 值。 */
  private readonly sessions = new Set<string>();
  private readonly notifyListeners = new Set<NotifySink>();

  constructor(private readonly options: WebServerOptions) {
    this.rpcHandler = new RPCHandler(options.router);
  }

  // -------------------------------------------------------------------------
  // token 与会话
  // -------------------------------------------------------------------------

  /** 签发一次性 UI token（宿主进程注入 webview URL；用后即焚）。 */
  issueUiToken(): string {
    const token = randomBytes(24).toString("base64url");
    this.pendingTokens.add(token);
    return token;
  }

  /** 带一次性 token 的 webview 入口 URL。 */
  uiUrl(port: number, token = this.issueUiToken()): string {
    return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
  }

  /** 脱敏形态（日志用）。 */
  uiUrlRedacted(port: number): string {
    return `http://127.0.0.1:${port}/?token=<redacted>`;
  }

  /** 消费一次性 token：有效则建立会话并返回 cookie 值，无效/已用返回 null。 */
  private consumeToken(token: string): string | null {
    if (!this.pendingTokens.delete(token)) return null;
    const session = randomBytes(24).toString("base64url");
    this.sessions.add(session);
    return session;
  }

  private sessionFromRequest(request: http.IncomingMessage): string | null {
    const header = request.headers.cookie;
    if (typeof header !== "string") return null;
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === SESSION_COOKIE) {
        const value = part.slice(eq + 1).trim();
        return this.sessions.has(value) ? value : null;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 通知面（engine-host 桥接）
  // -------------------------------------------------------------------------

  /** 对外通知出口：推给全部 /ws/notify 订阅者与进程内订阅者。 */
  readonly notify: NotifySink = (event: NotifyEvent): void => {
    const message = JSON.stringify(event);
    for (const client of this.notifyWsServer.clients) {
      const ws = client as WsWebSocket;
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(message);
        } catch {
          // 单客户端发送失败：忽略
        }
      }
    }
    for (const listener of this.notifyListeners) {
      try {
        listener(event);
      } catch {
        // 订阅者异常不波及服务
      }
    }
  };

  /** 进程内订阅（返回取消函数）。 */
  subscribe(listener: NotifySink): () => void {
    this.notifyListeners.add(listener);
    return () => this.notifyListeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /** 启动环回服务，返回实际监听端口。 */
  start(port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this.handleHttp(request, response);
      });
      server.on("connection", (connection) => {
        this.connections.add(connection);
        connection.once("close", () => this.connections.delete(connection));
      });
      server.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        this.server = server;
        this.stopPromise = undefined;
        resolve(typeof address === "object" && address ? address.port : port);
      });
    });
  }

  /** 关闭全部客户端与 HTTP 服务（带宽限强制收口）。 */
  stop(options: WebServerStopOptions = {}): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.server) return Promise.resolve();
    const server = this.server;
    this.server = undefined;
    const graceMs = Math.max(0, options.graceMs ?? 1_000);
    this.stopPromise = new Promise<void>((resolve, reject) => {
      let serverClosed = false;
      let rpcWsClosed = false;
      let notifyWsClosed = false;
      let closeError: Error | undefined;
      let settled = false;
      const finishIfClosed = (): void => {
        if (settled || !serverClosed || !rpcWsClosed || !notifyWsClosed || this.connections.size > 0) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (closeError) reject(closeError);
        else resolve();
      };
      const forceClose = (): void => {
        for (const client of this.rpcWsServer.clients) client.terminate();
        for (const client of this.notifyWsServer.clients) client.terminate();
        for (const connection of this.connections) connection.destroy();
        server.closeAllConnections();
      };
      const timer = setTimeout(forceClose, graceMs);
      timer.unref();

      try {
        server.close((error) => {
          serverClosed = true;
          closeError ??= error;
          finishIfClosed();
        });
      } catch (error) {
        serverClosed = true;
        closeError = error instanceof Error ? error : new Error(String(error));
      }
      this.rpcWsServer.close((error) => {
        rpcWsClosed = true;
        closeError ??= error;
        finishIfClosed();
      });
      this.notifyWsServer.close((error) => {
        notifyWsClosed = true;
        closeError ??= error;
        finishIfClosed();
      });
      for (const connection of this.connections) connection.once("close", finishIfClosed);
      for (const client of this.rpcWsServer.clients) {
        try {
          client.close(1001, "Server shutting down");
        } catch (error) {
          closeError ??= error instanceof Error ? error : new Error(String(error));
          client.terminate();
        }
      }
      for (const client of this.notifyWsServer.clients) {
        try {
          client.close(1001, "Server shutting down");
        } catch (error) {
          closeError ??= error instanceof Error ? error : new Error(String(error));
          client.terminate();
        }
      }
      if (graceMs === 0 || closeError) {
        forceClose();
        finishIfClosed();
      }
    });
    return this.stopPromise;
  }

  // -------------------------------------------------------------------------
  // HTTP：token 兑换 + 静态托管（SPA 回退 / 指引页）
  // -------------------------------------------------------------------------

  private async handleHttp(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const token = url.searchParams.get("token");
      if (token !== null) {
        // 一次性 token 兑换：有效 → 会话 cookie + 转净址；无效/已用 → 指引页
        const session = this.consumeToken(token);
        if (session === null) {
          this.serveGuidancePage(response, "The link token is invalid or was already used.");
          return;
        }
        response.writeHead(303, {
          "set-cookie": `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Strict`,
          location: "/",
        });
        response.end();
        return;
      }
      if (this.sessionFromRequest(request) === null) {
        // 本机浏览器直连（无 token 无会话）：仅指引页
        this.serveGuidancePage(response, undefined);
        return;
      }
      if (request.method !== undefined && request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { "content-type": "text/plain; charset=utf-8" }).end("method not allowed");
        return;
      }
      await this.serveStatic(response, url.pathname, request.method === "HEAD");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(`internal error: ${message}`);
    }
  }

  /** 指引页（说明这是桌面应用附带的 UI；附额外说明行）。 */
  private serveGuidancePage(response: http.ServerResponse, extraLine: string | undefined): void {
    const lines = [
      "<!doctype html>",
      '<html lang="en"><head><meta charset="utf-8"><title>ai-fly</title></head>',
      "<body style=\"font-family: ui-monospace, monospace; padding: 2rem; max-width: 40rem;\">",
      "<h1>ai-fly desktop UI</h1>",
      "<p>This UI is served by the local ai-fly desktop app and is intended to be opened from its window.</p>",
      "<p>Start the app (tray) and open the main window from the tray menu.</p>",
    ];
    if (extraLine !== undefined) {
      lines.push(`<p>${extraLine.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`);
    }
    lines.push("</body></html>");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(lines.join("\n"));
  }

  private async serveStatic(
    response: http.ServerResponse,
    pathname: string,
    head: boolean,
  ): Promise<void> {
    const root = path.resolve(this.options.webuiDir);
    if (!existsSync(root)) {
      this.serveGuidancePage(
        response,
        "webui build output was not found; build it with `pnpm -r build` (expects webui/dist).",
      );
      return;
    }
    let relativePath = decodeURIComponent(pathname.slice(1));
    if (!relativePath || relativePath.endsWith("/")) relativePath += "index.html";
    let file = path.resolve(root, relativePath);
    if (path.relative(root, file).startsWith("..")) {
      response.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || !file.startsWith(root + path.sep)) file = path.join(root, "index.html"); // SPA 回退
    if (!existsSync(file)) {
      response.writeHead(404).end("not found");
      return;
    }
    const extension = path.extname(file);
    const data = await fs.readFile(file);
    response.writeHead(200, {
      "content-type": MIME[extension] ?? "application/octet-stream",
      "cache-control": extension === ".html" ? "no-cache" : "public, max-age=3600",
    });
    if (head) {
      response.end();
      return;
    }
    response.end(data);
  }

  // -------------------------------------------------------------------------
  // ws 升级：/ws/rpc（orpc）与 /ws/notify（裸 JSON 推送）
  // -------------------------------------------------------------------------

  private handleUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/ws/rpc") {
      if (!this.authorizeWs(request, url)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      this.rpcWsServer.handleUpgrade(request, socket, head, (websocket) => {
        void this.rpcHandler
          .upgrade(guardRpcSocket(websocket), { context: {} })
          .catch(() => {
            websocket.close();
          });
      });
      return;
    }
    if (url.pathname === "/ws/notify") {
      if (!this.authorizeWs(request, url)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      this.notifyWsServer.handleUpgrade(request, socket, head, (websocket) => {
        // 通知通道只下行；上行帧一律忽略（畸形上行不影响进程）
        websocket.on("message", () => undefined);
      });
      return;
    }
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  }

  /** ws 鉴权：会话 cookie 或一次性 token（用后即焚）。 */
  private authorizeWs(request: http.IncomingMessage, url: URL): boolean {
    if (this.sessionFromRequest(request) !== null) return true;
    const token = url.searchParams.get("token");
    if (token === null) return false;
    const session = this.consumeToken(token);
    if (session === null) return false;
    this.sessions.add(session); // token 换会话：后续重连凭 cookie
    return true;
  }
}
