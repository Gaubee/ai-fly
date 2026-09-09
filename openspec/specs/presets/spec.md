# presets Specification

## Purpose

定义 AI 预设库与 Agent 配置写手：双面模板（提供方服务模板 / 使用方 Agent 配置模板）的数据契约、精选来源（DL-5）、models.dev 长尾扩展、写手行为（diff 预览 + 原子写）。

## Requirements

### Requirement: 预设数据契约（双面模板）

预设 SHALL 为仓库内 JSON（`presets/providers.json`，每条含出处注释字段）：`id`、`label`、`apiForm`（openai-completions | anthropic-messages | gemini-native）、`baseUrl`（官方 API 端点）、`keyEnv`（惯用环境变量名，仅用于提供方 `$env` 注入建议与文档）、`defaultPort`（使用方本地端口建议，特权端口须避开 1024）、`matchDomains`（官方域名集，exact/suffix 建议）、`notes`。精选集 SHALL 覆盖：OpenAI、Anthropic/Claude Code、Gemini、OpenRouter、DeepSeek、z.ai（含 coding/国内站双端点）、Kimi/Moonshot（双协议）、Minimax、Qwen token-plan、GitHub Copilot、groq、xai、together、Ollama、LM Studio（后两者为本地运行时模板，无 keyEnv）。所有 URL/变量名 SHALL 以 2026-09-09 调研出处为准抄录，禁止臆造。

#### Scenario: 预设可直接落服务

- **WHEN** 用户在提供方向导选择 z.ai 预设并填入 `$env:ZAI_KEY`
- **THEN** 生成的服务 upstream/match/defaultPort 与预设一致，detail 披露中凭据为 `●`

### Requirement: models.dev 长尾扩展

SHALL 支持运行时拉取 `https://models.dev/api.json`：读取 provider 级 `id/name/env/api`（npm 字段用于 apiForm 归类）合入预设列表（标记 source: models.dev）；结果 SHALL 缓存于数据目录（TTL 7 天），拉取失败回退缓存与精选集；设置中可禁用动态扩展。

#### Scenario: 断网仍可用精选

- **WHEN** 无网络且无缓存时打开向导
- **THEN** 精选预设全部可选，长尾区显示"扩展不可用"状态而非报错

### Requirement: Agent 配置写手（使用方）

`codex / claude-code / cursor / cline / continue` 各 SHALL 实现：定位本机配置文件（按各 Agent 官方约定路径）、生成 base-url 指向所选服务本地端点的配置片段（密钥经环境变量间接引用优先；不支持 env 间接的写 key 并提示收紧权限）。写手 SHALL 两段式：`preview` 返回统一 diff + 目标路径；`apply` 原子写（tmp+rename，保留其余配置字段，已存在同名条目更新不重复追加）。webview 场景 SHALL 渲染 diff 并需用户确认。

#### Scenario: codex 写手 diff 后写入

- **WHEN** 用户选择 codex 并确认 diff
- **THEN** 配置文件新增/更新 ai-fly provider（base_url 指向所选服务端口），diff 与实际落盘一致

#### Scenario: 不破坏既有配置

- **WHEN** 目标配置文件已有用户的其它 provider
- **THEN** 仅 ai-fly 相关条目变化，其余字段逐字保留
