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
- [x] 14.（Owner 再裁决）API ROUTES 提升主面板第一屏直出（upstream 之后），
      不再折叠在 advanced options；port/match 维持收纳。实证：手风琴关闭态
      三路由输入均可见，DOM 序 upstream → api routes → service name →
      advanced options

## M3-r6 追加（Owner 连续三裁决：路径路由客观化）

- [x] 15. 拦截粒度 = 版本段（/v1 而非 /v1/responses）；路由模型改为通用
      from→to 规则（forms 数组标注 AI 标准供消费侧判定，引擎转发与 forms
      无关）；本地前缀 localPrefix 成为规则自带字段（缺省按 forms 派生）
- [x] 16. 表单路由区客观化（无 OPENAI/ANTHROPIC 字样标签）：行 = from input
      + bind toggle + to input（绑定态 to 镜像 from 只编辑一个；解绑自由
      编辑双侧）+ 行删除 + add route；预览行 from/* → upstream+to/*；
      零配置限制（"must end with" 校验移除，形状归一在组装期）
- [x] 17. 预设镜像 1:1：openai /v1→/v1（chat+responses 同规则）、
      anthropic /v1→/v1、deepseek /v1→/v1 + /anthropic→/anthropic（全绑定态
      预填）；writers 适配（openai 家族 base=localPrefix 原样、anthropic 剥
      尾部版本段、codex responses wire_api）；consumer.test/端点行按规则
      localPrefix 探测
- [x] 18. 回归与实证：vitest 461/462（1 例 8790 环境占用）+ 集成 25/25 +
      build/check/typecheck ✓；实机：② 双行绑定态预填与预览、解绑改 to 后
      预览随动、回绑恢复；/user/balance → 404 白名单、/v1/* 与
      /anthropic/v1/messages → 401 governor（真实 DeepSeek，版本段拦截直通
      官方路径）

## M3-r7 追加（Owner 裁决：排序命中 + pattern 模式）

- [x] 19. 排序命中：路由按声明顺序匹配（先声明先赢，取消最长前缀优先）；
      ② 行 UI 加 ↑/↓ 排序按钮（首/末行对应方向禁用）
- [x] 20. pattern 模式：matchPattern（URLPattern pathname 表达式；{name}
      花括号语法编译期翻译为 :name 兼容 Node/Ada 运行时）+ template
      （RFC 6570 URI Template，变量域 = 捕获组 + 请求查询参数；产物含查询串
      则替换）。uri-template.ts 独立模块（Level 1-2 操作符全集 + pct-encode）
      + match-pattern.ts（编译缓存）；store 写入期 fail-fast 校验
- [x] 21. 消费侧适配：端点 base/测试探测仅 prefix 模式规则可给（pattern 无
      稳定前缀面）；可用性判定仍按 forms（含 pattern 行）
- [x] 22. 回归与实证：rewrite 44 + store 22 + uri-template 14 单测全绿；
      集成 25/25。实机决定性证据（upstream 互换成假记录器 + 文件同步通道）：
      本地 POST /v1/chat/completions → upstream 收到 POST /relay/chat/completions
      （pattern 置顶命中 + RFC 6570 改写 + 顺序优先）；GET /v1/models →
      pattern 未命中落 prefix 规则原样转发；/a/*、/user/balance → 404 白名单

## M3-r8 追加（Owner 裁决：③ 步 = test，agent setup 移除）

- [x] 23. ③ 步重做：agent setup 整段移除（AGENT_OPTIONS/writers preview/
      apply/writer 状态全删），StepHeader 第三步更名 "test"；卡片 = 协议选择
      （openai / openai responses / anthropic，可变表达）+ endpoint 选择
      （中性路由表达 `/v1 → upstream/v1/*`，无 API 标准名）+ 单输入框
      （默认 hi，Enter 或 send 发起，单轮）+ 结果面板（ok/failed + latency +
      HTTP + POST url + bodyExcerpt 滚动区）
- [x] 24. 契约与链路：consumer.services.test 增 content（max 8192，缺省
      "hi"）；local-test 成功也读回复正文（BODY_EXCERPT_MAX=2000）；协议
      切换端点联动（setTestProtocol：当前端点不承载该协议时跳到首个承载
      端点，承载则保留用户手选）；footer = back + finish 恒可达
- [x] 25. 回归与实证：vitest 487/487 + 集成 25/25 + svelte-check 基线 30 +
      typecheck ✓。实机（Home 组真链接全链路）：③ 无 "agent setup"/"api
      endpoints"/"openai (chat completions)" 字样；anthropic 协议 → 端点
      自动跳 /anthropic → POST :4304/anthropic/v1/messages → HTTP 200
      189ms deepseek-v4-flash 真实回复（thinking + text + usage）正文呈现；
      openai 协议回跳 /v1 → /v1/chat/completions → HTTP 200 deepseek-flash
      真实回复；测试 key 5 枚已 revoke、消费环 forget、headless 已回收

## M3-r9 追加（Owner 裁决：opendweb server 管理 + Advanced test 同形 + relay 纠偏）

- [x] 26. relay URL scheme 纠偏：http(s):// 才是正确形态（dweb-server Rust
      对非 http(s) 条目禁用 + WARNING；n0 默认即 https；fabric crate 同规）；
      webui relayForm 校验/placeholder/文案从 wss:// 误植全部改正
- [x] 27. opendweb server 管理：settings.opendwebServer（enabled/gatewayBind/
      relayBind/relayEnabled，default(null) 兼容旧文件迁移）+ 子进程管理器
      （OpendwebServerManager：对账启停/配置变化重启/崩溃观测，startImpl 注入
      8 单测）+ system.opendweb.status RPC + settings.set 联动对账 + 随 app
      自启/退出回收；Advanced 新 tab（状态面板/绑定表单/启停）+ RelayPickerDialog
      （SDK 默认 / 自己的服务器（须在跑）/ 自定义清单 三选；打开上升沿一次
      初始化 untrack 防 status 异步到达重置用户选择）
- [x] 28. Advanced services 行内 test 对齐 connect ③（同形 ServiceTestCard
      共享组件：协议+端点选择（协议→端点联动）+ 单轮输入框 + 结果面板）：
      provider.services.testRoute（formProbe 构造 → buildUpstreamRequest 路由
      命中/白名单 → rewrite $secret/$env 注入 → 直打 upstream；request.url =
      改写后上游 URL；4 单测）；local-test formProbe 导出复用；connect store
      状态瘦身（协议/端点/提示词移交组件）
- [x] 29. 三端 e2e（本地 opendweb server + 双 ai-fly 实例）：独立 provider
      （/tmp 数据 dir）+ CLI consumer；两组 e2e-a（openai 形态）/e2e-b
      （anthropic 形态）各自走通——经自有 relay（--relay http://127.0.0.1:3340）
      收到 OpenAI/Anthropic 真实 401 预期错误正文（网络全链路证明）；撤 A 组
      key → A 断供 B 不受影响（隔离）。发现：ai-fly run 不读链接内嵌 relay
      （flag>env>file>n0 默认）——本地 relay 场景需显式 --relay（app 内消费
      网关走 settings.relayUrls 不受影响；run 回退 ring 内嵌 relay 列为跟进项）
- [x] 30. 回归：vitest 499/499 + 集成 25/25 + svelte-check 基线 30 + typecheck ✓；
      e2e 资产全清（tmp 数据/服务/分组/key/Owner settings relayUrls 复位）
