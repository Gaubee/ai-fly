// 桌面入口装配单测（C 车道 m2 §4.4）：assembleApp 以依赖注入形参化——真
// EngineHost/WebServer（临时 home/webui fixture，不起引擎不起 GUI）+ 假壳/
// 假 exit，断言：
// - 装配顺序契约（host → router → server → start → 角色策略 → shell）；
// - notify 链（host 事件 → webServer → shell.refreshMenu 菜单勾选刷新）；
// - 退出流（host stop → server stop → shell destroy → exit 0；幂等不重入）；
// - dev 模式（AIFLY_APP_DEV=1：固定 8790 对齐 vite 代理 + 5190 入口 URL）；
// - 冷启角色策略 planInitialRoles（数据目录现状）与路径/图标纯解析函数。

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FabricFactory } from "../../../src/consumer/providers.ts";
import { EngineHost } from "../../../src/app/engine-host.ts";
import type { EngineHostOptions } from "../../../src/app/engine-host.ts";
import { createRpcRouter } from "../../../src/app/rpc-router.ts";
import type { RpcRouterDeps } from "../../../src/app/rpc-router.ts";
import { WebServer } from "../../../src/app/web-server.ts";
import type { WebServerOptions } from "../../../src/app/web-server.ts";
import {
  DEV_SERVER_PORT,
  DEV_WEBUI_PORT,
  assembleApp,
  planInitialRoles,
  projectAppIcon,
  resolveAppIconsDir,
  resolveTrayIcon,
  resolveWebuiDir,
  type AppHandles,
  type AppLog,
  type ShellDeps,
  type ShellLike,
} from "../../../src/app/main.ts";
import { APP_ID, APP_NAME } from "../../../src/app/tray-menu.ts";

const silentLog: AppLog = { info: () => undefined, warn: () => undefined, error: () => undefined };
const here = fileURLToPath(new URL(".", import.meta.url));

/** 临时 home + webui fixture（与 web-server.test 同款形态）。 */
function makeFixture(): { home: string; webuiDir: string } {
  const home = mkdtempSync(join(tmpdir(), "aifly-main-"));
  mkdirSync(join(home, ".aifly"), { recursive: true });
  writeFileSync(
    join(home, ".aifly", "settings.json"),
    JSON.stringify({ theme: "system", modelsDevEnabled: false, relayUrls: null }),
  );
  const webuiDir = join(home, "webui-dist");
  mkdirSync(webuiDir, { recursive: true });
  writeFileSync(join(webuiDir, "index.html"), "<html>fixture</html>");
  return { home, webuiDir };
}

interface FakeShell extends ShellLike {
  refreshes: number;
  destroyed: number;
}

const fakeShell = (): FakeShell => {
  const shell: FakeShell = {
    refreshes: 0,
    destroyed: 0,
    refreshMenu: () => {
      shell.refreshes += 1;
    },
    openOrToggle: async () => undefined,
    destroy: async () => {
      shell.destroyed += 1;
    },
  };
  return shell;
};

interface MountRecord {
  deps: ShellDeps;
}

const orders: string[] = [];
const mounts: MountRecord[] = [];
const exits: number[] = [];
const hostOptions: EngineHostOptions[] = [];
let handlesList: AppHandles[] = [];

const mount = async (deps: ShellDeps): Promise<ShellLike | null> => {
  mounts.push({ deps });
  orders.push("shell");
  return fakeShell();
};

beforeEach(() => {
  orders.length = 0;
  mounts.length = 0;
  exits.length = 0;
  hostOptions.length = 0;
  handlesList = [];
});

afterEach(async () => {
  // 假 exit 使进程存活：此处补真实资源回收
  await Promise.all(handlesList.map((h) => h.webServer.stop().catch(() => undefined)));
  handlesList = [];
});

