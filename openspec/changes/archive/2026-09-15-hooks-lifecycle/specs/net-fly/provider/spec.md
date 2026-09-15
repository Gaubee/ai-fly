# net-fly/provider Delta

## ADDED Requirements

### Requirement: hooks 生命周期管线

提供方 SHALL 以四段生命周期管线组织每服务的出站处理，执行顺序固定为
`onRequestBearerAuthentication → onRequestHeaders → onRequest → onResponse`
（路由解析与入站凭据剥离为管线前置，不属可配置阶段）：

- **① auth（onRequestBearerAuthentication）**：配置槽 `service.auth` 三族单选
  （`{secret}` 密钥库引用 / `{script, args?}` 脚本 / `{literal}` 字面量）+ 可选
  `bearer: true`（裸值拼 `Bearer ` 前缀；已以 Bearer 开头则不重复）。脚本导出名
  SHALL 为 `onRequestBearerAuthentication`，返回裸值（前缀由配置拼）。
- **② headers（onRequestHeaders）**：配置槽 `service.headers` = `remove[]` +
  `set{}`（值协议：**仅字面量 string**——动态值经 `$env:<VAR>` / `$secret:<name>`
  间接引用或交给整段脚本；不做逐头脚本对象协议）+ 可选整段 `script`（导出名
  `onRequestHeaders`，返回 `{set?, remove?}` 增量合并）。头处理固定顺序：
  入站剥离 → auth 值注入 → remove（声明）→ set（声明）→ 脚本增量（脚本 remove
  后 set，**脚本胜**）→ 防护头再过滤（host/hop-by-hop/content-length 规则重放）；
  同名头 last-wins。
- **③ request（onRequest）**：配置槽 `service.request`（`{script, args?}`）整体
  接管出站。脚本 ctx 为 `{ url, method, headers, body: Uint8Array, signal }`，
  SHALL 返回 `{ status: number(200–599), headers: Record<string,string>,
  body?: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> }`；body 缺省 =
  空流（204/304 等无正文状态合法）。绑定 request 脚本时 SHALL 跳过连接期探测
  （连接语义归脚本）。无绑定时为原生 fetch。
- **④ response（onResponse）**：配置槽 `service.response`（`{script, args?}`），
  ctx 为 `{ status, headers, body: AsyncIterable<Uint8Array>, signal }`，返回
  `{ status?, headers?, body? }` 局部覆盖；头键小写化、last-wins，可写范围限
  RESP_META 白名单三头 + `content-type`（引擎投影至 RESP_META 独立 contentType
  字段；status 204/304 时 contentType 归一为空；③ 返回 headers 中的
  `content-type` 同样投影）；调用时机为上游响应归一后、RESP_META 下发前。

**出站归一层**：原生 fetch 结果与 ③ 脚本结果 SHALL 统一归一为
`{ status, headers, body: AsyncIterable<Uint8Array> }`，转发循环只消费归一形；
③ 返回的 headers 统一小写化、last-wins、经 RESP_META 白名单过滤（非白名单头
忽略，`content-type` 独立投影至 contentType 字段——与 ④ 同规则）；SSE MUST
逐块产出（禁止缓冲攒齐）；引擎中止 SHALL 取消归一迭代器（脚本流被取消）。

**阶段 ctx 超集**：所有阶段 ctx 含既有 `{ homedir, args, secrets, env }`；①②
附请求级 `{ method, path, headers }`。**① 三态返回契约**（string \|
Promise\<string\> \| AsyncIterable\<string\>）与订阅缓存语义平移保留（仅 ①——
② 返回对象无订阅语义）。**② 脚本返回**：`{set?, remove?}` 对象（同步或
Promise）；`{}` 为合法 no-op；绑定声明但导出缺失 / 抛错 / 返回形状非法 →
`hook_failed`（与 ③④ 同族）。

**错误映射**：① 脚本缺席/抛错/空产出归既有 `secret_missing` 族（零上游请求、
消息不泄脚本名与值）；②③④ 脚本缺席（绑定声明但导出缺失）、抛错、返回形状
非法、流中途失败 SHALL 以新错误码 `hook_failed` 回送（消息同样脱敏）。

#### Scenario: 阶段按序组装

