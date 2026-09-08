#!/usr/bin/env node
// ai-fly CLI 入口。命令面随 openspec change api-share 的任务推进逐个接入；
// 当前脚手架阶段：识别合法命令名，输出 usage 并以退出码 2 引导。

import { UsageError, reportCliError } from "./cli/errors.ts";

const USAGE = `ai-fly — peer-to-peer OpenAI-compatible API sharing over OpenDWeb fabric

Usage:
  ai-fly serve   [--data <dir>] --upstream <url> [options]   share a local OpenAI-compatible upstream
  ai-fly invite  [--data <dir>] [--ttl <dur>]                issue a dweb1. invite token
  ai-fly revoke  [--data <dir>] <endpointId>                 revoke a consumer
  ai-fly use     [--data <dir>] [--port <n>] [<token>]       join and start the localhost gateway
  ai-fly status  [--data <dir>]                              provider/consumer liveness snapshot
  ai-fly key     rotate                                       rotate the local API key
  ai-fly setup   <codex|cursor|cline|continue> [--print]     write agent base-url config

Options:
  --relay <url>       relay entry URL (repeatable; flag > AIFLY_RELAY env > ~/.aifly/config.json)
  --help, -h          show this help

Status: scaffold — commands land with the api-share change tasks (see openspec/).`;

const COMMANDS = new Set(["serve", "invite", "revoke", "use", "status", "key", "setup"]);

function main(argv: readonly string[]): number {
  const first = argv[0];
  if (first === undefined || first === "--help" || first === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return first === undefined ? 2 : 0;
  }
  if (!COMMANDS.has(first)) {
    throw new UsageError(`error: unknown command '${first}' (known: ${[...COMMANDS].join(", ")})`);
  }
  process.stdout.write(
    `ai-fly '${first}' is not wired yet — landing with the api-share change (scaffold stage).\n`,
  );
  return 2;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  process.exit(reportCliError(err));
}
