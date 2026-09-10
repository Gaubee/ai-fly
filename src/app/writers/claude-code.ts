// claude-code 写手：~/.claude/settings.json 的 env 块（官方约定：settings.json
// 支持 env 键注入环境变量；Claude Code 读 ANTHROPIC_BASE_URL /
// ANTHROPIC_AUTH_TOKEN）。
// 本地 AUTH_TOKEN 是占位值（本地网关剥离凭据头，跨网凭据走 fabric 钥环）——
// 不写入任何真实密钥；原子写 0600 已覆盖「写 key 需收紧权限」的降级语义。

import { join } from "node:path";
import type { ResolvedTarget, WriterContext, WriterModule } from "./common.ts";
import { objectField, readJsonObjectFromText, serializeJson } from "./common.ts";

export const CLAUDE_CODE_PLACEHOLDER_TOKEN = "sk-aifly-local";

/** Claude Code 的 base：服务声明 anthropic 路由 → 标准前缀（client 追加
    /v1/messages 等，路由映射到 upstream 侧真实前缀）；无路由沿用裸 base
    （anthropic 原生 upstream 直接透传——旧行为）。 */
function anthropicBase(target: ResolvedTarget): string {
  return target.formBase?.anthropic ?? target.baseUrl;
}

export const claudeCodeWriter: WriterModule = {
  agent: "claude-code",
  configPath(ctx: WriterContext): string {
    return join(ctx.home, ".claude", "settings.json");
  },
  compose(existing: string | null, target: ResolvedTarget): string {
    const root = readJsonObjectFromText(existing ?? "", "settings.json");
    const env = objectField(root, "env", "settings.json");
    env["ANTHROPIC_BASE_URL"] = anthropicBase(target);
    env["ANTHROPIC_AUTH_TOKEN"] = CLAUDE_CODE_PLACEHOLDER_TOKEN;
    root["env"] = env;
    return serializeJson(root);
  },
};