- **WHEN** 服务绑定 auth script 且 headers 配置 remove/set，使用方发起请求
- **THEN** 出站请求头按「入站剥离 → auth 值注入（含 bearer 前缀）→ headers.remove → headers.set → 脚本增量」组装，auth 脚本可读到该请求的 method/path/headers

#### Scenario: 脚本增量胜过声明式

- **WHEN** headers.set 声明 `X-A: declared` 而 ② 脚本返回 `{set: {"x-a": "script"}}`
- **THEN** 上游收到 `X-A: script`；脚本返回的 remove 对声明式 set 同样生效

#### Scenario: onRequest 接管出站并流式回传

- **WHEN** 服务绑定 request 脚本，其返回 body 为逐块 AsyncIterable
- **THEN** 跳过连接期探测，脚本收到完整请求描述子（含 body 与 signal），其产出的 body 块逐块下发使用方（无整段缓冲）；使用方中止时脚本流被取消

#### Scenario: onResponse 改写响应

- **WHEN** 服务绑定 response 脚本且上游返回 200 JSON
- **THEN** 脚本可改写 status 与白名单内头并流式变换 body；白名单外的头修改被忽略

#### Scenario: 脚本失效的错误归置

- **WHEN** auth 阶段脚本抛错 → 该请求以 `secret_missing` 拒绝；request 脚本返回形状非法 → 以 `hook_failed` 回送
- **THEN** 两者错误消息均不含脚本路径与返回值，且前者零上游请求

## MODIFIED Requirements

### Requirement: 服务模型与持久化

提供方 SHALL 以本地存储（数据目录内，目录 0700、文件 0600，原子写 tmp+rename）
管理**服务**：存储文件带 `version: 2` 标记。每服务含 `serviceId`（8 字节随机
z-base-32）、`name`（人可读、提供方内唯一）、`match`（域名匹配数组，元素为
`{type: exact|suffix|regex, value}`——**纯展示元数据**：用于目录披露与 UI 归属
说明，无任何运行时路由语义，代理模式已取消）、`upstream`（上游 URL：
scheme/host/port/基础路径）、生命周期四槽（`auth` / `headers` / `request` /
`response`，形状见 hooks 生命周期管线条款）、`rewrite`（可选：host 头覆盖、
路径前缀剥离/追加——头改写能力已迁出至 headers 槽）、`defaultPort`（使用方本地
默认端口，缺省取上游端口；上游端口 < 1024 时 MUST 显式声明）。服务可属多个
分组。正则规则 MUST 在保存时通过编译检查（语法合法即可——match 无运行时执行面，
无 ReDoS 暴露）。

**版本门禁与 legacy 模式（Owner 裁决 2026-09-15：无迁移）**：store 加载 SHALL
先裸读 JSON 判版本；`version` 缺失或 ≠2 SHALL 进入 legacy 模式而非报损坏——
legacy store 以空 services/groups/keys 视图运行（daemon 不崩、日志 NOTICE），
携带 `legacy: { serviceNames: string[] }` 元数据；legacy 模式下 `service remove
<name>` SHALL 按原始文件条目过滤原子写回（其余字段**语义保留**——JSON 对象级
透传，未知/未来字段原样携带，不承诺字节级布局与键序）；原始 services
数组清空后 SHALL 将文件重建为干净 v2 空库并退出 legacy 态（**groups/keys 不
保留**——破坏性：密钥需重发、分享链接需重生成）。非法 JSON 维持既有 corrupt
报错路径。不提供任何自动迁移。

#### Scenario: 服务定义往返

- **WHEN** 提供方添加服务 `{name:"ollama", match:[{type:"suffix",value:".local"}], upstream:"http://127.0.0.1:11434", defaultPort:11434}` 后重启进程
- **THEN** 服务从本地存储完整恢复（version: 2），EndpointId 与名册不变

#### Scenario: 非法正则被拒

- **WHEN** 保存语法非法的正则规则
- **THEN** 保存被拒绝并说明原因，既有服务不受影响

#### Scenario: 特权上游端口强制显式

- **WHEN** 添加 upstream 为 `https://api.example.com`（端口 443）的服务而未声明 defaultPort
- **THEN** 保存被拒绝并要求显式 defaultPort（避免使用方侧连环冲突与特权端口）

#### Scenario: 旧版本配置判失效

