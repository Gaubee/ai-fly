# Tasks: m3-r4-agent-setup

- [x] 1. 契约与存储：rpc-contract 服务输入/detail 增 routes（form/localPrefix 派生常量 + upstreamPrefix，store 写入期规范化/去重）；wire SERVICE_DETAIL_SCHEMA 同步
- [x] 2. 改写执行：rewrite.buildUpstreamRequest 前置路由匹配（最长 localPrefix、段边界、未命中透传）；单测 8 例（DeepSeek 双形态/段边界/根命中/base path 组合/query 保留/回归）
- [x] 3. 预设收缩：providers.json curated 收缩为 openai/anthropic/deepseek 三家各带 routes（openai base 去 /v1 交路由模型）；presetToServiceInput routes 随行；upstream-test 探测路径版本段自适应；测试更新（presets/web-server/integration）
- [x] 4. 消费侧测试 RPC：consumer.services.test（本机端口按 form 最小请求，模型缺省经 models.dev 缓存按 detail.upstream 选最便宜 chat）；local-test 单测 7 例
- [x] 5. writers 按标准写 base：ResolvedTarget.formBase + openAiChatBase/anthropicBase；codex 分支 responses wire_api；writer 单测 formBase 4 例
- [x] 6. ConnectWizard ③：NativeSelect agent/service；skip/finish 永远可达；按服务 routes 列各标准 base；每 form test 按钮；preview 失败不堵路（子代理交付 + 编排者补 live 端口刷新/服务标签带端口）
- [x] 7. ShareWizard 自定义②：三条路由 upstream path 输入（留空=不提供）；服务创建携带 routes（子代理交付）
- [x] 8. 回归：vitest 459/459 + 集成 25/25 + webui build ✓ + svelte-check 基线 30 + 根 typecheck ✓；
      headless 实机证据：DeepSeek 双形态 test 经完整 fabric 链路打到真实上游——
      POST :port/anthropic/v1/messages → api.deepseek.com/anthropic/v1/messages → 401
      "Authentication Fails (governor)"（DeepSeek 真实回包 = 路径正确；错路径是 404）；
      openai 形态同证。附带修复：ProviderStatus.ports 曾返回 keyring 投影而非网关
      实际监听（auto-assign 失真）——RPC 层统一 livePorts() 合并（status/test/writers）。

## M3-r5 追加（Owner 后续验收：预设=可编辑 Custom + 路由可见 + 白名单保护）

- [x] 9. 路由白名单语义：声明了 routes 的服务，未命中任何标准前缀的路径本地 404
      （path_not_offered 新 wire 错误码，零上游请求）——防 /user、/balance 等
      个人信息端点被凭据打穿；无 routes 服务照旧透传（回归钉死）
- [x] 10. DeepSeek 预设补 openai-responses 路由（官方已支持 codex）
- [x] 11. 预设 = 预填的 Custom：选预设展开 upstream/match/port/路由进 ② 表单全部
      可编辑；两模式同一条本地组装提交路径（applyAsService 留给 CLI）；路由输入
      语义改为「端点完整路径」（默认=官方 path，剥标准尾段得 upstream 前缀）
- [x] 12. 路由映射可见：② 表单每条路由下方 + ③ 结果摘要 + 消费 ③ 端点行
      「→ {upstream}{prefix}/...」注记（detail.upstream 捕获）
- [x] 13. 回归与实证：vitest（1 例环境性 8790 占用外全绿）+ 集成 25/25 + build/
      check/typecheck ✓；实机：② 预填三条官方路径与映射行；/user/balance 与裸
      /v1/chat/completions → 404 path_not_offered（零上游）；/anthropic/v1/messages
      → 401 governor（真实 DeepSeek）
