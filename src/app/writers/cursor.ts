// cursor 写手：Cursor 的 VS Code 用户 settings.json（平台差异路径）。
// 写入键（2026-09 Cursor 的 OpenAI 兼容自定义端点形态）：
//   "openai.baseUrl.experimental"：<本地端点>（路径合成交给服务 upstream 自带的 /v1）
//   "openai.apiKey"：占位值（本地凭据不参与授权；网关剥离凭据头）
// 注意：settings.json 事实标准是 JSONC（允许注释/尾逗号）。本写手在文件可严格
// 解析时逐字段保留重写；含注释时字段保留、注释会被规范化掉（快照测试锁定该
// 行为，后续如需逐字保留可换 JSONC 感知编辑）。

import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { ResolvedTarget, WriterContext, WriterModule } from "./common.ts";
import { readJsonObjectFromText, serializeJson } from "./common.ts";

export const CURSOR_PLACEHOLDER_KEY = "sk-aifly-local";

/** Cursor 用户 settings.json 的平台路径（官方默认布局）。 */
export function cursorSettingsPath(ctx: WriterContext): string {
  switch (platform()) {
    case "darwin":
      return join(ctx.home, "Library", "Application Support", "Cursor", "User", "settings.json");
    case "win32": {
      const appData = process.env.APPDATA ?? join(ctx.home, "AppData", "Roaming");
      return join(appData, "Cursor", "User", "settings.json");
    }
    default:
      return join(ctx.home, ".config", "Cursor", "User", "settings.json");
  }
}

export const cursorWriter: WriterModule = {
  agent: "cursor",
  configPath: cursorSettingsPath,
  compose(existing: string | null, target: ResolvedTarget): string {
    const root = readJsonObjectFromText(existing ?? "", "Cursor settings.json");
    root["openai.baseUrl.experimental"] = target.baseUrl;
    root["openai.apiKey"] = CURSOR_PLACEHOLDER_KEY;
    return serializeJson(root);
  },
};

// homedir 引用占位：保持与其它写手一致的注入面（ctx.home 由调用方传入；
// 此导出仅供测试对照默认 home 行为）。
export const DEFAULT_HOME = (): string => homedir();
