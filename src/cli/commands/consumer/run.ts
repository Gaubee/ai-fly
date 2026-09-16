// `ai-fly run`：消费网关长驻（与 daemon 命令集对齐，cli-parity）。
// 前台默认：加载全部钥环、物化本地监听（离线 503 语义）、提供者连接与退避重连、
// SIGINT/SIGTERM 优雅退出。--detach 后台化（detached spawn + stdio 落
// ~/.aifly/gateway/gateway.log + pid/last-start 记忆）；stop/info/restart/log
// 子命令与 daemon 同构。正交意图：参数解析 + 生命周期；引擎装配在
// consumer/runtime.ts；后台态原语在 cli/daemon-state.ts。

import { homedir } from "node:os";
import { resolve } from "node:path";
import { openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { parseArgv } from "../../args.ts";
import { CliError, UsageError, reportCliError } from "../../errors.ts";
import { consumersRoot, listKeyrings } from "../../../consumer/store.ts";
import { startEngine } from "../../../consumer/runtime.ts";
import { watchServiceLifecycle } from "../../../consumer/lifecycle-watch.ts";
import { createFabricSessionFactory } from "../../../consumer/providers.ts";
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
  type StateKind,
} from "../../daemon-state.ts";
import {
  createSdkFabricFactory,
  ctxHomedir,
  ctxOut,
  printListeners,
  ringsForRun,
  waitForSignals,
  type CommandContext,
} from "./common.ts";

const KIND: StateKind = "gateway";

const SPEC = {
  detach: { type: "boolean" },
  force: { type: "boolean" },
  data: { type: "string", tilde: true },
  "strict-ports": { type: "boolean" },
  relay: { type: "multi" },
  proxy: { type: "string" },
  lines: { type: "string" },
} as const;

const USAGE = `usage:
  ai-fly run [--data <dir>] [--strict-ports] [--relay <url>]... [--proxy <url|env|none>] [--detach]
  ai-fly run stop [--force]
  ai-fly run info
  ai-fly run restart [--detach] [同 start 参数]
  ai-fly run log [--lines <n>]`;

export async function run(argv: readonly string[], ctx: CommandContext = {}): Promise<number> {
  const home = ctxHomedir(ctx);
  const sub = argv[0];
  try {
    switch (sub) {
      case "stop":
        return await stop(argv.slice(1), home);
      case "info":
        return info(argv.slice(1), home);
      case "restart":
        return await restart(argv.slice(1), home, ctx);
      case "log":
        return log(argv.slice(1), home);
      default:
        return await start(argv, home, ctx);
    }
  } catch (err) {
    return reportCliError(err);
  }
}

/** last-start 记忆（args 含 "run" token，restart 原样回放前剥除）。 */
function lastStartOf(runArgv: readonly string[]): LastStart {
  if (process.argv[1] === undefined) {
    throw new CliError("error: cannot resolve the CLI entry for gateway respawn");
  }
  return { entry: resolve(process.argv[1]), args: ["run", ...runArgv], startedAt: Date.now() };
}

async function start(runArgv: readonly string[], home: string, ctx: CommandContext): Promise<number> {
  const { options, positionals } = parseArgv([...runArgv], SPEC, { homedir: home });
  if (positionals.length > 0) {
    throw new UsageError(`error: unexpected argument '${positionals[0]}' (known subcommands: stop, info, restart, log)\n${USAGE}`);
  }
  // pidfile 命中自身 = --detach 复活的子进程（父进程已预注册我们的 pid）——放行
  const running = currentPid(home);
  if (running !== null && running !== process.pid) {
    throw new CliError(`error: gateway already running (pid ${running}); try 'ai-fly run restart'`);
  }
  const out = ctxOut(ctx);
  const root = consumersRoot(options.data as string | undefined, home);
  const { rings, warnings } = listKeyrings(root);
  for (const w of warnings) out(`warning: ${w}`);
  const engineRings = ringsForRun(rings);
  if (engineRings.length === 0) {
    throw new CliError("error: no imported providers - run 'ai-fly import <aifly1-link>' or 'ai-fly join <token>' first");
  }
  if (options.detach === true) {
    const dir = ensureDaemonDir(home, KIND);
    const respawnArgs = ["run", ...runArgv.filter((a) => a !== "--detach")];
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
      throw new CliError(`error: gateway exited immediately - see ${dir.logFile}`);
    }
    writePid(child.pid!, home, KIND);
    writeLastStart(lastStartOf(respawnArgs.slice(1)), home, KIND);
    process.stdout.write(`gateway started in background (pid ${child.pid}) - log: ${dir.logFile}\n`);
    return 0;
  }
  // 前台：pid 生命周期随进程（exit 即清）
  writePid(process.pid, home, KIND);
  writeLastStart(lastStartOf(runArgv), home, KIND);
  process.on("exit", () => {
    clearPid(home, KIND);
  });
  const factory = await createSdkFabricFactory(
    options.relay as string[] | undefined,
    ctx,
    undefined,
    options.proxy as string | undefined,
  );
  out(
    `gateway starting - booting fabric for ${engineRings.length} provider ring(s)` +
      " (unreachable relays can stall this ~30s; Ctrl+C to abort)...",
  );
  const engine = await startEngine({
    rings: engineRings,
    consumersRoot: root,
    sessionFactoryFor: (ring) =>
      createFabricSessionFactory(factory, {
        dataDir: `${root}/${ring.endpointId.slice(0, 8)}/fabric`,
        providerEndpointId: ring.endpointId,
        // 链接带来的会合点优先（Owner 裁决 2026-09-13）：ring 内嵌 relay 逐环传给 fabric
        ...(ring.relayUrls.length > 0 ? { relayUrls: ring.relayUrls } : {}),
      }),
    strictPorts: options["strict-ports"] === true,
    onNotice: out,
  });
  // service-lifecycle：CLI（services stop/start/rm 独立进程写 keyring.json）经
  // 文件 watch 传导到本 daemon（去抖 + 轮询兜底；停止时随引擎一并清理）
  const lifecycle = watchServiceLifecycle({
    root,
    rings: engineRings,
    gateway: engine.gateway,
    onNotice: out,
  });
  printListeners(out, engine.gateway.listenerInfo());
  out("gateway running - press Ctrl-C to stop");
  await waitForSignals();
  lifecycle.stop();
  await engine.stop();
  out("gateway stopped");
  return 0;
}

