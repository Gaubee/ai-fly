// codex 写手：~/.codex/config.toml（官方约定路径）。
// 语义：[model_providers.ai-fly] 表——base_url 指向所选服务本地端点（路径合成
// 交给服务的 upstream：openai 形上游自带 /v1，本地端点不追加路径）；
// env_key 指向本机占位密钥（本地凭据不参与授权：网关剥离凭据头，跨网凭据走
// fabric 钥环）。
// TOML 编辑策略：文本级手术——只替换 [model_providers.ai-fly] 块（到下一个
// 表头或 EOF），其余行逐字保留（避免全量重序列化重排/丢注释）。

import { join } from "node:path";
import type { WriterContext, ResolvedTarget, WriterModule } from "./common.ts";

const SECTION_HEADER = "[model_providers.ai-fly]";

function buildSection(target: ResolvedTarget): string {
  return [
    SECTION_HEADER,
    'name = "ai-fly"',
    `base_url = "${target.baseUrl}"`,
    'env_key = "AIFLY_API_KEY"',
    'wire_api = "chat"',
    "# managed by ai-fly - local auth is a placeholder; credentials ride the fabric keyring",
  ].join("\n");
}

export const codexWriter: WriterModule = {
  agent: "codex",
  configPath(ctx: WriterContext): string {
    return join(ctx.home, ".codex", "config.toml");
  },
  compose(existing: string | null, target: ResolvedTarget): string {
    const section = buildSection(target);
    if (existing === null) return `${section}\n`;
    const lines = existing.split("\n");
    const headerIdx = lines.findIndex((line) => line.trim() === SECTION_HEADER);
    if (headerIdx < 0) {
      const joined = existing.endsWith("\n") ? existing : `${existing}\n`;
      return `${joined}\n${section}\n`;
    }
    // 块尾：下一个顶层表头（[table] 形，容忍缩进 0）或 EOF
    let end = lines.length;
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (/^\s*\[.+\]\s*$/.test(lines[i]!)) {
        end = i;
        break;
      }
    }
    const before = lines.slice(0, headerIdx);
    const after = lines.slice(end);
    const next = [...before, section, "", ...after];
    let text = next.join("\n");
    if (!text.endsWith("\n")) text += "\n";
    return text;
  },
};
