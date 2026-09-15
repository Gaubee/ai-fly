// `ai-fly daemon start|stop|info|restart|log`（cli-parity A2/A3）：provider
// daemon 的生命周期管理。前台 = serve 同核心（delegation）；--detach = 后台
// child（pid/last-start/daemon.log 落 ~/.aifly/daemon/）。stop：SIGTERM 优雅
// →≤5s 确认 → --force 硬杀（win32 无跨进程优雅信号，直接 taskkill）。
// restart 按 last-start.json 复活（本次给参则覆盖记忆）。正交意图：本文件只做
// 生命周期编排；daemon 语义在 provider/serve.ts，状态读写在 cli/daemon-state.ts。

import { openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { parseArgv } from "../../args.ts";
import { CliError, UsageError, reportCliError } from "../../errors.ts";
import { openStore } from "./common.ts";
import { loadSettings, settingsPath } from "../../../app/settings.ts";
import {
  clearPid,
  daemonDir,
  ensureDaemonDir,
  isAlive,
  killHard,
  readLastStart,
  readPid,
  terminateGracefully,
  writeLastStart,
  writePid,
  type LastStart,
} from "../../daemon-state.ts";

const SPEC = {
  detach: { type: "boolean" },
  force: { type: "boolean" },
  data: { type: "string", tilde: true },
  relay: { type: "multi" },
  alias: { type: "string" },
  "log-usage": { type: "boolean" },
  proxy: { type: "string" },
  lines: { type: "string" },
} as const;

const USAGE = `usage:
  ai-fly daemon start [--detach] [--data <dir>] [--relay <url>]... [--proxy <url|env|none>]
  ai-fly daemon stop [--force]
  ai-fly daemon info
  ai-fly daemon restart [--detach] [--data <dir>] [--relay <url>]... [--proxy <url|env|none>]
  ai-fly daemon log [--lines <n>]

--proxy: relay 控制面 HTTP 代理（QUIC 数据面永不过代理）；等价 env AIFLY_PROXY。
         'env' = 读进程环境变量（HTTP_PROXY/HTTPS_PROXY）；'none' = 显式禁用。`;

export async function run(argv: string[], ctx: { homedir?: string } = {}): Promise<number> {
  const home = ctx.homedir ?? homedir();
  const sub = argv[0];
  const rest = argv.slice(1);
  try {
    switch (sub) {
      case undefined:
      case "start":
        return await start(rest, home);
      case "stop":
        return await stop(rest, home);
      case "info":
        return info(rest, home);
      case "restart":
        return await restart(rest, home);
      case "log":
        return log(rest, home);
      default:
        throw new UsageError(`error: unknown daemon subcommand '${sub}'\n${USAGE}`);
    }
  } catch (err) {
    return reportCliError(err);
  }
}

/** --detach 复活参数：本次 argv 原样（含 start 子命令语义由调用方拼）。 */
function lastStartOf(startArgv: readonly string[]): LastStart {
  const entry = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
  if (entry === undefined) {
    throw new CliError("error: cannot resolve the CLI entry for daemon respawn");
  }
  return { entry, args: ["start", ...startArgv], startedAt: Date.now() };
}

async function start(startArgv: readonly string[], home: string): Promise<number> {
  const { options, positionals } = parseArgv([...startArgv], SPEC, { homedir: home });
  if (positionals.length > 0) {
    throw new UsageError(`error: unexpected argument '${positionals[0]}'`);
  }
  // pidfile 命中自身 = --detach 复活的子进程（父进程已预注册我们的 pid）——放行
  const running = currentPid(home);
  if (running !== null && running !== process.pid) {
    throw new CliError(`error: daemon already running (pid ${running}); try 'ai-fly daemon restart'`);
  }
  const detach = options.detach === true;
  if (detach) {
    const dir = ensureDaemonDir(home);
    const respawnArgs = ["daemon", "start", ...startArgv.filter((a) => a !== "--detach")];
    const logFd = openSync(dir.logFile, "a");
    // execArgv 透传（dev=tsx --import 旗标；dist 为空）+ 入口文件，纯 node 可复活
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, ...respawnArgs], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
      cwd: process.cwd(),
    });
    child.unref();
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (child.exitCode !== null) {
      throw new CliError("error: daemon exited immediately - see ~/.aifly/daemon/daemon.log");
    }
    writePid(child.pid!, home);
    writeLastStart(lastStartOf(respawnArgs.slice(2)), home);
    process.stdout.write(`daemon started in background (pid ${child.pid}) - log: ${dir.logFile}\n`);
    return 0;
  }
  // 前台：pid 生命周期随进程（exit 即清）；实际长驻核心在 serve.ts
  writePid(process.pid, home);
  writeLastStart(lastStartOf(startArgv), home);
  process.on("exit", () => { clearPid(home); });
  const { run: serveRun } = await import("./serve.ts");
  return serveRun([...startArgv], { homedir: home });
}

/** 后台 pid（活性核验；陈旧 pidfile 就地清理返回 null）。 */
function currentPid(home: string): number | null {
  const pid = readPid(home);
  if (pid === null) return null;
  if (!isAlive(pid)) {
    clearPid(home);
    return null;
  }
  return pid;
}