/** 后台 pid（活性核验；陈旧 pidfile 就地清理返回 null）。 */
function currentPid(home: string): number | null {
  const pid = readPid(home, KIND);
  if (pid === null) return null;
  if (!isAlive(pid)) {
    clearPid(home, KIND);
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
    process.stdout.write("gateway is not running\n");
    return 0;
  }
  if (process.platform === "win32") {
    // Windows 无跨进程优雅信号：taskkill 即终态（USAGE/帮助明示）
    killHard(pid);
    clearPid(home, KIND);
    process.stdout.write(`gateway stopped (pid ${pid}, forced - windows has no cross-process graceful signal)\n`);
    return 0;
  }
  const graceful = await terminateGracefully(pid);
  if (!graceful && options.force !== true) {
    throw new CliError(`error: gateway (pid ${pid}) did not exit in time - retry with --force`);
  }
  if (!graceful) killHard(pid);
  clearPid(home, KIND);
  process.stdout.write(`gateway stopped (pid ${pid}${graceful ? "" : ", forced"})\n`);
  return 0;
}

function info(infoArgv: readonly string[], home: string): number {
  const { positionals } = parseArgv([...infoArgv], SPEC, { homedir: home });
  if (positionals.length > 0) {
    throw new UsageError(`error: unexpected argument '${positionals[0]}'`);
  }
  const pid = currentPid(home);
  const last = readLastStart(home, KIND);
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
  out(`state dir : ${daemonDir(home, KIND).root}`);
  out(`log file  : ${daemonDir(home, KIND).logFile}`);
  // 钥环摘要（dataDir 从 last-start 参数推导；缺省即默认消费者根）
  const dataArg = last?.args.includes("--data") ? last.args[last.args.indexOf("--data") + 1] : undefined;
  const root = consumersRoot(dataArg, home);
  try {
    const { rings } = listKeyrings(root);
    const services = rings.reduce((n, r) => n + r.services.length, 0);
    const keys = rings.reduce((n, r) => n + r.keys.length, 0);
    out(`data dir  : ${root}`);
    out(`rings     : ${rings.length} (services: ${services}, keys: ${keys})`);
  } catch {
    out(`data dir  : ${root} (store not readable)`);
  }
  return 0;
}

async function restart(restartArgv: readonly string[], home: string, ctx: CommandContext): Promise<number> {
  parseArgv([...restartArgv], SPEC, { homedir: home });
  const pid = currentPid(home);
  if (pid !== null) {
    const graceful = process.platform === "win32" ? false : await terminateGracefully(pid);
    if (!graceful) killHard(pid);
    clearPid(home, KIND);
    process.stdout.write(`gateway stopped (pid ${pid}${graceful ? "" : ", forced"})\n`);
  } else {
    process.stdout.write("gateway was not running\n");
  }
  // 复活参数：本次给了 run 形参则用之，否则按 last-start 回放
  const hasNewArgs = restartArgv.some((a) => !a.startsWith("--detach"));
  if (hasNewArgs) {
    return await start(restartArgv, home, ctx);
  }
  const last = readLastStart(home, KIND);
  const detachWanted = restartArgv.includes("--detach");
  if (last === null) {
    return await start(detachWanted ? ["--detach"] : [], home, ctx);
  }
  const replay = last.args.filter((a) => a !== "run" && a !== "--detach");
  return await start(detachWanted ? [...replay, "--detach"] : replay, home, ctx);
}

function log(logArgv: readonly string[], home: string): number {
  const { options, positionals } = parseArgv([...logArgv], SPEC, { homedir: home });
  if (positionals.length > 0) {
    throw new UsageError(`error: unexpected argument '${positionals[0]}'`);
  }
  const lines = Math.max(1, Number.parseInt(String(options.lines ?? "50"), 10) || 50);
  const { logFile } = daemonDir(home, KIND);
  try {
    const content = readFileSync(logFile, "utf8").trimEnd();
    if (content === "") {
      process.stdout.write("(gateway.log is empty)\n");
      return 0;
    }
    const tail = content.split("\n").slice(-lines).join("\n");
    process.stdout.write(`${tail}\n`);
    return 0;
  } catch {
    process.stdout.write(`no gateway log yet (${logFile})\n`);
    return 0;
  }
}
