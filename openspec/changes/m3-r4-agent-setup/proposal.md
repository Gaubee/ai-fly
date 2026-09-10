# Proposal: m3-r4-agent-setup — 按标准路由 + agent setup 修复与消费侧测试

## Why

Owner 验收推进到 agent setup 阶段（2026-09-10），三项反馈：

1. **Agent 无法选、跳过也做不了**：③ 步页脚按钮互斥造成死局——非 skip 状态唯一推进
   按钮 "write agent config" 在 `writerPreview === null`（preview RPC 失败 / 服务清单
   空）时禁用，而 "finish" 仅在 `agent === "skip" || writerDone` 时渲染；且 agent 下拉
   用 popover Select（Popover API + CSS Anchor Positioning），webview 环境下可能整个
   面板打不开。
2. **该阶段缺 test**：消费侧 RPC 子树没有任何连通测试——导入后用户无从知道本地端口
   → fabric → upstream 全链路是否真的能跑通。
3. **路径管理没有"标准"概念**：一个服务只有一个 upstream + path 透传。DeepSeek 官方
   同时支持 OpenAI 与 Anthropic 两种标准，但 Anthropic 形态挂在 `/anthropic` 路径前缀
   下；现在 agent setup 只把裸 `http://localhost:4304` 写进 agent 配置，Claude Code 打
   过去 `/v1/messages` 直接 404。Owner 裁决：本轮只打磨 OpenAI / Anthropic / DeepSeek
   三家预设（两种通用标准 + 开源，覆盖国内外），自定义 = 最原始的按标准路径转发规则
   （至少 chat completions / OpenAI responses / Anthropic 三条路由）。

## What Changes

- **服务路由表（routes，核心模型）**：service schema 新增可选 `routes`：
  `[{ form: "openai-chat" | "openai-responses" | "anthropic", localPrefix, upstreamPrefix }]`。
  本地端口固定暴露三个标准前缀 `/openai`、`/responses`、`/anthropic`；请求路径按
  最长段边界匹配 localPrefix → `upstreamPrefix + (path − localPrefix)` 后走既有
  upstream 拼接。无路由或未命中 → path 原样透传（完全向后兼容，既有服务与裸 base
  URL 用法不变）。改写执行在 `buildUpstreamRequest`，route 优先于服务级
  pathPrefixStrip/Append。
- **预设收缩与打磨**：curated 集收缩为 OpenAI / Anthropic / DeepSeek 三家，各带
  routes（DeepSeek：openai→/、responses 不提供、anthropic→/anthropic；OpenAI：
  openai→/、responses→/；Anthropic：anthropic→/）；`presetToServiceInput` 展开时
  routes 随行。其余 15 家从 curated 摘除（models.dev 长尾仍可搜到同类）。
- **agent 修复**：③ 步 agent/service 下拉换 NativeSelect（无 popover 依赖）；
  "skip (configure later)" 永远可达——preview 失败只禁用 "write" 按钮并就地展示
  错误，finish/skip 路径始终渲染。
- **按标准的端点呈现**：③ 步按所选服务 routes 列出各标准本地 base
  （`http://127.0.0.1:<port>/anthropic` 等）；agent→form 映射
  （claude-code→anthropic、codex→responses、cursor/cline/continue→openai-chat），
  服务不含该 form 时该 agent 标注不可用；writers 写入的 base URL 带对应前缀。
- **消费侧测试（consumer.test）**：新增 RPC `consumer.services.test`
  `{serviceId, form}` → 由 app 进程对本机端口发最小请求（按 form 构造 openai /
  responses / anthropic 形状，不带凭据——凭据由提供方 rewrite 注入），走完整
  wire 链路，返回 ok/latencyMs/httpStatus/error + 正文摘录。③ 步每个可用 form 一个
  test 按钮。
- **自定义路由 UI**：ShareWizard 自定义模式 ② 步提供三条路由的 upstream path 输入
  （chat completions / responses / anthropic），留空 = 该标准不提供该路由。

## Impact

- 影响 specs：`app`（服务 schema/RPC/writers/向导流）、`presets`（curated 收缩 +
  routes）、`net-fly`（provider rewrite 路由匹配）。
- 代码面：`src/shared/rpc-contract.ts`、`src/provider/{store,rewrite}.ts`、
  `presets/providers.json`、`src/app/{rpc-router,writers/*}.ts`、消费侧测试新文件、
  `webui/src/pages/{ConnectWizard,ShareWizard}.svelte` + `stores/connect-wizard.svelte.ts`。
- 风险：routes 匹配的正确性（段边界、最长前缀、大小写）以单测钉死；既有无 routes
  服务行为不变以集成测试回归。

## Non-Goals

- 国内厂商文件接口（kimi/glm/deepseek 文件 API）的路由——Owner 明确本轮不做。
- 多密钥/多 upstream 聚合、负载均衡。
- models.dev 长尾预设的 routes 标注。
