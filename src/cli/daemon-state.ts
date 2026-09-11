// 后台态（cli-parity A1）：`~/.aifly/daemon/`（provider daemon）与
// `~/.aifly/gateway/`（consumer 网关 run --detach）各三件——pid /
// last-start.json（复活参数记忆）/ *.log（--detach 的 stdio 落点）。
// 纯 fs + process 语义，跨平台终止：posix SIGTERM→SIGKILL；win32 无跨进程
// 优雅信号 → taskkill（v1 接受硬停，USAGE 明示）。
// 复活入口 = process.argv[1]（dev=tsx 源文件、装包=dist/ai-fly.js 皆成立）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

export type StateKind = "daemon" | "gateway";

export interface DaemonStateDir {
  root: string;
  pidFile: string;
  lastStartFile: string;
  logFile: string;
}

export function daemonDir(base = homedir(), kind: StateKind = "daemon"): DaemonStateDir {
  const root = join(base, ".aifly", kind);
  return {
    root,
    pidFile: join(root, "pid"),
    lastStartFile: join(root, "last-start.json"),
    logFile: join(root, `${kind}.log`),
  };
}

export function ensureDaemonDir(base = homedir(), kind: StateKind = "daemon"): DaemonStateDir {
  const dir = daemonDir(base, kind);
  mkdirSync(dir.root, { recursive: true });
  return dir;
}

/** last-start.json 的形状（restart 复活参数）。 */
export interface LastStart {
  /** 复活入口（process.argv[1] 绝对路径）。 */
  entry: string;
  /** start 收到的完整参数（含子命令 token——原样回放）。 */
  args: string[];
  /** 启动时刻（ms）。 */
  startedAt: number;
}

export function writePid(pid: number, base = homedir(), kind: StateKind = "daemon"): void {
  const dir = ensureDaemonDir(base, kind);
  writeFileSync(dir.pidFile, `${pid}\n`);
}

export function readPid(base = homedir(), kind: StateKind = "daemon"): number | null {
  try {
    const raw = readFileSync(daemonDir(base, kind).pidFile, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function clearPid(base = homedir(), kind: StateKind = "daemon"): void {
  const { pidFile } = daemonDir(base, kind);
  if (existsSync(pidFile)) writeFileSync(pidFile, "");
}

export function writeLastStart(last: LastStart, base = homedir(), kind: StateKind = "daemon"): void {
  const dir = ensureDaemonDir(base, kind);
  writeFileSync(dir.lastStartFile, `${JSON.stringify(last, null, 2)}\n`);
}

export function readLastStart(base = homedir(), kind: StateKind = "daemon"): LastStart | null {
  try {
    const raw = JSON.parse(readFileSync(daemonDir(base, kind).lastStartFile, "utf8"));
    if (typeof raw.entry === "string" && Array.isArray(raw.args)) {
      return { entry: raw.entry, args: raw.args, startedAt: Number(raw.startedAt) || Date.now() };
    }
    return null;
  } catch {
    return null;
  }
}

/** 进程活性（ESRCH = 不存在）。 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 优雅终止：SIGTERM → 轮询 ≤timeoutMs → 仍未退返回 false（调用方决定硬杀）。 */
export async function terminateGracefully(pid: number, timeoutMs = 10_000): Promise<boolean> {
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/** 硬杀：posix SIGKILL；win32 taskkill（无优雅信号语义，USAGE 明示）。 */
export function killHard(pid: number): void {
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/PID", String(pid), "/F", "/T"], { stdio: "ignore" });
  } else {
    process.kill(pid, "SIGKILL");
  }
}
