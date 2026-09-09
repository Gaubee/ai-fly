// ai-fly 桌面入口（C 车道 m2 §4.1，原始需求 2026-09-09）：单进程装配
// EngineHost → RpcRouter → WebServer → opentray 壳（托盘 + app-mode 主窗口）。
// 装配顺序以依赖注入形参化（assembleApp）——单测注入假件即可断言顺序/退出流/
// dev 模式，不触 GUI（test/unit/app/main.test.ts）。
// 正交意图（本文件不实现）：菜单结构与动作映射（tray-menu.ts 纯函数）；引擎
// 生命周期与事件（engine-host.ts）；HTTP/WS 与 token 门禁（web-server.ts）；
// RPC 实现（rpc-router.ts）。
// 妥协声明：opentray 壳无法拆独立文件（车道纪律限定 main.ts/tray-menu.ts）——
// 以 mountOpentrayShell 内聚 GUI 细节、动态 import 隔离原生模块（测试 import
// 本文件不加载 opentray 原生面）。

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AppIcon,
  CreateTrayHandle,
  Icon,
  OpenTrayAppLaunchOptions,
} from "opentray";
import type { WebviewTrayCapability } from "@opentray/ext-webview";
import { EngineHost, type EngineHostOptions } from "./engine-host.ts";
import type { NotifySink } from "./engine-host.ts";
import type { RpcRouterDeps } from "./rpc-router.ts";
import { createRpcRouter } from "./rpc-router.ts";
import type { WebServerOptions } from "./web-server.ts";
import { WebServer } from "./web-server.ts";
import { loadSettings } from "./settings.ts";
import { ensurePrivateDir } from "../provider/store.ts";
import { listKeyrings } from "../consumer/store.ts";
import {
  APP_ID,
  APP_NAME,
  buildTrayMenu,
  menuActionFor,
  type TrayAction,
  type TrayMenuState,
} from "./tray-menu.ts";

/** webui vite dev server 端口（webui/vite.config.ts server.port，B 车道所有）。 */
export const DEV_WEBUI_PORT = 5190;
/** dev 模式 UI daemon 固定端口（webui/vite.config.ts 的 /ws 代理目标 8790）。 */
export const DEV_SERVER_PORT = 8790;

/** 主窗口初始尺寸（resizable；app-mode 交还原生窗口管理器）。 */
const WINDOW_WIDTH = 1200;
const WINDOW_HEIGHT = 800;

/** 生成 App 图 catalog 的固定尺寸（resources/app-icons/linux/<n>x<n>/）。 */
const LINUX_ICON_SIZES = [16, 32, 48, 64, 128, 256, 512] as const;

// ---------------------------------------------------------------------------
// 日志（~/.aifly/logs/app.log，追加 + 简单分级）
// ---------------------------------------------------------------------------

export type LogLevel = "info" | "warn" | "error";

