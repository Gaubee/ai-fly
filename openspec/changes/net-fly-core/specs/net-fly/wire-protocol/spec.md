# net-fly/wire-protocol Specification

## Purpose

定义 net-fly 在 fabric 不透明 envelope 之上的帧子协议：命名空间隔离、AUTH 握手、
HTTP 请求多路复用、流式分片保序、中止/超时与错误语义、资源上限。协议是 HTTP 级
通用转发（方法/路径/头/正文的承载与还原），不解析业务语义。会话层不解析本协议；
本协议不依赖会话层之外的任何内核改动。

## ADDED Requirements

### Requirement: 命名空间与版本隔离

所有 net-fly 帧 SHALL 以固定 magic（`netfly1`，7 字节 ASCII）开头，其后为 1 字节
帧类型与 JSON 头（UTF-8）。接收方对不以该 magic 开头的 envelope MUST 静默忽略
（同一 fabric 可并存其它应用的 envelope 流量）。对 magic 匹配但协议版本不识别的帧，
MUST 回送 ERROR 帧（code `protocol_version`）并丢弃原帧；对版本匹配但类型未知的帧
MUST 记录并忽略，不得终止连接或影响其它请求。

#### Scenario: 混流共存

- **WHEN** 同一 fabric 上另一应用向 net-fly 端点发送不含 magic 的 envelope
- **THEN** 端点静默忽略该 envelope，既有请求转发不受影响

#### Scenario: 未知帧类型前向兼容

- **WHEN** 接收到 magic 与版本均匹配、但帧类型未定义的帧
- **THEN** 该帧被忽略，同一连接上的后续帧与在途请求正常处理

### Requirement: 帧方向与未知标识符

帧方向 SHALL 固定：使用方→提供方仅 AUTH/REQ/REQ_BODY/ABORT；提供方→使用方仅
AUTH_OK/AUTH_ERR/RESP_META/RESP_CHUNK/RESP_END/ERROR/PING。反向出现的帧以 ERROR
（code `protocol_error`）回敬并丢弃（若可定位 `id`）。携带**未知 request-id 或已
终结 request-id** 的任何帧 MUST 静默丢弃（不回帧、不放大流量）；request-id 一经
分配 MUST NOT 复用（16 字节随机空间，复用零收益、徒增竞态）。

#### Scenario: 方向反转被拒

- **WHEN** 提供方收到使用方发来的 RESP_META 帧
- **THEN** 回送 `protocol_error` ERROR 帧并丢弃；连接与其它请求不受影响

#### Scenario: 已终结 id 的迟到帧

- **WHEN** 某 `id` 已因 ERROR 终结后，又收到该 id 的 RESP_CHUNK
- **THEN** 帧被静默丢弃，不产生任何副作用

### Requirement: AUTH 握手（会话级授权，多密钥）

使用方与提供方的连接建立后、任何 REQ 之前，使用方 SHALL 发送 AUTH 帧：JSON 头
含 `v`、`keys`（该使用方持有的此提供方全部分组密钥数组，≥1）。提供者 SHALL 逐一
校验并回送 AUTH_OK：`alias`（提供者别名）、`groups`（每枚有效密钥对应
`{keyId, group, limits, services:[{serviceId,name,match,defaultPort}]}`）、可选
`rejected`（`{code: key_invalid|key_revoked}` 数组）。全部密钥无效回送 AUTH_ERR
（`code: key_all_invalid`）并断开。未完成 AUTH 的连接上，除 AUTH 外的任何帧
SHALL 静默丢弃并计数，累计超过 32 帧或 AUTH 失败累计 3 次 MUST 断开连接。
AUTH_OK 之后任一在用密钥被撤销时：若仍有其它有效密钥，提供者 SHALL 推送目录
刷新（见「目录同步」）并仅剔除被撤销项；若全部失效 MUST 断开会话。重复 AUTH 以
最后一次为准（密钥集合变更 = 重授权）。密钥仅经 fabric 加密通道呈现，MUST NOT
出现在日志中。

#### Scenario: 多密钥一次授权

- **WHEN** 使用方持提供方两组密钥并发起 AUTH
- **THEN** AUTH_OK 含两个分组的限额与服务视图；任一分组的服务即刻可请求

#### Scenario: 合法密钥完成握手

- **WHEN** 使用方以单枚有效密钥发起 AUTH
- **THEN** 收到 AUTH_OK（别名、分组、限额、服务视图）；随后 REQ 被接受

#### Scenario: 撤销后仍存余钥

- **WHEN** 使用方持钥 A、B 在线，提供方撤销钥 A
- **THEN** 使用方收到剔除钥 A 分组的目录刷新，钥 B 分组继续可用，会话不断

#### Scenario: 撤销后无余钥断会话

- **WHEN** 使用方仅持一枚密钥且被撤销
- **THEN** 提供者断开该会话；使用方该提供者进入离线语义

#### Scenario: 未握手先发请求

