// 消费侧命令共享件：CommandContext（stdout/homedir 注入，测试友好）、SDK Fabric
// 工厂的 lazy 构造（动态 import——模块顶层保持无原生模块，vitest 可安全加载命令
// 模块）、relay 入口解析（flag > AIFLY_RELAY > ~/.aifly/config.json）、信号等待。
// 正交意图：无业务决策；各命令的语义在各自文件。

import { homedir } from "node:os";
import type { FabricOptions } from "@jixo/opendweb-client-sdk";
import { loadConfig, resolveRelayUrls } from "../../config.ts";
import type { FabricFactory, FabricLike } from "../../../consumer/providers.ts";
import type { Keyring } from "../../../consumer/store.ts";
import { loadSdk } from "../../../sdk.ts";
import { loadSettings } from "../../../app/settings.ts";

export interface CommandContext {
  /** 测试注入的 HOME 替代（默认 os.homedir()）。 */
  homedir?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export function ctxOut(ctx: CommandContext): (line: string) => void {
  return ctx.out ?? ((line) => process.stdout.write(`${line}\n`));
}

export function ctxErr(ctx: CommandContext): (line: string) => void {
  return ctx.err ?? ((line) => process.stderr.write(`${line}\n`));
}

export function ctxHomedir(ctx: CommandContext): string {
  return ctx.homedir ?? homedir();
}

/**
 * 真实 Fabric 工厂（CLI 层唯一触 SDK 的位置）：动态 import 规避 vitest worker 与
 * 原生模块的不兼容；relay 配置映射为 SDK FabricOptions.relay（custom urls），
 * 未配置时缺省走 SDK 默认（n0）。
 * 解析层级（Owner 裁决 2026-09-13：链接带来的会合点优先于环境/配置默认——
 * provider 在那个 relay 上，不拨它就永远会不了面）：逐次解析为
 * flag > ring/链接内嵌 relay（opts.relayUrls，调用侧按 ring 传入）> env > file。
 * @param linkRelayUrls aifly1. 链接内嵌 relay（import 的 join 阶段用；空 = 缺席）
 */
export async function createSdkFabricFactory(
  relayFlag: readonly string[] | undefined,
  ctx: CommandContext = {},
  linkRelayUrls?: readonly string[],
): Promise<FabricFactory> {
  const sdk = await loadSdk();
  let relaySettings: readonly string[] | null = null;
  try {
    relaySettings = loadSettings(ctxHomedir(ctx)).relayUrls;
  } catch {
    // settings 不可读——该层缺席
  }
  const toOpts = (opts: { dataDir: string; relayUrls?: string[] }): FabricOptions => {
    const fabricOpts: FabricOptions = { dataDir: opts.dataDir };
    const link = opts.relayUrls ?? linkRelayUrls;
    const urls = resolveRelayUrls({
      ...(relayFlag !== undefined ? { flag: relayFlag } : {}),
      ...(link !== undefined ? { link } : {}),
      env: process.env.AIFLY_RELAY,
      settings: relaySettings,
      file: loadConfig(ctxHomedir(ctx)),
    });
    if (urls !== undefined && urls.length > 0) {
      fabricOpts.relay = { mode: "custom", urls: urls as [string, ...string[]] };
    }
    return fabricOpts;
  };
  return {
    open: async (opts) => (await sdk.Fabric.open(toOpts(opts))) as FabricLike,
    joinWithToken: async (opts, token) => (await sdk.Fabric.joinWithToken(toOpts(opts), token)) as FabricLike,
  };
}

/** 等待 SIGINT/SIGTERM（run / import --run 长驻阻塞；测试不触达）。 */
export function waitForSignals(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    process.on("SIGINT", finish);
    process.on("SIGTERM", finish);
  });
}

/** 打印引擎监听清单（run 启动横幅与 status 共用）。 */
export function printListeners(
  out: (line: string) => void,
  info: ReadonlyArray<{
    alias: string;
    name: string;
    serviceId: string;
    port: number;
    requested: number;
    autoAssigned: boolean;
  }>,
): void {
  if (info.length === 0) {
    out("local endpoints: (none - no authorized services yet)");
    return;
  }
  out("local endpoints:");
  for (const l of info) {
    const note = l.autoAssigned ? `  [NOTICE: requested ${l.requested} was unavailable]` : "";
    out(`  127.0.0.1:${l.port}  <-  ${l.alias} / ${l.name}  [${l.serviceId}]${note}`);
  }
}

/** 引擎所需钥环集合加载（run/import --run/status 共用）。 */
export function ringsForRun(rings: readonly Keyring[]): Keyring[] {
  return rings.filter((r) => r.keys.length > 0 || r.services.length > 0);
}