export interface AppLog {
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

/** 追加式文件日志（0700 目录语义）；warn/error 镜像 stderr，info 仅 dev 镜像。 */
export function createFileLog(logFile: string, verbose: boolean): AppLog {
  const dir = dirname(logFile);
  try {
    mkdirSync(dir, { recursive: true });
    ensurePrivateDir(dir);
  } catch {
    // 日志目录失败不挡宿主启动（后续 append 失败同样吞掉）
  }
  const write = (level: LogLevel, line: string): void => {
    const stamp = new Date().toISOString();
    try {
      appendFileSync(logFile, `${stamp} [${level}] ${line}\n`);
    } catch {
      // 日志 IO 失败不波及宿主
    }
    if (verbose || level !== "info") {
      process.stderr.write(`[aifly:${level}] ${line}\n`);
    }
  };
  return {
    info: (line) => write("info", line),
    warn: (line) => write("warn", line),
    error: (line) => write("error", line),
  };
}

// ---------------------------------------------------------------------------
// 路径与图标解析（src/app 与 dist/app 双布局同源）
// ---------------------------------------------------------------------------

const exists: (path: string) => boolean = (path) => existsSync(path);

/** 从模块目录向上找 pnpm-workspace.yaml 定位仓库根（兜底 process.cwd()）。 */
export function resolveRepoRoot(
  startDir: string,
  existsFn: (path: string) => boolean = exists,
): string {
  let dir = resolve(startDir);
  for (let hops = 0; hops < 8; hops += 1) {
    if (existsFn(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** webui 构建产物目录（AIFLY_WEBUI_DIR 可覆盖；默认 <root>/webui/dist）。 */
export function resolveWebuiDir(root: string, env: NodeJS.ProcessEnv): string {
  const override = env.AIFLY_WEBUI_DIR;
  if (override !== undefined && override !== "") {
    return isAbsolute(override) ? override : resolve(root, override);
  }
  return join(root, "webui", "dist");
}

/** App 图/tray 图生成目录（AIFLY_APP_ICONS_DIR 可覆盖；app:icons 产物）。 */
export function resolveAppIconsDir(root: string, env: NodeJS.ProcessEnv): string {
  const override = env.AIFLY_APP_ICONS_DIR;
  if (override !== undefined && override !== "") {
    return isAbsolute(override) ? override : resolve(root, override);
  }
  return join(root, "resources", "app-icons");
}

/** 生成的 App 图 catalog → opentray AppIcon 投影（缺席返回 null：非致命）。 */
export function projectAppIcon(
  iconsDir: string,
  platform: NodeJS.Platform = process.platform,
  existsFn: (path: string) => boolean = exists,
): AppIcon | null {
  if (platform === "darwin") {
    const path = join(iconsDir, "app-icon.icns");
    return existsFn(path)
      ? [
          {
            platform: "darwin",
            format: "icns",
            // 单一资产声明服务全部语义变体（深浅色由系统按 default 资产处理）
            variant: ["default", "light", "dark"],
            source: { type: "file", path },
          },
        ]
      : null;
  }
  if (platform === "win32") {
    const path = join(iconsDir, "app-icon.ico");
    return existsFn(path)
      ? [
          {
            platform: "windows",
            format: "ico",
            variant: ["default", "light", "dark"],
            source: { type: "file", path },
          },
        ]
      : null;
  }
  const assets = LINUX_ICON_SIZES.flatMap((size) => {
    const path = join(iconsDir, "linux", `${size}x${size}`, "app-icon.png");
    return existsFn(path)
      ? [
          {
            platform: "linux" as const,
            format: "png" as const,
            size,
            source: { type: "file" as const, path },
          },
        ]
      : [];
  });
  return assets.length > 0 ? assets : null;
}

/** 托盘小图标（macOS template 单色，随深浅色自适应；缺席返回 null 走文字兜底）。 */
export function resolveTrayIcon(
  iconsDir: string,
  existsFn: (path: string) => boolean = exists,
): Icon | null {
  const path = join(iconsDir, "tray-icon.png");
  if (!existsFn(path)) return null;
  return {
    "darwin-icon-only": { type: "file", path, isTemplate: true },
    "win32-icon-only": { type: "file", path },
    "linux-icon-only": { type: "file", path },
  };
}

// ---------------------------------------------------------------------------
// 启动策略（纯函数：host 按数据目录现状拉起双角色）
// ---------------------------------------------------------------------------

export interface InitialRoles {
  provider: boolean;
  gateway: boolean;
}

/**
 * 冷启角色策略：提供方数据目录存在 → 拉起提供方 daemon；消费侧存在已导入
 * 钥环 → 拉起本地网关（spec app/shell「冷启直达」）。全新安装两者皆不起，
 * 由 UI 向导引导。
 */
export function planInitialRoles(
  input: { providerDataDir: string; consumersRoot: string },
  tools: { exists: (p: string) => boolean; hasKeyrings: (root: string) => boolean },
): InitialRoles {
  return {
    provider: tools.exists(input.providerDataDir),
    gateway: tools.hasKeyrings(input.consumersRoot),
  };
}

function hasKeyringsOnDisk(root: string): boolean {
  try {
    return listKeyrings(root).rings.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 装配（依赖注入形参化：顺序/退出流/dev 模式可单测，不触 GUI）
// ---------------------------------------------------------------------------

/** opentray 壳的消费面（真实现 = mountOpentrayShell；测试假件零成本满足）。 */
export interface ShellLike {
  /** host 运行态变化后重推菜单（勾选态反映 host 真相）。 */
  refreshMenu(): void;
  /** 主项动作：可见 → close()（隐藏保留 session）；隐藏 → toVisible()+focus()。 */
  openOrToggle(): Promise<void>;
  /** 窗口与托盘销毁（退出路径；各步独立容错）。 */
  destroy(): Promise<void>;
}

export interface ShellDeps {
  /** 主窗口入口（一次性 token 已内建）。 */
  url: string;
  dev: boolean;
  appIcon: AppIcon | null;
  appLaunch: OpenTrayAppLaunchOptions;
  /** host 运行态投影（窗口可见性由壳内部持有：visibleChange 是唯一真相）。 */
  hostState(): { providerRunning: boolean; gatewayRunning: boolean };
  onAction(action: TrayAction): void;
  log: AppLog;
}

export interface AppDeps {
  log: AppLog;
  /** 数据根（默认 os.homedir()；测试注入临时目录）。 */
  home?: string;
  /** 进程环境（默认 process.env；测试注入 AIFLY_APP_DEV / AIFLY_WEBUI_DIR 等）。 */
  env?: NodeJS.ProcessEnv;
  createHost(opts: EngineHostOptions): EngineHost;
  createRouter(deps: RpcRouterDeps): WebServerOptions["router"];
  createServer(opts: WebServerOptions): WebServer;
  mountShell(deps: ShellDeps): Promise<ShellLike | null>;
  exit(code: number): void;
}

export interface AppHandles {
  host: EngineHost;
  webServer: WebServer;
  shell: ShellLike | null;
  port: number;
  /** 带 token 的 UI 入口（私有日志/无壳兜底用；token 一次性）。 */
  uiUrl: string;
  dev: boolean;
  quit(): Promise<void>;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 读根 package.json 版本（缺席兜底；仅作 opentray 运行时状态目录版本源）。 */
function readPackageVersion(root: string): string {
  try {
    const raw = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof raw.version === "string" ? raw.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * 桌面壳装配（顺序即契约）：
 * EngineHost（notify 闭包转发）→ RpcRouter → WebServer（notify 回绑）→
 * start（dev 固定 8790 对齐 vite 代理；产线随机）→ 按数据目录现状拉起双角色 →
 * 签发一次性 token URL → opentray 壳（托盘 + app-mode 主窗口）。
 */
export async function assembleApp(deps: AppDeps): Promise<AppHandles> {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const dev = env.AIFLY_APP_DEV === "1";
  const log = deps.log;
  const root = resolveRepoRoot(dirname(fileURLToPath(import.meta.url)));
  const webuiDir = resolveWebuiDir(root, env);
  const settings = loadSettings(home);

  // [1] EngineHost —— notify 先经闭包转发（WebServer 构造在后，装配顺序先行）
  let push: NotifySink = () => undefined;
  const host = deps.createHost({
    home,
    ...(settings.relayUrls !== null ? { relayUrls: settings.relayUrls } : {}),
    notify: (event) => push(event),
  });

  // [2] RPC router（契约 → 引擎宿主）
  const router = deps.createRouter({ host, home });

  // [3] WebServer（构造后回绑 notify：引擎事件直达 ws 订阅者）
  const webServer = deps.createServer({ webuiDir, router });
  push = webServer.notify;

  // [4] 启动 UI 服务：AIFLY_APP_PORT 显式固定 > dev 固定 8790（对齐 vite /ws
  // 代理目标）> 产线随机环回口
  const configured = Number.parseInt(env.AIFLY_APP_PORT ?? "", 10);
  const wantedPort =
    Number.isInteger(configured) && configured > 0 ? configured : dev ? DEV_SERVER_PORT : 0;
  const port = await webServer.start(wantedPort);
  log.info(`ui server listening on 127.0.0.1:${port} (webui: ${webuiDir})`);

  // [5] 冷启角色策略（失败不挡 UI：托盘仍可手动开关）
  const roles = planInitialRoles(
    { providerDataDir: host.providerDataDir, consumersRoot: host.consumersRoot },
    { exists, hasKeyrings: hasKeyringsOnDisk },
  );
  if (roles.provider) {
    await host.startProvider().catch((error: unknown) => {
      log.error(`provider autostart failed: ${errorMessage(error)}`);
    });
  }
  if (roles.gateway) {
    await host.startGateway().catch((error: unknown) => {
      log.error(`gateway autostart failed: ${errorMessage(error)}`);
    });
  }

  // [6] 主窗口入口：dev → vite dev server（token 仍由本服务签发，前端经 /ws
  // 代理兑换）；产线 → uiUrl（token 一次性，HttpOnly 会话承接）
  const token = webServer.issueUiToken();
  const uiUrl = dev
    ? `http://127.0.0.1:${DEV_WEBUI_PORT}/?token=${encodeURIComponent(token)}`
    : webServer.uiUrl(port, token);

  // 退出流（优雅：host stop（M1 幂等）→ webServer stop → 托盘销毁 → exit 0）
  let quitting = false;
  let shellRef: ShellLike | null = null;
  const quit = async (): Promise<void> => {
    if (quitting) return;
    quitting = true;
    try {
      await host.stop();
    } catch (error) {
      log.error(`host stop failed: ${errorMessage(error)}`);
    }
    try {
      await webServer.stop();
    } catch (error) {
      log.error(`ui server stop failed: ${errorMessage(error)}`);
    }
    try {
      await shellRef?.destroy();
    } catch (error) {
      log.error(`shell destroy failed: ${errorMessage(error)}`);
    }
    log.info("ai-fly exited cleanly");
    deps.exit(0);
  };

  const toggleProvider = async (): Promise<void> => {
    try {
      if (host.isProviderRunning()) await host.stopProvider();
      else await host.startProvider();
    } catch (error) {
      log.error(`provider toggle failed: ${errorMessage(error)}`);
    }
  };
  const toggleGateway = async (): Promise<void> => {
    try {
      if (host.isGatewayRunning()) await host.stopGateway();
      else await host.startGateway();
    } catch (error) {
      log.error(`gateway toggle failed: ${errorMessage(error)}`);
    }
  };

  // [7] opentray 壳（AIFLY_APP_NO_TRAY=1 跳过：CI/无显示面回归）
  const appLaunch: OpenTrayAppLaunchOptions = {
    command: process.execPath,
    args: dev ? ["--import", "tsx", fileURLToPath(import.meta.url)] : [fileURLToPath(import.meta.url)],
    cwd: root,
  };
  const shell =
    env.AIFLY_APP_NO_TRAY === "1"
      ? null
      : await deps.mountShell({
          url: uiUrl,
          dev,
          appIcon: projectAppIcon(resolveAppIconsDir(root, env)),
          appLaunch,
          hostState: () => ({
            providerRunning: host.isProviderRunning(),
            gatewayRunning: host.isGatewayRunning(),
          }),
          onAction: (action) => {
            switch (action) {
              case "open-toggle":
                void shellRef?.openOrToggle();
                break;
              case "provider-toggle":
                void toggleProvider();
                break;
              case "consumer-toggle":
                void toggleGateway();
                break;
              case "quit":
                void quit();
                break;
            }
          },
          log,
        });
  shellRef = shell;

  // 引擎事件 → 菜单勾选态刷新（通知仅触发器；host 查询是真相源）
  webServer.subscribe((event) => {
    if (event.type === "provider-daemon" || event.type === "consumer-gateway") {
      shellRef?.refreshMenu();
    }
  });

  if (shell === null) {
    log.warn(`running headless (no tray) - ui: ${uiUrl}`);
  } else {
    log.info(`tray + app window ready (v${readPackageVersion(root)})`);
    log.info(`ui entry (one-time token): ${uiUrl}`);
  }

  return { host, webServer, shell, port, uiUrl, dev, quit };
}

// ---------------------------------------------------------------------------
// opentray 壳（GUI 细节内聚于此；动态 import 隔离原生模块）
// ---------------------------------------------------------------------------

/** 已扩展 WebView 能力的托盘句柄（skill-creator-v2 同款投影）。 */
type OpentrayWebviewTray = CreateTrayHandle & WebviewTrayCapability;

/**
 * 挂载托盘 + app-mode 主窗口（skill-creator-v2 tray-host 同款法则）：
 * - 单 retained session：首 show() 引导，此后 toVisible()/close() 复用，绝不
 *   重放启动宽高/style；
 * - isVisible()/visibleChange 是可见性唯一真相（含最小化），驱动主项文案；
 * - 窗口操作串行化（快速托盘点击不得反转 stale 状态）；
 * - Dock 温启 reopen 由 ext-webview 对 bootstrapped app-mode 窗口的默认策略
 *   处理（app-mode.md：MRU 候选 → toVisible → focus）；冷启走 appLaunch 向量。
 * 挂载失败返回 null（headless 降级：托盘是 UX 加成，UI 服务仍可用）。
 */
export async function mountOpentrayShell(deps: ShellDeps): Promise<ShellLike | null> {
  let windowVisible = true; // show() 成功即引导为可见
  let windowOps: Promise<void> = Promise.resolve();
  try {
    const [opentray, ext] = await Promise.all([
      import("opentray"),
      import("@opentray/ext-webview"),
    ]);

    const root = resolveRepoRoot(dirname(fileURLToPath(import.meta.url)));
    const iconsDir = resolveAppIconsDir(root, process.env);
    const trayIcon = resolveTrayIcon(iconsDir);
    const menu = (): TrayMenuState => ({ ...deps.hostState(), windowVisible });

    const tray: OpentrayWebviewTray = (await opentray.createTray(
      {
        id: APP_ID,
        tooltip: { title: APP_NAME, description: "Peer-to-peer AI bridge" },
        menu: buildTrayMenu(menu()),
        ...(trayIcon !== null
          ? { icon: trayIcon }
          : { icon: { "text-only": APP_NAME } satisfies Icon }),
      },
      {
        appId: APP_ID,
        appName: APP_NAME,
        packageVersion: readPackageVersion(root),
        ...(deps.appIcon !== null ? { appIcon: deps.appIcon } : {}),
        appLaunch: deps.appLaunch,
      },
    )).extend(ext.WebviewExt);

    const win = tray.createWebviewWindow({
      url: deps.url,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      title: APP_NAME,
      nativeWindowApi: true,
      // macOS 以原生 overlay 控件压在 WebUI 标题栏上；Windows 保留原生边框
      windowControlsOverlay: process.platform !== "win32",
      ...(deps.dev ? { devtools: true } : {}),
      style: {
        appMode: true,
        frameless: false,
        resizable: true,
        autoHide: false,
      },
    });
    await win.show();

    win.listen("visibleChange", ({ payload }) => {
      windowVisible = payload.visible;
      void tray.setMenu(buildTrayMenu(menu())).catch(() => undefined);
    });
    tray.onMenuClick(({ itemId }) => {
      const action = menuActionFor(itemId);
      if (action !== null) deps.onAction(action);
    });

    const pushMenu = (): void => {
      void tray.setMenu(buildTrayMenu(menu())).catch((error: unknown) => {
        deps.log.warn(`setMenu failed: ${errorMessage(error)}`);
      });
    };
    const enqueue = (label: string, operation: () => Promise<void>): Promise<void> => {
      windowOps = windowOps.then(async () => {
        try {
          await operation();
        } catch (error) {
          deps.log.warn(`${label} failed: ${errorMessage(error)}`);
        }
      });
      return windowOps;
    };

    deps.log.info("opentray webview window mounted");
    return {
      refreshMenu: pushMenu,
      openOrToggle: () =>
        enqueue("toggle window", async () => {
          const visible = await win.isVisible().catch(() => windowVisible);
          if (visible) {
            await win.close(); // 隐藏保留 session（页面运行时存活）
            windowVisible = false;
          } else {
            await win.toVisible();
            await win.focus();
            windowVisible = true;
          }
          pushMenu();
        }),
      destroy: async () => {
        try {
          await windowOps;
        } catch {
          // 排队操作已被 enqueue 吞错
        }
        try {
          await win.destroy();
        } catch {
          // 原生回收缺口：退出不因此失败
        }
        try {
          await tray.destroy();
        } catch {
          // 同上
        }
      },
    };
  } catch (error) {
    deps.log.error(`tray mount failed (${errorMessage(error)}) - continuing headless`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 进程入口
// ---------------------------------------------------------------------------

/** 真实入口：装配 + 进程级异常/信号接线（宿主异常不静默）。 */
export async function main(): Promise<void> {
  const log = createFileLog(join(homedir(), ".aifly", "logs", "app.log"), process.env.AIFLY_APP_DEV === "1");
  const handles = await assembleApp({
    log,
    createHost: (opts) => new EngineHost(opts),
    createRouter: (deps) => createRpcRouter(deps),
    createServer: (opts) => new WebServer(opts),
    mountShell: mountOpentrayShell,
    exit: (code) => process.exit(code),
  });
  process.on("uncaughtException", (error) => {
    log.error(`uncaught exception: ${error.stack ?? error.message}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log.error(`unhandled rejection: ${errorMessage(reason)}`);
  });
  process.on("SIGINT", () => void handles.quit());
  process.on("SIGTERM", () => void handles.quit());
}

/** 仅在作为进程主模块执行时启动（import 冒烟/单测不触发 GUI）。 */
function invokedAsMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  void main();
}
