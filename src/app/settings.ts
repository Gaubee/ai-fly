// 应用设置（system.settings 契约的持久化）：~/.aifly/settings.json。
// 主题偏好 / models.dev 开关 / relay 入口。设置是低敏数据但与 CLI 共目录，
// 沿用 0700/0600 私有语义（ensurePrivateDir + 原子写）。
// 损坏文件回退默认值（设置不承载关键状态，不应挡死 UI 启动）。

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SETTINGS_SCHEMA, type Settings } from "../shared/rpc-contract.ts";
import { atomicWriteFileSync, ensurePrivateDir } from "../provider/store.ts";

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  modelsDevEnabled: true,
  relayUrls: null,
  opendwebServer: null,
};

export function settingsPath(base = homedir()): string {
  return join(base, ".aifly", "settings.json");
}

export function loadSettings(base = homedir()): Settings {
  try {
    const raw = readFileSync(settingsPath(base), "utf8");
    return SETTINGS_SCHEMA.parse(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 补丁式保存（仅覆盖提交的字段；未提交字段保持现状）。 */
export function saveSettings(patch: Record<string, unknown>, base = homedir()): Settings {
  const current = loadSettings(base);
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value;
  }
  const next = SETTINGS_SCHEMA.parse(merged);
  const dir = join(base, ".aifly");
  ensurePrivateDir(dir);
  atomicWriteFileSync(settingsPath(base), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
