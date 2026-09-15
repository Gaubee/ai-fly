# net-fly/provider Delta

## ADDED Requirements

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

## MODIFIED Requirements

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

### Requirement: AUTH 校验与目录同步

提供者 SHALL 按 wire-protocol 处理 AUTH（多密钥集合）：逐钥校验 → 定位分组 →
AUTH_OK（`alias`、`relayUrls`（当前生效 relay 入口，随目录刷新同步）、每有效密钥
的 `{keyId, group, limits, services}` 视图、`rejected` 列表）。服务视图含**完整
脱敏披露 `detail`**（upstream、match 全集、rewrite 规则、生命周期绑定——
自定义模式四槽与预设模式 `hooks` 槽，脚本注入位显示 `●`；`$env` 注入头值仅
显示 `●`，变量名不显示）——除凭据值外无隐藏。`limits` 结构 SHALL 为
`{maxConcurrency?: number, dailyRequests?: number}`（分组级，可选、缺省不限）。
REQ 的 `serviceId` 不在授权视图内时统一回送 `unknown_service`（不区分不存在与
无权，防枚举）。服务或密钥变更时 SHALL 向已授权在线会话推送 `refresh: true` 的
AUTH_OK（全量替换语义）。

#### Scenario: 目录随服务变更推送

- **WHEN** 使用方在线期间提供方向其分组新增一服务
- **THEN** 使用方收到 refresh AUTH_OK（含新服务 detail），按默认端口规则尝试本地映射

#### Scenario: 越权服务统一拒绝

- **WHEN** 使用方请求的 serviceId 属于其未获授权的分组
- **THEN** 回送 `unknown_service`，与不存在的 serviceId 响应无差别

#### Scenario: detail 披露脱敏

- **WHEN** 服务的 rewrite 含 headerSet `Authorization: $env:ZAI_KEY`
- **THEN** 目录 detail 中该项显示为 `Authorization: ●`；环境变量名与值均不出现在任何帧
