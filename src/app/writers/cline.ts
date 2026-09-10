// cline 写手：VS Code（Code 变体：Cline / Continue / Roo 系）用户 settings.json。
// 写入键（Cline 的 OpenAI 兼容自定义端点设置面）：
//   "cline.openAiBaseUrl"：<本地端点>
//   "cline.openAiApiKey"：占位值（本地凭据不参与授权；网关剥离凭据头）
// 注意：Cline 新版本可能把 provider 凭据收敛进 VS Code SecretStorage（settings
// 键不可用时以 UI 内配置为准）；本写手按 settings 键形态落盘，快照测试锁定。
// JSONC 说明同 cursor 写手（可严格解析则逐字段保留；含注释时规范化）。

import { platform } from "node:os";
import { join } from "node:path";
import type { ResolvedTarget, WriterContext, WriterModule } from "./common.ts";
import { openAiChatBase, readJsonObjectFromText, serializeJson } from "./common.ts";

export const CLINE_PLACEHOLDER_KEY = "sk-aifly-local";

/** VS Code（Code）用户 settings.json 的平台路径（官方默认布局）。 */
export function vscodeUserSettingsPath(ctx: WriterContext): string {
  switch (platform()) {
    case "darwin":
      return join(ctx.home, "Library", "Application Support", "Code", "User", "settings.json");
    case "win32": {
      const appData = process.env.APPDATA ?? join(ctx.home, "AppData", "Roaming");
      return join(appData, "Code", "User", "settings.json");
    }
    default:
      return join(ctx.home, ".config", "Code", "User", "settings.json");
  }
}

export const clineWriter: WriterModule = {
  agent: "cline",
  configPath: vscodeUserSettingsPath,
  compose(existing: string | null, target: ResolvedTarget): string {
    const root = readJsonObjectFromText(existing ?? "", "VS Code settings.json");
    root["cline.openAiBaseUrl"] = openAiChatBase(target);
    root["cline.openAiApiKey"] = CLINE_PLACEHOLDER_KEY;
    return serializeJson(root);
  },
};
