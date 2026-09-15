# presets Delta

## MODIFIED Requirements

### Requirement: 预设数据契约（双面模板）

预设 SHALL 为仓库内 JSON（`presets/providers.json`，每条含出处注释字段）：`id`、`label`、`apiForm`（openai-completions | openai-responses | anthropic-messages | gemini-native）、`baseUrl`（官方 API 端点；含版本段时照抄原文——各 apiForm 的请求构造按版本段感知拼装，不重复补 /v1）、`auth`（认证绑定：密钥库建议 / 脚本钩子引用——落地为服务生命周期 auth 槽）或 `hooks`（**预设模式**：`{script}` 整段生命周期绑定——脚本自带 ②③ 等阶段导出，如 codex 预设提供完整 onRequestHeaders 与 onRequest）、`keyEnv`（惯用环境变量名，仅用于提供方注入建议与文档；本地运行时模板无此字段）、`defaultPort`（使用方本地端口建议，特权端口须避开 1024）、`matchDomains`（官方域名集，exact/suffix 建议）、`notes`。精选集 SHALL 覆盖：OpenAI、Anthropic/Claude Code、Gemini、OpenRouter、DeepSeek、z.ai（含 coding/国内站双端点）、Kimi/Moonshot（双协议）、Minimax、Qwen token-plan、GitHub Copilot、groq、xai、together、Ollama、LM Studio（后两者为本地运行时模板，无 keyEnv）。所有 URL/变量名 SHALL 以调研出处为准抄录，禁止臆造。预设落服务 SHALL 直吐生命周期 v2 槽位。

#### Scenario: 预设可直接落服务

- **WHEN** 用户在提供方向导选择 z.ai 预设并填入密钥
- **THEN** 生成的服务 upstream/match/defaultPort 与预设一致，auth 槽为密钥库引用，detail 披露中凭据为 `●`