- **WHEN** 连接建立后未 AUTH 直接发送 REQ
- **THEN** 帧被丢弃计数；累计越限后连接被断开

### Requirement: 请求多路复用

每个经网关转发的 HTTP 请求 SHALL 分配全局唯一 request-id（16 字节随机数的
z-base-32 编码）。同连接上多个在途请求的帧按 request-id 解复用；同一 request-id
的帧序依赖会话层的单连接保序（发送方对同一 id 的帧 SHALL 顺序 await 发送以保证
交付顺序；不同 id 之间无顺序承诺）。

#### Scenario: 并发交错

- **WHEN** 使用方在同一连接上并发发起两个流式请求 A 与 B
- **THEN** 双方的响应分片按各自 request-id 完整归位，A 的分片序列与 B 互不混入、各自保序

### Requirement: 请求上行（REQ / REQ_BODY）

请求 SHALL 以 REQ 帧开始：JSON 头含 `v`、`id`、`serviceId`、`method`（枚举
GET/HEAD/POST/PUT/PATCH/DELETE；越界值按 `forbidden_method` 拒绝、非法类型按
`protocol_error`）、`path`（以单个 `/` 开头、不含 scheme、不以 `//` 或 `/\`
开头；含查询串）、可选 `headers`（透传白名单对象：键为小写规范化 HTTP 头名，
MUST NOT 含 `authorization`、`proxy-authorization`、`cookie`、`host`、
`content-type`——凭据类由发送方剥离、提供方再校验拒绝）、`contentType?`、
`bodyLen`。正文 ≤ 单帧分片上限时内联于 REQ 帧，否则以 0 个或多个 REQ_BODY 续帧
承载（`id`、`seq` 从 0 递增、`end` 布尔）。发送方 MUST 使所有帧 ≤ 会话层 1 MiB
帧上限；正文分片上限默认 256 KiB（远小于帧上限，规避同连接队头阻塞；可配置，
MUST ≤ 960 KiB）。接收方 MUST 按 seq 顺序重组，`end` 前序号缺断时回送 ERROR
（code `protocol_seq`）并**重建该提供者连接**（丢批是批次性的，流已不可信）；
重组总字节数超过总上限（默认 8 MiB，可配置）时回送 ERROR（code `body_too_large`）
并丢弃该请求剩余分片。

#### Scenario: 小请求单帧完成

- **WHEN** 使用方转发一个 2 KiB 正文的 POST 请求
- **THEN** 整个请求由一个内联正文的 REQ 帧承载，提供者直接得到完整正文

#### Scenario: 必需自定义头透传

- **WHEN** 客户端请求携带 `anthropic-version: 2023-06-01` 与 `accept: text/event-stream`
- **THEN** 上游收到同名同值两头；凭据类头（authorization 等）被剥离且不进帧

#### Scenario: 超限正文被拒

- **WHEN** 请求重组后正文达 9 MiB，超过 8 MiB 总上限
- **THEN** 提供者回送 `body_too_large` ERROR 帧，不向上游发起请求

#### Scenario: 分片序号缺断

- **WHEN** 提供者收到 REQ 后续帧 seq 从 0 跳到 2
- **THEN** 该请求以 `protocol_seq` ERROR 终结，且提供者主动重建此连接

### Requirement: 响应下行（RESP_META / RESP_CHUNK / RESP_END / PING）

提供者收到上游响应后 SHALL 先发 RESP_META 帧（JSON 头含 `id`、`status`、
`contentType`、可选 `headers` 白名单子集：`x-request-id`、`retry-after`），随后
以上游到达顺序发 0 个或多个 RESP_CHUNK 帧（`id` + `seq` + 原始字节分片），成功
终结发 RESP_END 帧。流式（SSE/chunked）上游 MUST 边到达边分片转发，不得为拼齐
完整响应而缓冲。**首字节等待期**（上游未响应时）提供者 SHALL 每 30s 发 PING 帧
（`{id}`）维持请求活度。发送方对同一 `id` 的在途未终结分片施加队列上限（默认
64 帧，防本地 send 并发堆积；**不构成对端背压**——见接收缓冲）。使用方按 seq
保序还原字节流。

#### Scenario: SSE 逐块还原

- **WHEN** 上游以 SSE 分 20 个事件块推送补全结果
- **THEN** 使用方按原始顺序收到 20 次分片并逐块向本地客户端 flush，客户端观感与直连上游一致

#### Scenario: 非流式 JSON 响应

- **WHEN** 上游返回单次 1.5 KiB JSON
- **THEN** 使用方收齐分片与 RESP_END 后，向本地客户端返回 status、contentType 与完整正文

#### Scenario: 深度推理长等待

- **WHEN** 上游 3 分钟未返回首字节
- **THEN** 使用方每 30s 收到该 id 的 PING，请求不因空闲超时被误杀

### Requirement: 接收侧缓冲上限（背压兜底）

fabric 数据面无应用层背压（对端持续接收 QUIC 层流量），因此协议 SHALL 在接收侧
设防：使用方对每请求待消费缓冲（已收未吐给本地客户端的字节）设上限，默认 4 MiB
（可配置）；达限 SHALL 以 ABORT 帧终结该请求（本地客户端连接以错误关闭），错误
码 `buffer_overflow` 记入状态。提供者侧对请求重组已有 8 MiB 上限，同理适用。
对端慢的唯一可控动作是中止请求——暂停对端的信道（PAUSE/RESUME 帧）预留 v2。

#### Scenario: 慢客户端不拖垮内存

- **WHEN** 流式响应高速到达而本地客户端不读取，待消费缓冲达 4 MiB
- **THEN** 该请求被 ABORT 终结、本地连接以错误关闭、进程内存有界；其它请求不受影响

### Requirement: 空闲超时

请求级空闲超时 SHALL 双端各自执行：任一端在超时窗（默认 300s，可配置）内未收到
该 `id` 的任何帧（含 PING）即以 ERROR（code `idle_timeout`）终结并清理；提供者
侧另对上游施加首字节超时（默认 600s，可配置）与流中途停滞超时（默认 120s，可
配置），超时即中止上游并回送 `idle_timeout`。终结帧（RESP_END / ERROR）之后该
`id` 不得再出现任何帧。

#### Scenario: 空闲请求被清理

- **WHEN** 某流式请求 300s 无任何帧推进（也无 PING）
- **THEN** 双端各自以 `idle_timeout` 终结该请求并释放资源

### Requirement: 中止与错误语义

使用方本地客户端断开或接收缓冲达限时，网关 SHALL 发 ABORT 帧（`id`）；提供者
收到后 MUST 中止上游请求并停止分片，回送 ERROR（code `aborted`）作终结。提供者
侧失败（上游不可达、上游错误、限额触发、协议错误）以 ERROR 帧终结，JSON 头含
`id`（可得时）、`code`、`message`（脱敏：不含密钥与上游凭据）。错误码集合 SHALL
稳定：`aborted`、`buffer_overflow`、`idle_timeout`、`unauthorized`、
`key_invalid`、`key_revoked`、`key_all_invalid`、`unknown_service`、
`upstream_unreachable`、`upstream_status`、`body_too_large`、`rate_limited`、
`quota_exceeded`、`forbidden_method`、`forbidden_header`、`protocol_version`、
`protocol_seq`、`protocol_error`、`internal`。

#### Scenario: 客户端中途断开

- **WHEN** 本地客户端在流式响应进行到一半时断开连接
- **THEN** 使用方网关发出 ABORT，提供者中止上游请求，双方以 ERROR(aborted) 终结该请求并释放资源

#### Scenario: 终结后不再收帧

- **WHEN** 某 `id` 已收到 ERROR 帧
- **THEN** 之后到达的任何同 `id` 帧被丢弃，不产生副作用

### Requirement: 目录同步（AUTH_OK 复用）

提供者 SHALL 以 AUTH_OK 帧承载目录：初次授权与后续推送同构，推送时带
`refresh: true`，语义为**全量替换**使用方当前视图。服务被删除时，刷新视图不含
该服务；使用方 SHALL 关闭其本地映射端口并终结该服务在途请求（已建立的本地连接
以错误关闭）。未 AUTH 的连接收到 AUTH_OK SHALL 静默丢弃。

#### Scenario: 目录随服务变更推送

- **WHEN** 使用方在线期间提供方向其分组新增一服务
- **THEN** 使用方收到 refresh AUTH_OK，新服务可见并按端口规则尝试本地映射

#### Scenario: 服务删除后的收敛

- **WHEN** 提供者删除某服务并推送刷新
- **THEN** 使用方关闭该服务的本地端口，其新请求立即失败，其它服务不受影响

### Requirement: 帧资源上限

除正文分片上限外，子协议 SHALL 施加结构上限：`path` ≤ 4 KiB、`headers` ≤ 32 项、
单键 ≤ 1 KiB、单值 ≤ 8 KiB、JSON 头总长 ≤ 16 KiB。超限帧以 ERROR（code
`protocol_error`）回应（携带对应 `id` 时）并丢弃。REQ 的 `path` 经服务基础路径
拼接后，产物 origin（scheme/host/port）MUST 与服务 upstream 配置一致，不一致按
`protocol_error` 拒绝且零上游请求（防 `//host`、`..` 等路径注入逃逸）。

#### Scenario: 超长路径被拒

- **WHEN** REQ 帧 path 字段长 8 KiB
- **THEN** 提供者回送 `protocol_error` ERROR 帧并丢弃该请求

#### Scenario: 路径注入逃逸被拦

- **WHEN** REQ 帧携带 path `//evil.example.com/v1/keys`
- **THEN** 拼接后 origin 断言失败，回送 `protocol_error`，不发生任何上游请求