async function stop(stopArgv: readonly string[], home: string): Promise<number> {
  const { options, positionals } = parseArgv([...stopArgv], SPEC, { homedir: home });
  if (positionals.length > 0) {
    throw new UsageError(`error: unexpected argument '${positionals[0]}'`);
  }
  const pid = currentPid(home);
  if (pid === null) {
    process.stdout.write("daemon is not running\n");
    return 0;
  }
  if (process.platform === "win32") {
    // Windows 无跨进程优雅信号：taskkill 即终态（USAGE/帮助明示）
    killHard(pid);
    clearPid(home);
    process.stdout.write(`daemon stopped (pid ${pid}, forced - windows has no cross-process graceful signal)\n`);
    return 0;
  }
  const graceful = await terminateGracefully(pid);
  if (!graceful && options.force !== true) {
    throw new CliError(`error: daemon (pid ${pid}) did not exit in time - retry with --force`);
  }
  if (!graceful) killHard(pid);
  clearPid(home);
  process.stdout.write(`daemon stopped (pid ${pid}${graceful ? "" : ", forced"})\n`);
  return 0;
}

function info(infoArgv: readonly string[], home: string): number {
  const { positionals } = parseArgv([...infoArgv], SPEC, { homedir: home });
  if (positionals.length > 0) {
    throw new UsageError(`error: unexpected argument '${positionals[0]}'`);
  }
  const pid = currentPid(home);
  const last = readLastStart(home);
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  out(pid !== null ? `running   : yes (pid ${pid})` : "running   : no");
  if (pid !== null && last !== null) {
    const up = Math.max(0, Math.round((Date.now() - last.startedAt) / 1000));
    out(`uptime    : ${Math.floor(up / 60)}m ${up % 60}s`);
  }
  if (last !== null) {
    out(`entry     : ${last.entry}`);
    out(`arguments : ${last.args.join(" ")}`);
  }
  out(`state dir : ${daemonDir(home).root}`);
  out(`log file  : ${daemonDir(home).logFile}`);
  // store 摘要（dataDir 从 last-start 参数推导；缺省即默认数据目录）
  const dataDir = last?.args.includes("--data")
    ? resolve(home, last.args[last.args.indexOf("--data") + 1] ?? "")
    : resolve(home, ".aifly", "provider");
  try {
    const store = openStore(isAbsolute(dataDir) ? dataDir : resolve(process.cwd(), dataDir), home);
    const services = store.listServices();
    const groups = store.listGroups();
    const keys = store.listKeys();
    const active = keys.filter((k) => k.revokedAt === undefined).length;
    out(`data dir  : ${dataDir}`);
    out(`services  : ${services.length} (${services.map((s) => s.name).join(", ") || "-"})`);
    out(`groups    : ${groups.length} | keys: ${active} active, ${keys.length - active} revoked`);
  } catch {
    out(`data dir  : ${dataDir} (store not readable)`);
  }
  out(`settings  : ${settingsPath(home)}`);
  const settings = loadSettings(home);
  out(`  theme   : ${settings.theme} | models.dev: ${settings.modelsDevEnabled ? "on" : "off"}`);
  out(`  relay   : ${settings.relayUrls === null ? "SDK defaults (n0)" : settings.relayUrls.join(", ")}`);
  return 0;
}

async function restart(restartArgv: readonly string[], home: string): Promise<number> {
  parseArgv([...restartArgv], SPEC, { homedir: home });
  const pid = currentPid(home);
  if (pid !== null) {
    const graceful = process.platform === "win32" ? false : await terminateGracefully(pid);
    if (!graceful) killHard(pid);
    clearPid(home);
    process.stdout.write(`daemon stopped (pid ${pid}${graceful ? "" : ", forced"})\n`);
  } else {
    process.stdout.write("daemon was not running\n");
  }
  // 复活参数：本次给了 start 形参则用之，否则按 last-start 回放
  const hasNewArgs = restartArgv.some((a) => !a.startsWith("--detach"));
  if (hasNewArgs) {
    return await start(restartArgv, home);
  }
  const last = readLastStart(home);
  const detachWanted = restartArgv.includes("--detach");
  if (last === null) {
    return await start(detachWanted ? ["--detach"] : [], home);
  }
  const replay = detachWanted ? ["--detach", ...last.args.filter((a) => a !== "--detach" && a !== "start"), "start"] : last.args;
  return await start(replay.filter((a) => a !== "start"), home);
}

function log(logArgv: readonly string[], home: string): number {
  const { options, positionals } = parseArgv([...logArgv], SPEC, { homedir: home });
  if (positionals.length > 0) {
    throw new UsageError(`error: unexpected argument '${positionals[0]}'`);
  }
  const lines = Math.max(1, Number.parseInt(String(options.lines ?? "50"), 10) || 50);
  const { logFile } = daemonDir(home);
  try {
    const content = readFileSync(logFile, "utf8").trimEnd();
    if (content === "") {
      process.stdout.write("(daemon.log is empty)\n");
      return 0;
    }
    const tail = content.split("\n").slice(-lines).join("\n");
    process.stdout.write(`${tail}\n`);
    return 0;
  } catch {
    process.stdout.write(`no daemon log yet (${logFile})\n`);
    return 0;
  }
}
