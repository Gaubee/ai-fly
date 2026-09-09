// 全局配置：~/.aifly/config.json（目录 0700 / 文件 0600）。
// 优先级 flag > env > file > default（与 opendweb 生态一致）。
// v1 仅承载 relay 入口；后续配置项在此 schema 上扩展。

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { CliError } from "./errors.ts";

const CONFIG_DIR_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;

export const configFileSchema = z.object({
  /** relay 入口 URL 列表（自托管 gateway 地址，如 http://192.168.2.13:8787） */
  relayUrls: z.array(z.string().url()).optional(),
});

export type ConfigFile = z.infer<typeof configFileSchema>;

export function configDir(base = homedir()): string {
  return join(base, ".aifly");
}

export function configPath(base = homedir()): string {
  return join(configDir(base), "config.json");
}

/** 读取并校验配置文件；不存在返回 {}；损坏/非法时抛 CliError（不静默重置）。 */
export function loadConfig(base = homedir()): ConfigFile {
  const p = configPath(base);
  if (!existsSync(p)) return {};
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err) {
    throw new CliError(`error: cannot read config ${p}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`error: config ${p} is not valid JSON (fix or remove it manually)`);
  }
  const result = configFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new CliError(`error: config ${p} failed validation: ${result.error.message}`);
  }
  return result.data;
}

/** 整体写入配置文件（读-改-写由调用方组态）；目录/文件权限收紧。 */
export function saveConfig(next: ConfigFile, base = homedir()): void {
  const p = configPath(base);
  mkdirSync(dirname(p), { recursive: true, mode: CONFIG_DIR_MODE });
  writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`, { mode: CONFIG_FILE_MODE });
  try {
    chmodSync(p, CONFIG_FILE_MODE);
  } catch {
    // 某些文件系统不支持 chmod；尽力而为
  }
}

/**
 * 解析生效的 relay 入口：flag > 链接内嵌（import 消费侧）> env(AIFLY_RELAY，逗号
 * 分隔) > config file。返回 undefined 表示走 SDK 默认（n0 公共 relay）。
 * 链接层级的语义：aifly1. 链接内嵌的 relayUrls 是提供方签发 invite 的入口——
 * 兑换与后续连接都必须发生在同一 relay 网，故高于机器级 env/config（2026-09-09
 * 实机踩坑：不带 --relay 时落 SDK 公网默认，兑换成功但连接永败且无提示）。
 */
export function resolveRelayUrls(input: {
  flag?: readonly string[];
  /** 链接内嵌 relay 入口（import 命令传入；空数组视为缺席）。 */
  link?: readonly string[];
  env?: string | undefined;
  file?: ConfigFile;
}): string[] | undefined {
  const fromFlag = input.flag?.filter((u) => u.length > 0);
  if (fromFlag && fromFlag.length > 0) return [...fromFlag];
  const fromLink = input.link?.filter((u) => u.length > 0);
  if (fromLink && fromLink.length > 0) return [...fromLink];
  const envRaw = input.env?.trim();
  if (envRaw) {
    const urls = envRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (urls.length > 0) return urls;
  }
  const fromFile = input.file?.relayUrls;
  if (fromFile && fromFile.length > 0) return [...fromFile];
  return undefined;
}
