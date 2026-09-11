// daemon --detach 回路（cli-parity A → cli-hardening #11 集成面）：真实子进程
// spawn（node --import tsx）+ pidfile 生命周期 + 早期输出落 daemon.log + stop。
// 不依赖网络：relay 指向不可达地址——子进程停在 fabric boot（SIGTERM 默认终止，
// 恰好验证优雅 stop 对未就绪进程也成立）。真实机器走查之外的进程级回归锚点。

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// SDK 原生模块仅发布 darwin/win32（dweb.darwin-arm64.node / dweb.win32-x64.node）；
// Linux CI 上 daemon start 加载 fabric 即崩——进程级回路只在有原生面的平台跑，
// Linux 由其余 519 例覆盖。SDK 发布 linux 目标后放开此处。

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..");
const bin = join(repoRoot, "src", "bin.ts");
const homes: string[] = [];

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), `aifly-detach-${process.pid}-${homes.length}`));
  homes.push(home);
  return home;
}

function cli(home: string, args: string[]): { code: number; stdout: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
    cwd: repoRoot,
    timeout: 120_000,
  });
  return { code: r.status ?? -1, stdout: `${r.stdout}${r.stderr}` };
}

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const describeNative = process.platform === "darwin" || process.platform === "win32" ? describe : describe.skip;

describeNative("daemon --detach 回路（进程级）", () => {
  it(
    "start --detach → info(running) → log(早期输出) → stop → info(not running)",
    { timeout: 120_000 },
    async () => {
      const home = freshHome();
      const relay = "http://10.255.255.1:443/"; // 不可达：子进程停在 boot（无网络依赖）
      const start = cli(home, ["daemon", "start", "--detach", "--relay", relay]);
      expect(start.code).toBe(0);
      expect(start.stdout).toContain("daemon started in background");
      const pid = Number.parseInt(readFileSync(join(home, ".aifly/daemon/pid"), "utf8").trim(), 10);
      expect(pid).toBeGreaterThan(0);

      const info = cli(home, ["daemon", "info"]);
      expect(info.code).toBe(0);
      expect(info.stdout).toContain(`running   : yes (pid ${pid})`);

      // 早期输出在 fabric boot 之前落 log（relay 不可达也不空文件）
      const logFile = join(home, ".aifly/daemon/daemon.log");
      let logText = "";
      for (let i = 0; i < 40 && !logText.includes("booting fabric"); i++) {
        try {
          logText = readFileSync(logFile, "utf8");
        } catch {
          /* 尚未创建 */
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(logText).toContain("ai-fly daemon starting");
      expect(logText).toContain(relay);

      const stop = cli(home, ["daemon", "stop"]);
      expect(stop.code).toBe(0);
      expect(stop.stdout).toContain(`daemon stopped (pid ${pid}`);
      const info2 = cli(home, ["daemon", "info"]);
      expect(info2.stdout).toContain("running   : no");
      expect(readFileSync(join(home, ".aifly/daemon/pid"), "utf8").trim()).toBe("");
    },
  );

  it("stop 在未运行时是幂等 noop", () => {
    const home = freshHome();
    const r = cli(home, ["daemon", "stop"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("daemon is not running");
  });

  it("二次 start --detach 拒绝（pidfile 命中活进程）", { timeout: 120_000 }, async () => {
    const home = freshHome();
    const relay = "http://10.255.255.1:443/";
    expect(cli(home, ["daemon", "start", "--detach", "--relay", relay]).code).toBe(0);
    const second = cli(home, ["daemon", "start", "--detach", "--relay", relay]);
    expect(second.code).toBe(1);
    expect(second.stdout).toContain("already running");
    expect(cli(home, ["daemon", "stop", "--force"]).code).toBe(0);
  });
});
