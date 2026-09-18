# net-fly/provider Specification

## Purpose

定义提供方（ai-fly 引擎，内部分层标签 net-fly）的行为契约：服务（域名展示集+上游+重写）与分组、密钥的管理与持久化、AUTH 校验与应用层授权、上游转发与重写（含 WebSocket 升级）、限额、目录同步、分享链接签发。成员资格与撤销语义复用 fabric 名册/会话层；分组/密钥授权是应用层，二者两级并存。凭据两层分离：令牌（fabric/设备准入）与密钥（应用层/分组授权）是不同的东西。

## Requirements

### Requirement: 服务模型与持久化

提供方 SHALL 以本地存储（数据目录内，目录 0700、文件 0600，原子写 tmp+rename）
管理**服务**：存储文件带 `version: 2` 标记。每服务含 `serviceId`（8 字节随机
z-base-32）、`name`（人可读、提供方内唯一）、`match`（域名匹配数组，元素为
`{type: exact|suffix|regex, value}`——**纯展示元数据**：用于目录披露与 UI 归属
说明，无任何运行时路由语义，代理模式已取消）、`upstream`（上游 URL：
scheme/host/port/基础路径）、生命周期绑定（**双模式互斥**——见 hooks 生命周期管线条款：自定义模式四槽
`auth` / `headers` / `request` / `response`，或预设模式顶层 `hooks =
{script, args?}` 整段绑定；两者同现 SHALL 拒绝保存）、`rewrite`（可选：host 头覆盖、
路径前缀剥离/追加——头改写能力已迁出至 headers 槽）、`defaultPort`（使用方本地
默认端口，缺省取上游端口；上游端口 < 1024 时 MUST 显式声明）。`hooks` 为可选字段——对既有 version: 2 文件向后兼容（缺省即自定义模式），
store 版本维持 2 不变。服务可属多个分组。正则规则 MUST 在保存时通过编译检查（语法合法即可——match 无运行时执行面，
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

### Requirement: 分组与密钥

提供方 SHALL 将服务编入**分组**（分组含 `name` 与服务引用列表；一服务可属多组），
并为分组签发**访问密钥**（`keyId` + 随机密钥原文，`sk-aifly-` 前缀、z-base-32；
原文仅在签发时展示一次，存储仅保留 SHA-256 哈希）。一分组可持多枚密钥；密钥可
单独撤销（撤销即刻生效：剔除其授权视图或断开无余钥会话，后续 AUTH 计入
rejected）。密钥校验 MUST 常数时间比较（哈希后比较）。密钥与设备无关：任何已
入网设备持钥即得访问，撤钥切断所有持钥设备，撤令牌只踢一台设备（两级撤销）。

#### Scenario: 一组多钥独立撤销

- **WHEN** 分组持有钥 A、B，两使用方分别在线；提供方撤销钥 A
- **THEN** 钥 A 的授权被剔除（无余钥则断会话）、重连后 AUTH 计入 rejected；钥 B 的使用方完全不受影响

#### Scenario: 密钥原文不可再现

- **WHEN** 提供方查看既有密钥列表
- **THEN** 仅显示 keyId、创建时间与状态；原文不再出现

### Requirement: AUTH 校验与目录同步

AUTH 改 HTTP 端点（`/_aifly/auth`，经 opendweb `Fabric.serveHttp` 会话承载）：
会话 active 后消费端呈交多密钥集合；逐钥校验 → 定位分组 → 200 AUTH_OK 语义
（`alias`、`relayUrls`、每有效密钥的 `{keyId, group, limits, services}` 视图、
`rejected` 列表）。服务视图含**完整脱敏披露 `detail`**（upstream、match 全集、
rewrite 规则、生命周期绑定——自定义模式四槽与预设模式 `hooks` 槽，脚本注入位
显示 `●`；`$env` 注入头值仅显示 `●`，变量名不显示）——除凭据值外无隐藏。
`limits` 结构 SHALL 为 `{maxConcurrency?: number, dailyRequests?: number}`
（分组级，可选、缺省不限）。`serviceId` 不在授权视图内时统一回送
`unknown_service`（不区分不存在与无权，防枚举）。服务或密钥变更时 SHALL 向
已授权会话经目录刷新通道推送 `refresh: true` 的全量视图（语义不变）。鉴权
结果按 session_id 缓存——传输断线恢复（同会话续传）不重 AUTH；provider 重启
（会话注册表丢失 → REQUEST_STATE_LOST）时消费端重建会话并重 AUTH。空钥环
（join-only）保持 connected-unauthed，不发起 AUTH。