/** 以记录包装件装配一次（产线模式）。 */
async function assemble(env: NodeJS.ProcessEnv = {}): Promise<AppHandles> {
  const { home, webuiDir } = makeFixture();
  const host = (opts: EngineHostOptions): EngineHost => {
    orders.push("host");
    hostOptions.push(opts);
    return new EngineHost({
      ...opts,
      fabricFactory: {} as FabricFactory, // 免真实 SDK
    });
  };
  const handles = await assembleApp({
    log: silentLog,
    home,
    env: { AIFLY_WEBUI_DIR: webuiDir, ...env },
    createHost: host,
    createRouter: (deps: RpcRouterDeps) => {
      orders.push("router");
      return createRpcRouter(deps);
    },
    createServer: (opts: WebServerOptions) => {
      orders.push("server");
      return new WebServer(opts);
    },
    mountShell: mount,
    exit: (code) => {
      exits.push(code);
      orders.push("exit");
    },
  });
  handlesList.push(handles);
  return handles;
}

describe("assembleApp 装配顺序与接线", () => {
  it("顺序契约：host → router → server → shell；notify 闭包在 server 构造后回绑", async () => {
    const handles = await assemble();
    expect(orders).toEqual(["host", "router", "server", "shell"]);
    // EngineHost 收到 notify 下沉与 home（relayUrls 缺省不传）
    expect(hostOptions[0]?.notify).toBeTypeOf("function");
    expect(hostOptions[0]?.home).toBeDefined();
    // shell 收到 token 化产线入口；appLaunch.cwd 为仓库根（含 pnpm-workspace.yaml）
    expect(mounts[0]?.deps.url).toBe(handles.uiUrl);
    const cwd = mounts[0]?.deps.appLaunch.cwd ?? "";
    expect(existsSync(join(cwd, "pnpm-workspace.yaml"))).toBe(true);
    expect(handles.port).toBeGreaterThan(0);
    expect(handles.dev).toBe(false);
  });

  it("notify 链：host 事件 → webServer 广播 → shell.refreshMenu（菜单勾选刷新）", async () => {
    const handles = await assemble();
    const shell = handles.shell as FakeShell;
    expect(shell.refreshes).toBe(0);
    // stopProvider 幂等触发 provider-daemon{running:false} 通知
    await handles.host.stopProvider();
    expect(shell.refreshes).toBe(1);
    await handles.host.stopGateway();
    expect(shell.refreshes).toBe(2);
  });

  it("退出流：quit 动作 → host/server stop → shell destroy → exit 0，且不重入", async () => {
    const handles = await assemble();
    const shell = handles.shell as FakeShell;
    const port = handles.port;
    mounts[0]?.deps.onAction("quit");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(exits).toEqual([0]);
    expect(shell.destroyed).toBe(1);
    // 服务确实关闭（端口不可达）
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    // 幂等：重复 quit 不再 exit
    await handles.quit();
    expect(exits).toEqual([0]);
    expect(shell.destroyed).toBe(1);
  });

  it("dev 模式：固定 8790（对齐 vite /ws 代理）+ 入口指向 vite dev server（5190）", async () => {
    const handles = await assemble({ AIFLY_APP_DEV: "1" });
    expect(handles.dev).toBe(true);
    expect(handles.port).toBe(DEV_SERVER_PORT);
    expect(handles.uiUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${DEV_WEBUI_PORT}/\\?token=.+`));
    // 冷启 appLaunch 向量：node --import tsx <src 入口>（dev 重建全图）
    expect(mounts[0]?.deps.appLaunch.args).toEqual([
      "--import",
      "tsx",
      expect.stringContaining("src/app/main.ts"),
    ]);
    // 产线对照：args 直接是入口绝对路径
    const prod = await assemble();
    expect(mounts[1]?.deps.appLaunch.args).toEqual([expect.stringContaining("main.ts")]);
    expect((mounts[1]?.deps.appLaunch.args ?? []).join(" ")).not.toContain("--import");
  });

  it("AIFLY_APP_NO_TRAY=1：跳过壳挂载（headless 回归向量），UI 服务仍就绪", async () => {
    const handles = await assemble({ AIFLY_APP_NO_TRAY: "1" });
    expect(handles.shell).toBeNull();
    expect(mounts.length).toBe(0);
    expect(handles.port).toBeGreaterThan(0);
  });
});

describe("planInitialRoles 冷启角色策略", () => {
  const tools = {
    exists: (p: string) => p === "/home/x/.aifly/provider",
    hasKeyrings: (_root: string) => false,
  };

  it("全新安装：双角色皆不起（UI 向导引导）", () => {
    expect(
      planInitialRoles(
        { providerDataDir: "/none/provider", consumersRoot: "/none/consumers" },
        { exists: () => false, hasKeyrings: () => false },
      ),
    ).toEqual({ provider: false, gateway: false });
  });

  it("提供方数据目录存在 → 拉起提供方", () => {
    expect(
      planInitialRoles({ providerDataDir: "/home/x/.aifly/provider", consumersRoot: "/none" }, tools),
    ).toEqual({ provider: true, gateway: false });
  });

  it("消费侧存在已导入钥环 → 拉起网关", () => {
    expect(
      planInitialRoles(
        { providerDataDir: "/none", consumersRoot: "/home/x/.aifly/consumers" },
        { exists: () => false, hasKeyrings: (root) => root === "/home/x/.aifly/consumers" },
      ),
    ).toEqual({ provider: false, gateway: true });
  });
});

describe("路径与图标解析（纯函数）", () => {
  it("resolveWebuiDir：默认 <root>/webui/dist；AIFLY_WEBUI_DIR 覆盖（相对/绝对）", () => {
    expect(resolveWebuiDir("/repo", {})).toBe(join("/repo", "webui", "dist"));
    expect(resolveWebuiDir("/repo", { AIFLY_WEBUI_DIR: "/tmp/w" })).toBe("/tmp/w");
    expect(resolveWebuiDir("/repo", { AIFLY_WEBUI_DIR: "alt/w" })).toBe(join("/repo", "alt", "w"));
  });

  it("resolveAppIconsDir：默认 resources/app-icons；env 覆盖", () => {
    expect(resolveAppIconsDir("/repo", {})).toBe(join("/repo", "resources", "app-icons"));
    expect(resolveAppIconsDir("/repo", { AIFLY_APP_ICONS_DIR: "/tmp/icons" })).toBe("/tmp/icons");
  });

  it("projectAppIcon：darwin 取 icns（多语义变体）；缺席返回 null", () => {
    const icons = join(here, "..", "..", "..", "resources", "app-icons");
    const icon = projectAppIcon(icons, "darwin");
    expect(icon).not.toBeNull();
    expect(icon?.[0]).toMatchObject({
      platform: "darwin",
      format: "icns",
      source: { type: "file", path: join(icons, "app-icon.icns") },
    });
    expect(projectAppIcon("/nonexistent", "darwin")).toBeNull();
  });

  it("projectAppIcon：linux 展开 16..512 png 目录", () => {
    const icons = join(here, "..", "..", "..", "resources", "app-icons");
    const icon = projectAppIcon(icons, "linux");
    expect(icon).not.toBeNull();
    expect(icon?.map((asset) => (asset.platform === "linux" && asset.format === "png" ? asset.size : 0))).toEqual([
      16, 32, 48, 64, 128, 256, 512,
    ]);
  });

  it("resolveTrayIcon：template 文件图标（darwin isTemplate）或缺席 null", () => {
    const icons = join(here, "..", "..", "..", "resources", "app-icons");
    const icon = resolveTrayIcon(icons);
    expect(icon?.["darwin-icon-only"]).toMatchObject({ type: "file", isTemplate: true });
    expect(resolveTrayIcon("/nonexistent")).toBeNull();
  });

  it("托盘身份常量贯穿（打包清单与运行时同源）", () => {
    expect(APP_ID).toBe("dev.aifly.desktop");
    expect(APP_NAME).toBe("ai-fly");
  });
});
