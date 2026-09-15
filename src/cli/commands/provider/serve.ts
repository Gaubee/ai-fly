// `ai-fly serve`：提供方长驻 daemon——加载服务/分组/密钥、fabric createRoot/open
// 复入、启动横幅、relay 接入（flag > env > config）、SIGINT 优雅退出（幂等）。
// 命令分发由 bin.ts 统一接线；本文件只导出 run(argv, ctx)。

import { homedir } from "node:os";
import { parseArgv } from "../../args.ts";
import { UsageError, reportCliError } from "../../errors.ts";
import { resolveHttpProxy } from "../../proxy.ts";
import { startProviderDaemon } from "../../../provider/serve.ts";
import { resolveDataDir, resolvedRelayUrls, str } from "./common.ts";

const SPEC = {
  data: { type: "string", tilde: true },
  relay: { type: "multi" },
  alias: { type: "string" },
  "log-usage": { type: "boolean" },
  proxy: { type: "string" },
} as const;

export async function run(argv: string[], ctx: { homedir?: string } = {}): Promise<number> {
  try {
    const home = ctx.homedir ?? homedir();
    const { options, positionals } = parseArgv(argv, SPEC, { homedir: home });
    if (positionals.length > 0) {
      throw new UsageError(`error: unexpected argument '${positionals[0]}' (serve takes no positional arguments)`);
    }
    const dataDir = resolveDataDir(str(options.data), home);
    const relayUrls = resolvedRelayUrls(options, home) ?? [];
    const httpProxy = resolveHttpProxy(str(options.proxy));
    // 早期状态：fabric boot（relay 接入）可能耗时数十秒——不可达时不能伪装死
    process.stdout.write(
      [
        "ai-fly daemon starting",
        `  relay: ${relayUrls.length > 0 ? relayUrls.join(", ") : "n0 public relays (default)"}`,
        `  data : ${dataDir}`,
        ...(httpProxy !== undefined ? [`  proxy: ${httpProxy === "from-env" ? "env" : httpProxy === "none" ? "none" : httpProxy.url}`] : []),
        "booting fabric (unreachable relays can stall this ~30s; Ctrl+C to abort)...",
        "",
      ].join("\n"),
    );
    const daemon = await startProviderDaemon({
      dataDir,
      // home 贯穿（复核 R3-P1）：与 daemon.ts 启动路径同基准——store 落库校验、
      // engine 运行时脚本解析、watcher reloadStore 都不回退真实 os.homedir()。
      home,
      relayUrls,
      alias: str(options.alias),
      logUsage: options["log-usage"] === true,
      ...(httpProxy !== undefined ? { httpProxy } : {}),
    });
    process.stdout.write(`${daemon.banner}\n`);

    let stopping = false;
    const stop = (): void => {
      if (stopping) {
        process.exit(130); // 第二次 Ctrl+C：立即退出
      }
      stopping = true;
      void daemon
        .stop()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    await new Promise<never>(() => {
      // 长驻：fabric 原生层持有事件循环；退出仅经信号路径。
    });
    return 0; // 不可达（上方 await 永不完成）；满足返回类型
  } catch (err) {
    return reportCliError(err);
  }
}