- **WHEN** 数据目录中的 services.json 为 v1 形状（无 version 字段或 ≠2）且含 3 个旧服务
- **THEN** daemon 正常启动、不服务任何旧服务、日志 NOTICE；legacy 元数据含 3 个旧服务名；逐一移除后原始条目减少，最后一个移除时文件重建为 v2 空库

### Requirement: 上游转发与重写

对通过 AUTH 的 REQ，提供者 SHALL：按 `serviceId` 定位服务（未授权/未知 →
`unknown_service`）；以服务配置构造上游 URL（upstream 基础路径 + 前缀剥离/追加
后的请求路径，拼接规范化后 origin MUST 等于 upstream origin **且** 路径 MUST
仍以基础路径为前缀，任一不成立 `protocol_error` 且零上游请求）；转发头集 =
REQ.headers（凭据类已在协议层剥离并拒绝）经生命周期 auth 阶段（Authorization
注入）与 headers 阶段（remove → set → 整段脚本增量）覆写；Host 头由服务配置
决定（缺省上游 host，rewrite 可覆盖），MUST NOT 来自帧内。绑定 request 脚本的
服务 SHALL 由脚本产出上游响应（归一形与流式契约见生命周期条款）；绑定 response
脚本的服务 SHALL 在响应归一后经脚本变换再下发。携带 WS 握手头的请求 SHALL 按
协议升级通道条款与上游执行握手并进入双向中继（auth/headers 阶段对 WS 生效，
request 接管不适用于 WS）。上游 4xx/5xx 按 `upstream_status` 原样回送 status 与
正文；上游不可达/连接期超时（默认 10s）回送 `upstream_unreachable`；首字节
超时与流中途停滞超时按 wire-protocol 空闲超时条款。上游 URL 目标仅来自本地
服务配置，MUST NOT 受帧内任何字段影响（防 SSRF）。

#### Scenario: 重写后命中上游

- **WHEN** 服务 upstream 为 `http://127.0.0.1:11434`、auth 槽为密钥库引用、headers.set 含 `X-Custom: literal`，使用方请求 `POST /v1/chat/completions`
- **THEN** 上游收到 `http://127.0.0.1:11434/v1/chat/completions`，Authorization 为密钥库值（Bearer 前缀按 auth.bearer 开关），X-Custom 为字面量，且请求不含使用方侧凭据头

#### Scenario: 帧内不可指定上游

- **WHEN** 恶意使用方在 REQ 帧 path 或 headers 构造 `//evil.com/…`、`/../../admin`、`Host:` 覆盖等注入
- **THEN** schema 层 `..` 段拒绝 / 拼接 origin 与基础路径前缀断言 / headers 白名单拒绝（`protocol_error` / `forbidden_header`），零上游请求

#### Scenario: 上游错误原样透传

- **WHEN** 上游返回 401 与 JSON 正文
- **THEN** 使用方本地客户端收到 401 与原始正文，contentType 一致

### Requirement: 密钥引用解析（$secret:）

headers `set` 头值与 auth `literal` 值 SHALL 支持 `$secret:<name>`：请求期从
密钥库解析替换后发往上游；`$env:<VAR>` 语义保持不变；两者可并存于不同头。
引用不存在的密钥时该请求 SHALL 以错误码 `secret_missing` 拒绝（不回退空值、
不带引用名出网）。提供方侧 detail 投影中 `$secret:` 与 `$env:` 同样显示为
`●`。

#### Scenario: 密钥解析与缺失

- **WHEN** 服务 headers.set 为 `authorization: $secret:openai` 且密钥库含 openai
- **THEN** 上游收到替换后的完整头值；删除 openai 后同请求返回 `secret_missing`，错误信息不含密钥名

### Requirement: 提供方密钥库

提供方 SHALL 持有本地密钥库 `~/.aifly/provider/secrets.json`（0600、原子写、与
services.json 同目录约定）：`name → value`（value 为**原样存储**的字符串——裸
key 或完整头值均可；请求期的 Bearer 前缀拼接由消费方服务的 auth 槽 `bearer`
开关决定，`bearerPrefix` 条目字段退役，注入路径统一为「裸 key 默认拼、已带
Bearer 不重复、开关关则原样」）。RPC 面：`list` SHALL 返回
`{ secrets: Array<{name, createdAt?, updatedAt?}>, count }`（值绝不序列化、
bearerPrefix 绝不出现）、`set`（新增/覆写，名非空、值非空；不再接受前缀开关
参数）、`remove`（不存在时 NOT_FOUND）。密钥值 MUST NOT 离开提供方机器（不入
wire 目录、不入分享链接、不入任何 status/detail 载荷；名称同受消费侧 ● 投影
保护——消费方目录只见 `●`）。