#### Scenario: 目录随服务变更推送

- **WHEN** 使用方在线期间提供方向其分组新增一服务
- **THEN** 使用方收到 refresh 全量视图（含新服务 detail），按默认端口规则尝试本地映射

#### Scenario: 越权服务统一拒绝

- **WHEN** 使用方请求的 serviceId 属于其未获授权的分组
- **THEN** 回送 `unknown_service`，与不存在的 serviceId 响应无差别

#### Scenario: detail 披露脱敏

- **WHEN** 服务的 rewrite 含 headerSet `Authorization: $env:ZAI_KEY`
- **THEN** 目录 detail 中该项显示为 `Authorization: ●`；环境变量名与值均不出现在任何响应

#### Scenario: 断线恢复不重 AUTH

- **WHEN** 已 AUTH 会话传输断线并在恢复窗口内续传
- **THEN** 目录视图不变、无需重呈密钥、在途请求继续

#### Scenario: provider 重启

- **WHEN** provider 进程重启（内存会话注册表丢失）
- **THEN** 消费端 RESUME 被 REQUEST_STATE_LOST 拒绝 → 重建会话重 AUTH；重启前的在途请求确定错误不悬挂

### Requirement: 上游转发与重写

对已授权会话的请求，提供者 SHALL：按 `serviceId` 定位服务（未授权/未知 →
`unknown_service`）；以服务配置构造上游 URL（upstream 基础路径 + 前缀剥离/追加
后的请求路径，拼接规范化后 origin MUST 等于 upstream origin **且** 路径 MUST
仍以基础路径为前缀，任一不成立 `protocol_error` 且零上游请求）；转发头集 =
请求 headers（凭据类已在协议层剥离并拒绝）经生命周期 auth 阶段（Authorization
注入）与 headers 阶段（remove → set → 整段脚本增量）覆写；Host 头由服务配置
决定（缺省上游 host，rewrite 可覆盖），MUST NOT 来自帧内。绑定 request 脚本的
服务 SHALL 由脚本产出上游响应（归一形与流式契约见生命周期条款）；绑定 response
脚本的服务 SHALL 在响应归一后经脚本变换再下发。携带 WS 握手头的请求 SHALL 经
内核 keepOpen 字节隧道与上游执行握手并进入双向中继（auth/headers 阶段对 WS
生效，request 接管不适用于 WS）。上游 4xx/5xx 按 `upstream_status` 原样回送
status 与正文；上游不可达/连接期超时（默认 10s）回送 `upstream_unreachable`；
首字节超时与流中途停滞超时沿用现行空闲超时语义。上游 URL 目标仅来自本地服务
配置，MUST NOT 受请求内任何字段影响（防 SSRF）。

承载面：请求经 opendweb `Fabric.serveHttp` handler 的 HTTP 投影到达（OPEN
元数据 + DATA），响应 body 由 handler 供给（内核 journal 承接断线重放与
发送侧反压）。发送侧缓冲兜底（bufferOverflows）退役，观测面为内核
journalBytes。

#### Scenario: 重写后命中上游

- **WHEN** 服务 upstream 为 `http://127.0.0.1:11434`、auth 槽为密钥库引用、headers.set 含 `X-Custom: literal`，使用方请求 `POST /v1/chat/completions`
- **THEN** 上游收到 `http://127.0.0.1:11434/v1/chat/completions`，Authorization 为密钥库值（Bearer 前缀按 auth.bearer 开关），X-Custom 为字面量，且请求不含使用方侧凭据头

#### Scenario: 帧内不可指定上游

- **WHEN** 恶意使用方在请求 path 或 headers 构造 `//evil.com/…`、`/../../admin`、`Host:` 覆盖等注入
- **THEN** schema 层 `..` 段拒绝 / 拼接 origin 与基础路径前缀断言 / headers 白名单拒绝（`protocol_error` / `forbidden_header`），零上游请求

