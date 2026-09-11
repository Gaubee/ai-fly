// 提供方命令组的共用小件：数据目录解析、选项值读取、match/headerSet 规格解析。
// 正交意图：不含任何命令业务（各命令自带 spec 与流程）；文案英文 ASCII。

import { homedir } from "node:os";
import { join } from "node:path";
import { UsageError } from "../../errors.ts";
import type { OptionValue } from "../../args.ts";
import { loadConfig, resolveRelayUrls } from "../../config.ts";
import { loadSettings } from "../../../app/settings.ts";
import type { ConfigFile } from "../../config.ts";
import { ProviderStore } from "../../../provider/store.ts";
import type { ServiceMatchRule, ServiceRewrite } from "../../../provider/store.ts";

export function resolveDataDir(flag: string | undefined, home = homedir()): string {
  if (flag === undefined || flag === "") return join(home, ".aifly", "provider");
  return flag; // parseArgv(tilde) 已完成 ~ 展开
}

/** relay 解析（flag > AIFLY_RELAY env > config file）；exactOptionalPropertyTypes 安全组装。 */
export function resolvedRelayUrls(
  options: Readonly<Record<string, OptionValue>>,
  home: string,
): string[] | undefined {
  const input: { flag?: readonly string[]; env?: string | undefined; settings?: readonly string[] | null; file?: ConfigFile } = {};
  try {
    input.settings = loadSettings(home).relayUrls;
  } catch {
    // settings 不可读（损坏等）——该层缺席，链路继续
  }
  if (Array.isArray(options.relay)) input.flag = options.relay as readonly string[];
  const env = process.env.AIFLY_RELAY;
  if (env !== undefined) input.env = env;
  input.file = loadConfig(home);
  return resolveRelayUrls(input);
}

export function str(value: OptionValue | undefined): string | undefined {
  if (typeof value === "string") return value;
  return undefined;
}

export function multi(value: OptionValue | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
}

export function requireString(value: string | undefined, label: string): string {
  if (value === undefined || value === "") {
    throw new UsageError(`error: missing required option --${label}`);
  }
  return value;
}

export function parsePositiveInt(raw: string, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > Number.MAX_SAFE_INTEGER) {
    throw new UsageError(`error: invalid ${label} value: ${raw} (expected a positive integer)`);
  }
  return n;
}

export function parsePortNumber(raw: string, label: string): number {
  const n = parsePositiveInt(raw, label);
  if (n > 65535) {
    throw new UsageError(`error: invalid ${label} value: ${raw} (expected 1..65535)`);
  }
  return n;
}

/** "type:value"（value 为剩余整体；type in exact|suffix|regex）。 */
export function parseMatchSpec(raw: string): ServiceMatchRule {
  const idx = raw.indexOf(":");
  if (idx <= 0) {
    throw new UsageError(`error: invalid --match value: ${raw} (expected <exact|suffix|regex>:<value>)`);
  }
  const type = raw.slice(0, idx);
  const value = raw.slice(idx + 1);
  if (type !== "exact" && type !== "suffix" && type !== "regex") {
    throw new UsageError(`error: invalid --match type: ${type} (expected exact|suffix|regex)`);
  }
  if (value === "") {
    throw new UsageError(`error: invalid --match value: ${raw} (value must not be empty)`);
  }
  return { type, value };
}

/** "Name=value"（首个 = 分割；Name 小写化）。 */
export function parseHeaderSetSpec(raw: string): { name: string; value: string } {
  const idx = raw.indexOf("=");
  if (idx <= 0) {
    throw new UsageError(`error: invalid --header-set value: ${raw} (expected <name>=<value>, value may be $env:VAR)`);
  }
  return { name: raw.slice(0, idx).trim().toLowerCase(), value: raw.slice(idx + 1) };
}

/** 各命令的 rewrite 组装（仅在存在任一重写选项时构造）。 */
export function buildRewrite(input: {
  host?: string | undefined;
  strip?: string | undefined;
  append?: string | undefined;
  headerSet: Array<{ name: string; value: string }>;
  headerRemove: string[];
}): ServiceRewrite | undefined {
  const rewrite: ServiceRewrite = {};
  if (input.host !== undefined) rewrite.hostHeader = input.host;
  if (input.strip !== undefined) rewrite.pathPrefixStrip = input.strip;
  if (input.append !== undefined) rewrite.pathPrefixAppend = input.append;
  if (input.headerSet.length > 0) {
    const headerSet: Record<string, string> = {};
    for (const h of input.headerSet) headerSet[h.name] = h.value;
    rewrite.headerSet = headerSet;
  }
  if (input.headerRemove.length > 0) rewrite.headerRemove = input.headerRemove;
  return Object.keys(rewrite).length === 0 ? undefined : rewrite;
}

export function openStore(dataDir: string): ProviderStore {
  return ProviderStore.open(dataDir);
}
