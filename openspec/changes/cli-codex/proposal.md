# Change: cli-codex

## Why

Owner 需求（2026-09-12）：新增特殊 Provider "Codex"——上游
`https://chatgpt.com/backend-api/codex/responses`（HTTP + WS），鉴权不硬编码，
读取 codex CLI 的登录态 `~/.codex/auth.json` → `.tokens.access_token`
（Bearer）。这要求一种新的凭据读取标准。

## What Changes

1. **`$file:` 凭据引用**（src/provider/rewrite.ts，与 `$env:`/`$secret:` 并列）：
   - 语法 `$file:<path>#<json-path>[?bearer]`，如
     `$file:~/.codex/auth.json#.tokens.access_token?bearer`
   - `~` 在引用语法层展开（注入源收绝对路径）；json-path 为 jq 风格点径
     （`.a.b` / `.a[0].b`，须以 `.` 开头，parse 期校验）
   - **每请求读盘、无内存态**（与 $secret 同法则）：外部写入即刻生效，
     不需要缓存/watchFiles——磁盘 stat+read 是 µs 级，网络 RTT 才是瓶颈；
     watchFiles 会引入 fs watcher 常驻与跨平台复杂度，收益为零
   - 文件/键/空值未命中 → SecretMissingError（零上游请求；错误信息不含路径）
   - `?bearer` 拼前缀；缺省原样值
2. **Preset `codex`**（presets/providers.json）：route
   `/codex=/backend-api/codex`（form openai-responses——probe 追加 `/responses`
   后命中精确端点）、matchDomains chatgpt.com、defaultPort 4306、
   authHeader 预填 `$file:...`（零配置：本机 codex CLI 登录即用）。
   **Preset 契约新增 `authHeader?`**（优先级：显式 --secret > authHeader > keyEnv）
3. **apiForm 枚举扩展** `openai-responses`（契约 + upstream-test 最小
   探测构建器：POST /responses, input:"ping", max_output_tokens:1）
4. **service test 智能缺省**：未给 --form/--local-prefix 且命中唯一路由
   （或 --local-prefix 命中路由）时取该路由 forms[0] 与 localPrefix——
   responses-only 服务零参数可测（`ai-fly service test cx` 直接工作）
5. WS：无需新代码——gateway 对 https 上游的 WS 升级自动转 wss
   （ws-upstream 既有语义）；`ws://127.0.0.1:4306/codex/responses` 即入口

## 消费侧用法

- Codex CLI / agents：`OPENAI_BASE_URL=http://127.0.0.1:4306/codex`
  （wire_api=responses）→ 客户端拼 `/responses` → 本地 `/codex/responses`
  → 上游 `wss?://chatgpt.com/backend-api/codex/responses`
- WS 客户端直连 `ws://127.0.0.1:4306/codex/responses`

## 验证

- rewrite 50 例（$file 矩阵 6 例新增：bearer/原样/未命中/非法格式/纯函数/真实文件源）
- presets 23 例（凭据源断言更新：keyEnv 或 authHeader）+ CLI codex 预填 2 例
- 端到端（沙盒伪 auth.json）：`service add cx --preset codex` →
  `service test cx` → **POST https://chatgpt.com/backend-api/codex/responses**、
  401 "Could not parse your authentication token"（chatgpt.com 真实鉴权层拒绝
  伪 token——路由/$file 读取/Bearer 拼装全链路实证；真 token 即 200）
- 全量 531/531、tsc 绿

## 影响面

- wire 协议零变化（$file 是 provider 本地 rewrite 值域扩展，服务配置文件
  即可声明；旧服务不受影响）
- 契约 additive（authHeader?/apiForm 枚举扩展），旧客户端兼容