#### Scenario: 上游错误原样透传

- **WHEN** 上游返回 401 与 JSON 正文
- **THEN** 使用方本地客户端收到 401 与原始正文，contentType 一致

#### Scenario: 转发管线回归

- **WHEN** 既有上游转发用例（路径改写/头阶段/SSE 透传）经新承载面执行
- **THEN** 行为与旧承载面一致（回归测试全绿）

### Requirement: 限额

提供方 SHALL 支持分组级可选限额：并发在途请求数（`maxConcurrency`）、每日请求数
（`dailyRequests`，按 keyId 分别计数，UTC 日界重置，持久化于数据目录）。超限在
拨号上游之前回送 `rate_limited` / `quota_exceeded`。用量记录默认关闭；开启时仅
元数据（keyId、serviceId、status、字节数、时间戳），MUST NOT 记录正文。

#### Scenario: 并发限额

- **WHEN** 分组并发上限 2 且两个流式请求在途，第三个请求到达
- **THEN** 第三个请求立即收到 `rate_limited` ERROR，不影响前两个请求

### Requirement: 提供方命令面

提供方 CLI（bin `ai-fly`）SHALL 提供：`ai-fly serve --data <dir>`（长驻：加载
服务/分组/密钥、fabric createRoot/open 复入、启动横幅打印 EndpointId/fabric-id/
服务数/分组与密钥数/relay 配置/空 `$env` 变量 WARNING）、`ai-fly service
<add|list|remove>`、`ai-fly group <add|list>`、`ai-fly key <issue|list|revoke>
--group <name>`、`ai-fly share --group <name> [--ttl <dur>]`（生成分享链接，见
share-link spec）、`ai-fly revoke <endpointId>`（fabric 级踢出设备）、
`ai-fly status`。TTL 值域校验在 CLI 层执行（1s..30d，复用时长解析约定）。用户面
字符串 SHALL 为英文且码位 < 128；选项解析 `--opt value`/`--opt=value` 等价、
路径值 `~` 展开、未知选项退出码 2（沿用既有 args 模块）。

#### Scenario: serve 复入

- **WHEN** `serve` 中断后以同一 `--data` 再次启动
- **THEN** 复用既有 EndpointId、名册、服务与密钥，在线使用方自动重连后凭既有密钥通过 AUTH

#### Scenario: share 前置检查

- **WHEN** 对空分组运行 `share`
- **THEN** 报错退出（分组无服务，链接无意义），不签发令牌

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

### Requirement: 密钥引用解析（$secret:）

headers `set` 头值与 auth `literal` 值 SHALL 支持 `$secret:<name>`：请求期从
密钥库解析替换后发往上游；`$env:<VAR>` 语义保持不变；两者可并存于不同头。
引用不存在的密钥时该请求 SHALL 以错误码 `secret_missing` 拒绝（不回退空值、
不带引用名出网）。提供方侧 detail 投影中 `$secret:` 与 `$env:` 同样显示为
`●`。

#### Scenario: 密钥解析与缺失

- **WHEN** 服务 headers.set 为 `authorization: $secret:openai` 且密钥库含 openai
- **THEN** 上游收到替换后的完整头值；删除 openai 后同请求返回 `secret_missing`，错误信息不含密钥名

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

### Requirement: 分组管理对齐密钥面

分组 SHALL 支持行级管理：限额更新（`setLimits`，省略=清除为无限）与删除
（`remove`）。删除时组内仍有未撤销密钥 SHALL 以 CONFLICT 拒绝（提示先撤销）。
CLI 同步提供 `group set-services` / `group remove`。

#### Scenario: 有键分组不可删

- **WHEN** 分组存在未撤销密钥时请求删除
- **THEN** 返回 CONFLICT 与 "revoke them first"；撤销后删除成功

### Requirement: 自定义上游模型探测

