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

Daemon:
  ai-fly                       run the provider daemon (foreground; Ctrl+C stops)
  ai-fly daemon start [--detach] [--data <dir>] [--relay <url>]... [--proxy <url|env|none>]
  ai-fly daemon stop [--force] | info | restart [--detach] | log [--lines <n>]
  ai-fly serve                 alias of 'daemon start'
  ai-fly app                   launch the tray GUI (desktop app)

Provider:
  ai-fly service add <name> [--upstream <url> | --preset <id>] [--route <local>=<up>[@forms]]...
                               [--route-pattern <match>=<template>]... [--secret <name>]
                               [--port <n>] [--match <type>:<value>]... [--data <dir>]
  ai-fly service list|get|remove <name> [--data <dir>]
  ai-fly service test <name> [--form …] [--content <text>] [--model <id>] [--local-prefix /v1]
  ai-fly group add|set-services|set-limits|list|remove ...
  ai-fly key issue|list|revoke --group <name>
  ai-fly secret set|list|remove ...                     (values never leave the store - no get)
  ai-fly share --group <name> [--ttl <dur>]             mint a share link (token + key)
  ai-fly revoke <endpointId>                            eject a device (fabric-level)
  ai-fly presets [search] [--json]                      featured + models.dev long tail

Consumer:
  ai-fly join <dweb1-token> [--data <dir>] [--proxy …]  admit this device (fabric layer)
  ai-fly import <aifly1-link> [--run] [--preview] [--proxy …]  bundle link: join + keyring
  ai-fly run [--data <dir>] [--strict-ports] [--proxy …] [--detach]  run the local gateway
  ai-fly run stop|info|restart|log [--force] [--lines <n>]           gateway lifecycle (mirrors daemon)
  ai-fly ports [--data <dir>] [<serviceId> --port <n>]  view/override mapped ports
  ai-fly test [--data <dir>] [--service <name>] [--form …] [--content <text>]
                               single AI request through the local gateway
  ai-fly key add <sk-aifly-key> --provider <id>         bare key into an existing ring
  ai-fly forget <endpointId|8-char-prefix>              drop an imported provider

Config:
  ai-fly settings list
  ai-fly settings set theme dark|light|system | models-dev on|off | relay <url>... | relay --default
  ai-fly relay list|set ...                             alias of 'settings … relay'

Info:
  ai-fly status [provider|consumer] [--verbose]         snapshot (auto: both if present)

Options:
  --data <dir>    storage location (tilde expanded; role-specific default)
  --relay <url>   relay entry URL (repeatable; flag > AIFLY_RELAY env > settings.json > ~/.aifly/config.json)
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
    // 托盘 GUI：转发 dist/app/main.js（npm 包随附；dev 下 dist/app 由 build 产出）
    .with("app", async () => {
      const { join, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const { spawn } = await import("node:child_process");
      const entry = join(dirname(fileURLToPath(import.meta.url)), "app", "main.js");
      const { existsSync } = await import("node:fs");
      if (!existsSync(entry)) {
        process.stderr.write(
          `error: tray GUI not included in this install (missing ${entry})\n` +
            "note: rebuild the package with webui + app entries (pnpm app:build)\n",
        );
        return 1;
      }
      const child = spawn(process.execPath, [entry, ...rest], { stdio: "inherit" });
      const code = await new Promise<number>((resolve) => {
        child.once("exit", (c) => resolve(c ?? 0));
      });
      return code;
    })
    .with("daemon", () => lazy(() => import("./cli/commands/provider/daemon.ts"))(rest))
    .with("presets", () => lazy(() => import("./cli/commands/provider/presets.ts"))(rest))
    .with("secret", () => lazy(() => import("./cli/commands/provider/secret.ts"))(rest))
    .with("settings", async () => (await import("./cli/commands/settings.ts")).runAsSettings(rest, {}))
    .with("relay", async () => (await import("./cli/commands/settings.ts")).runAsRelay(rest, {}))
    .with("test", () => lazy(() => import("./cli/commands/consumer/test.ts"))(rest))
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
  if (first === "--help" || first === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  // Owner 标准（2026-09-12）：裸 `ai-fly` ≡ `ai-fly daemon start`
  if (first === undefined) {
    return dispatch("daemon", []);
  }
  return dispatch(first, argv.slice(1));
}

// 管道截断（| head）会让后续 write 收 EPIPE——CLI 正常用法，静默退出
process.stdout?.on?.("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
});
process.stderr?.on?.("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
});

try {
  const code = await main(process.argv.slice(2));
  // 让挂起句柄（ws/定时器）自然结束后退出；退出码显式透传
  process.exitCode = code;
} catch (err) {
  process.exitCode = reportCliError(err);
}