#### Scenario: 面板增删密钥

- **WHEN** 用户在密钥面板添加 `openai = Bearer sk-xxx` 后删除之
- **THEN** list 先返回含 openai 名称的条目列表再返回空；文件内容与 0600 权限保持；任何 RPC 响应不含 `sk-xxx`

### Requirement: 上游连通性测试

提供方 SHALL 支持对「草稿或已存服务形状」（upstream、apiForm、**auth 槽草稿**
（secret 引用 / 脚本绑定 / 字面量 + bearer 开关）、model?）执行一次最小连通
测试：按 apiForm 构造单轮请求（openai-completions →
`POST {upstream}/chat/completions`；anthropic-messages → `POST {upstream}/v1/messages`
并带 `anthropic-version` 头；gemini-native → `POST {upstream}/v1beta/models/{model}:generateContent`
且密钥经 `x-goog-api-key` 注入），`max_tokens`/`maxOutputTokens` 压到最小；
Authorization 注入与转发同路径——按 auth 槽草稿解析（secret → 密钥库取值，
脚本 → 调用该脚本阶段函数，literal → 原样/间接引用解析；bearer 开关同规则）。
未指定 model 时 SHALL 按三级回退选取（与 app/ui「custom 上游的模型下拉来自
实时探测，探测失败转手填」同源冻结）：显式指定 > models.dev 缓存中该 provider
价格已知的最低价 chat 模型 > `GET {upstream}/models` 带凭据实时探测（便宜档
启发式：mini/flash/small/lite 优先）；三者皆不可用时结果级报错，要求显式
指定模型。**路径版本段规则（与 apiForm 请求构造同源）**：baseUrl 已含版本段
（`/v1`、`/v4`、`/v1beta` 等）时直接拼接相对路径（`/models`、`/chat/completions`、
`/messages`）；无版本段时补 `/v1`（gemini-native 补 `/v1beta`）——baseUrl 按
调研原文照抄，不因构造规则改写。结果 SHALL 含 `ok`、`httpStatus`、
`latencyMs`、`model`、失败时 `error`；测试 MUST 为 provider-local：不落盘、不计
限额、不经 fabric。RPC `services.test` 输入 SHALL 携带 auth 槽草稿（不再接受
secretName 单字段形态）。

#### Scenario: 默认最便宜模型测试

- **WHEN** 对 z.ai 预设形状发起测试且未指定模型，模型清单含多档价格
- **THEN** 引擎选价格最低的 chat 模型发单轮请求，返回 ok 与耗时；密钥错误时返回带上游状态码的失败结果

#### Scenario: custom 上游探测回退

- **WHEN** 对 models.dev 不覆盖的自定义上游发起测试且未指定模型，上游 /models 可达
- **THEN** 引擎用探测所得模型（便宜档优先）发单轮请求；探测也不可达时返回要求显式指定模型的结果级错误，不发出业务请求

### Requirement: 密钥值语义（裸 key + Bearer 前缀开关）

密钥库条目 SHALL 不再携带前缀开关（`bearerPrefix` 退役）：Bearer 前缀拼接由
服务生命周期 auth 槽的 `bearer` 布尔（默认 true）唯一决定——值为裸 key 时拼
`"Bearer "`（值已以 Bearer 开头则不重复），false 按原样注入。provider-local
连通测试的注入路径 SHALL 同样读取草稿的 auth 槽配置。RPC `secrets.set` 不再
接受 `bearerPrefix` 参数；`secrets.list` SHALL 返回与提供方密钥库条款一致的
精确结构（`{secrets: [{name, createdAt?, updatedAt?}], count}`；值与 bearerPrefix
绝不出现）。

#### Scenario: 裸 key 默认可用

- **WHEN** 用户在面板存入裸密钥（未手写 Bearer）并以默认 auth.bearer=true 选中注入
- **THEN** 上游收到 `authorization: Bearer <key>`；服务级关闭 bearer 开关后按原样注入