模型清单 SHALL 支持第二来源：对自定义上游（不在 models.dev 覆盖内）实时探测
`GET {upstream}/models`（带密钥注入；OpenAI 兼容形状 `{data:[{id}]}`），便宜档
命名启发式（mini/flash/small/lite/nano/turbo）排前。连通测试的模型选择顺序 SHALL
为：显式指定 > models.dev 缓存（priced chat 最低价）> 上游探测。测试结果 SHALL
携带请求详情（method/url/model）、模型来源（modelSource）与非 2xx 时的上游正文
摘录（截断、密钥值打码）。

#### Scenario: 中转站无 models.dev 条目

- **WHEN** 对 https://api.example-relay.com/v1 发起测试且该站不在 models.dev
- **THEN** 引擎探测其 /models 取首个便宜档模型发起单轮请求；401 时错误含上游 JSON 正文摘录

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
  （连接语义归脚本）。无绑定时为 **js-backend-fetch**（当前 JS 运行时后端——Node/Deno/Bun——的 fetch 实现；命名 Owner 2026-09-15 冻结，不再用「原生 fetch」措辞）。
- **④ response（onResponse）**：配置槽 `service.response`（`{script, args?}`），
  ctx 为 `{ status, headers, body: AsyncIterable<Uint8Array>, signal }`，返回
  `{ status?, headers?, body? }` 局部覆盖；头键小写化、last-wins，可写范围限
  RESP_META 白名单三头 + `content-type`（引擎投影至 RESP_META 独立 contentType
  字段；status 204/304 时 contentType 归一为空；③ 返回 headers 中的
  `content-type` 同样投影）；调用时机为上游响应归一后、RESP_META 下发前。
- **内建 codex 脚本凭据定位**（Owner 2026-09-14 只读裁决 + 2026-09-16 隔离
  通道）：镜像 codex CLI 官方语义——读 `$CODEX_HOME/auth.json`，`CODEX_HOME`
  未设置或为空串时回落 `<homedir>/.codex/auth.json`；只读，ai-fly 永不写凭据
  文件。`CODEX_HOME` 供本机 `~/.codex` 承载其它 Codex CLI 配置时做完全隔离。

**出站归一层**：js-backend-fetch 结果与 ③ 脚本结果 SHALL 统一归一为
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
非法、流中途失败 SHALL 以新错误码 `hook_failed` 回送（消息同样脱敏）。**脱敏
仅约束 wire 面**：daemon stderr / app.log 可携带运营侧诊断行（Owner
2026-09-16，实测锚点：rust-fetch sidecar 二进制缺失 → wire 固定文案 + stderr
一行安装指引 `pnpm sidecar:install`；诊断行不含密钥值与服务脚本路径）。

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

**双模式绑定（Owner 2026-09-15 裁决）**：生命周期配置 SHALL 支持两种互斥模式——
**自定义模式**（逐槽 `auth`/`headers`/`request`/`response` 各自挑选脚本或直接
配置）与**预设模式**（顶层 `service.hooks = {script, args?}` 整段绑定一个
hook-js，其按 stages 矩阵导出的阶段函数构成该服务的生命周期：①缺导出即无
auth 注入；②缺导出即无增量；③缺 `onRequest` 导出回退 js-backend-fetch（含
连接期探测）；④缺导出即无变换）。`hooks` 与任一逐槽同现 SHALL 校验拒绝；
绑定未导出任何阶段函数的脚本 SHALL 校验拒绝（绑定无意义）。逐槽契约与错误
分族对两模式一致适用（预设模式下脚本失效同分族归置）。**资源上限（分档——
本变更实证修正）**：② 注入头集 ≤32 头 / 键 ≤1KiB / 值 ≤8KiB；③④ 返回
headers 为上游响应/变换的投影（引擎仅消费 RESP_META 白名单 + content-type，
其余忽略），中继档 ≤128 头 / 值 ≤16KiB——真实 CDN 头集实测超 ② 注入预算
（chatgpt.com 39 头）；③ status 域 200–599；非法形状 → `hook_failed`。

#### Scenario: 预设模式整段接管

- **WHEN** 服务配置 `hooks: {script: "codex"}`，该脚本导出 ①②③ 三个阶段函数
- **THEN** 请求经 ① 脚本注入 token、② 脚本注入头集、③ 脚本接管出站；脚本未导出 ④ 则响应直通

#### Scenario: 预设模式与逐槽互斥

