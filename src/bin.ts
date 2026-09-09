#!/usr/bin/env node
// ai-fly CLI 入口：命令分发（ts-pattern 按首 token 路由）。
// 双角色命令约定：`status` 自动组合（提供方目录/消费侧钥环谁在跑谁）；`key` 按
// 子命令分流（add=使用方，issue/list/revoke=提供方）。命令实现全部位于
// src/cli/commands/{provider,consumer}，本文件只做路由与退出码透传。

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { match } from "ts-pattern";
import { UsageError, reportCliError } from "./cli/errors.ts";

type RunFn = (argv: string[], ctx?: { homedir?: string }) => Promise<number>;

const USAGE = `ai-fly — peer-to-peer HTTP/WebSocket bridge with AI-ready presets (OpenDWeb fabric)

Provider:
  ai-fly serve    [--data <dir>] [--relay <url>]...        run the provider daemon
  ai-fly service  add|list|remove ...                      manage services
  ai-fly group    add|list ...                             manage groups
  ai-fly key      issue|list|revoke --group <name>         manage group keys
  ai-fly share    --group <name> [--ttl <dur>]             mint a share link (token + key)
  ai-fly revoke   <endpointId>                             eject a device (fabric-level)
  ai-fly status   [provider|consumer] [--verbose]          snapshot (auto: both if present)

Consumer:
  ai-fly join     <dweb1-token> [--data <dir>]             admit this device (fabric layer)
  ai-fly key      add <sk-aifly-key> --provider <id>       bare key into an existing ring
  ai-fly import   <aifly1-link> [--run] [--preview]        bundle link: join + keyring
  ai-fly run      [--data <dir>] [--strict-ports]          run the local gateway
  ai-fly ports    [--data <dir>] [<serviceId> --port <n>]  view/override mapped ports
  ai-fly status   [provider|consumer] [--verbose]          snapshot (auto: both if present)
  ai-fly forget   <endpointId|8-char-prefix>               drop an imported provider

Options:
  --data <dir>    storage location (tilde expanded; role-specific default)
  --relay <url>   relay entry URL (repeatable; flag > AIFLY_RELAY env > ~/.aifly/config.json)
  --help, -h      show this help`;

async function dispatch(command: string, rest: string[]): Promise<number> {
  const providerDirExists = () => existsSync(join(homedir(), ".aifly", "provider"));
  const consumersRootExists = () => {
    try {
      return existsSync(join(homedir(), ".aifly", "consumers"));
    } catch {
      return false;
    }
  };

  const lazy = (load: () => Promise<{ run: RunFn }>): RunFn => {
    return (argv, ctx) => load().then((m) => m.run([...argv], ctx));
  };

  return match<string, Promise<number>>(command)
    .with("serve", () => lazy(() => import("./cli/commands/provider/serve.ts"))(rest))
    .with("service", () => lazy(() => import("./cli/commands/provider/service.ts"))(rest))
    .with("group", () => lazy(() => import("./cli/commands/provider/group.ts"))(rest))
    .with("share", () => lazy(() => import("./cli/commands/provider/share.ts"))(rest))
    .with("revoke", () => lazy(() => import("./cli/commands/provider/revoke.ts"))(rest))
    .with("join", () => lazy(() => import("./cli/commands/consumer/join.ts"))(rest))
    .with("import", () => lazy(() => import("./cli/commands/consumer/import.ts"))(rest))
    .with("run", () => lazy(() => import("./cli/commands/consumer/run.ts"))(rest))
    .with("ports", () => lazy(() => import("./cli/commands/consumer/ports.ts"))(rest))
    .with("forget", () => lazy(() => import("./cli/commands/consumer/forget.ts"))(rest))
    .with("key", () => {
      const sub = rest[0];
      if (sub === "add") {
        // consumer/key.ts 自行识别并剥掉首 token "add"，此处必须整参透传
        return lazy(() => import("./cli/commands/consumer/key.ts"))(rest);
      }
      return lazy(() => import("./cli/commands/provider/key.ts"))(rest);
    })
    .with("status", async () => {
      const [scope, ...tail] = rest;
      const wantProvider = scope === "provider" || (scope !== "consumer" && providerDirExists());
      const wantConsumer = scope === "consumer" || (scope !== "provider" && consumersRootExists());
      const argv = scope === "provider" || scope === "consumer" ? tail : rest;
      let code = 0;
      if (wantProvider) {
        code = Math.max(code, await lazy(() => import("./cli/commands/provider/status.ts"))(argv));
      }
      if (wantConsumer) {
        code = Math.max(code, await lazy(() => import("./cli/commands/consumer/status.ts"))(argv));
      }
      if (!wantProvider && !wantConsumer) {
        process.stdout.write("nothing to report: no provider storage and no imported consumers\n");
      }
      return code;
    })
    .otherwise(() => {
      throw new UsageError(`error: unknown command '${command}' (see ai-fly --help)`);
    });
}

async function main(argv: readonly string[]): Promise<number> {
  const first = argv[0];
  if (first === undefined || first === "--help" || first === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return first === undefined ? 2 : 0;
  }
  return dispatch(first, argv.slice(1));
}

try {
  const code = await main(process.argv.slice(2));
  // 让挂起句柄（ws/定时器）自然结束后退出；退出码显式透传
  process.exitCode = code;
} catch (err) {
  process.exitCode = reportCliError(err);
}
