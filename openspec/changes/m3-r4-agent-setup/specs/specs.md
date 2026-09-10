# Spec Deltas: m3-r4-agent-setup

## net-fly/provider

### ADDED Requirement: 按标准路由（routes）

服务可声明路由表 `routes: [{ form, localPrefix, upstreamPrefix }]`，form ∈
`openai-chat | openai-responses | anthropic`，localPrefix 固定为 `/openai`、
`/responses`、`/anthropic` 之一（同一服务内 localPrefix 不得重复）。提供方转发时，
请求 path 依最长 localPrefix 段边界匹配命中路由后改写为
`upstreamPrefix + (path − localPrefix)`，再走既有 upstream 基路径拼接；未命中或
无路由表时 path 原样透传。路由改写优先于服务级 pathPrefixStrip/Append。

#### Scenario: DeepSeek Anthropic 形态

- 服务 upstream `https://api.deepseek.com`，routes 含
  `{anthropic, /anthropic, /anthropic}`；本地端口收到 `POST /anthropic/v1/messages`
  → upstream `https://api.deepseek.com/anthropic/v1/messages`。

#### Scenario: 无路由服务透传不变

- 未声明 routes 的既有服务，`POST /v1/chat/completions` 照旧透传拼接，行为与
  引入 routes 前完全一致（集成回归钉死）。

## app/ui

### MODIFIED Requirement: agent setup（ConnectWizard ③）

③ 步 agent 与服务下拉使用原生 select（无 popover 依赖）；「skip / finish」路径
在任何状态下可达（preview 失败仅禁用写入按钮并就地展示错误）。按所选服务 routes
呈现各 API 标准的本地 base（如 `http://127.0.0.1:<port>/anthropic`），agent 按
其使用的标准（claude-code→anthropic、codex→openai-responses、cursor/cline/
continue→openai-chat）匹配可用性，服务不提供该标准路由时标注不可用。每个可用
标准提供 test 按钮。

#### Scenario: agent 死锁解除

- preview RPC 失败时：错误就地展示，"write agent config" 禁用，"skip (configure
  later)" 与 finish 路径仍可操作。

#### Scenario: 消费侧连通测试

- 点击某标准 test → 对 `http://127.0.0.1:<port>` 发该标准最小请求（不带凭据）→
  返回 ok/latencyMs/httpStatus/error（正文摘录）呈现于按钮旁。

### ADDED Requirement: consumer.services.test RPC

输入 `{serviceId, form}`，由 app 进程对本机网关端口发最小形状请求，走完整
wire 链路；返回 `{ok, latencyMs, httpStatus?, error?, bodyExcerpt?}`。凭据由提供
方 rewrite 注入，消费侧请求不携带 authorization。

### MODIFIED Requirement: 自定义服务表单

自定义模式 ② 步提供三条路由的 upstream path 输入（openai chat completions /
openai responses / anthropic messages），留空 = 不提供该标准路由；创建服务时
routes 随服务落库。

## presets

### MODIFIED Requirement: curated 精选集

curated 收缩为 openai / anthropic / deepseek 三家，各自携带 routes 定义；
`presetToServiceInput` 展开时 routes 随行进服务。其余厂商从 curated 摘除。