- **WHEN** 保存同时携带 `hooks` 与 `auth`（或任一逐槽）的服务
- **THEN** 保存被拒绝并说明两种模式互斥，既有服务不受影响

#### Scenario: 顶层键 strict

- **WHEN** ②③④ 脚本返回对象携带未知顶层键（如 `{sets: …}` 拼错）
- **THEN** 该请求以 `hook_failed` 终结，不静默忽略

### Requirement: 内建出站接管器 rust-fetch

提供方 SHALL 内建 ③ 阶段脚本 `rust-fetch`（`hooks/rust-fetch.cjs`，导出
`onRequest`），把出站 HTTPS 请求交给 Rust sidecar 二进制发起（rustls TLS +
HTTP/2 ALPN——客户端栈不同于 js-backend-fetch，Owner 2026-09-15 裁决）：

- **stdio 协议（冻结）**：sidecar 每请求一进程。stdin = JSON 元信息行
  `{url, method, headers}` + `\n` + 原始请求体字节（EOF 为止）；stdout =
  JSON 元信息行 `{status, headers}`（头键小写化、同名头值逗号连接）+ `\n` +
  响应体字节（stdout 即流、逐块 flush、EOF = 体结束）；失败信息走 stderr、
  进程 exit≠0。SSE MUST 逐块透传（禁止缓冲攒齐）。
- **二进制发现顺序**：环境变量 `AIFLY_RUST_FETCH_BIN` > `~/.aifly/sidecars/
  rust-fetch/rust-fetch` > PATH。二进制不随仓库产物分发——源码位于
  `sidecars/rust-fetch/`，`cargo build --release` 交付（README 指引）。
- **失败语义**：二进制缺失（spawn 失败）/ exit≠0 / 元信息行解析失败 → ③
  脚本失效（`hook_failed` 固定脱敏文案——沿用生命周期管线既有分族，不新增
  错误码）。
- **中止语义**：ctx.signal（引擎 ctrl.signal——外部中止与本地超时均经此）
  触发时 SHALL SIGKILL 子进程；body 迭代器随进程终止而结束（流中挂起按既有
  中止竞速条款退出）。
- **代理**：沿用 sidecar HTTP 栈的环境代理默认（HTTPS_PROXY/HTTP_PROXY/
  NO_PROXY）。

#### Scenario: 经 rust-fetch 转发流式请求

- **WHEN** 服务 ③ 绑定 rust-fetch 且 sidecar 二进制可发现，使用方发起 SSE 请求
- **THEN** 上游由 Rust 进程发起（rustls 客户端栈），响应体逐块回传使用方；使用方中止或本地超时触发 ctx.signal 时 sidecar 进程被 SIGKILL，转发按中止语义终结

#### Scenario: 二进制缺失或协议失败

- **WHEN** AIFLY_RUST_FETCH_BIN 指向不存在的路径，或 sidecar exit≠0 / 输出元信息行非法
- **THEN** 该请求以 `hook_failed` 固定脱敏文案终结，零信息泄漏（不含路径与 stderr 内容）

### Requirement: 服务生命周期与启停传导

提供者 SHALL 支持服务级与提供者级（环级）启停：`service stop <name>` 暂停
暴露（目录同步剔除该服务，配置保留）——consumer 侧该服务端口关闭、在途请求
中止、目录表现为 404；`service start` 恢复暴露（consumer 端口复活）。环级
`Keyring.disabled` 开关 SHALL 叠加生效：环停用即该环全部服务停止暴露，环
恢复时**单服务的既有停用态保持**（不因环级恢复而重置）。启停传导经目录同步
（物化/watch 全链过滤停用项），SHALL NOT 删除任何持久化配置。

#### Scenario: 服务停用目录剔除

- **WHEN** 提供者对在线 consumer 停用一个服务
- **THEN** consumer 目录在秒级剔除该服务（本地端口关闭），提供者侧配置与
  密钥不受影响；恢复后无需重新授权即复活

#### Scenario: 环级开关叠加

- **WHEN** 环内服务 A 已单独停用、B 运行中，随后环整体停用再恢复
- **THEN** 恢复后 B 回到运行、A 保持停用（环级操作不重置单服务状态）
