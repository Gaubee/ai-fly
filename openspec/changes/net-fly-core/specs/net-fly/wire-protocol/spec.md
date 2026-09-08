# net-fly/wire-protocol Specification

## Purpose

定义 net-fly 在 fabric 不透明 envelope 之上的帧子协议：命名空间隔离、AUTH 握手、
HTTP 请求多路复用、流式分片保序、中止与错误语义、资源上限。协议是 HTTP 级通用
转发（方法/路径/头/正文的承载与还原），不解析业务语义。会话层不解析本协议；
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

### Requirement: AUTH 握手（会话级授权）

使用方与提供方的连接建立后、任何 REQ 之前，使用方 SHALL 发送 AUTH 帧：
JSON 头含 `v`、`key`（分组访问密钥原文）。提供者 SHALL 校验密钥：有效则回送
AUTH_OK（`alias`、`services` 脱敏视图数组、`limits`），无效或已撤销回送
AUTH_ERR（`code`: `key_invalid` / `key_revoked`）并此后忽略该连接上的全部 REQ 帧。
AUTH_OK 之后密钥被撤销时，提供者 MUST 断开该会话（复用 fabric 断连，使用方观测
为提供者离线）。重复 AUTH 以最后一次为准。密钥仅经 fabric 加密通道呈现，MUST NOT
出现在日志中。

#### Scenario: 合法密钥完成握手

- **WHEN** 使用方以有效密钥发起 AUTH
- **THEN** 收到 AUTH_OK，含提供者别名、服务视图与限额；随后 REQ 被接受

#### Scenario: 撤销后的既有会话断开

- **WHEN** 提供方撤销某密钥且该密钥的会话在线
- **THEN** 提供者断开该会话；使用方该提供者进入离线语义

#### Scenario: 未握手先发请求

- **WHEN** 连接建立后未 AUTH 直接发送 REQ
- **THEN** 提供者回送 ERROR（code `unauthorized`）并丢弃该 REQ

### Requirement: 请求多路复用

每个经网关转发的 HTTP 请求 SHALL 分配全局唯一 request-id（16 字节随机数的
z-base-32 编码）。同连接上多个在途请求的帧按 request-id 解复用；同一 request-id
的帧序依赖会话层的单连接保序（发送方对同一 id 的帧 SHALL 顺序 await 发送以保证
交付顺序）。request-id 在响应终结（RESP_END / ERROR / ABORT 确认）后可复用，
在途期间 MUST NOT 重复。

#### Scenario: 并发交错

- **WHEN** 使用方在同一连接上并发发起两个流式请求 A 与 B
- **THEN** 双方的响应分片按各自 request-id 完整归位，A 的分片序列与 B 互不混入、各自保序

### Requirement: 请求上行（REQ / REQ_BODY）

请求 SHALL 以 REQ 帧开始：JSON 头含 `v`、`id`、`serviceId`、`method`（仅
GET/POST/PUT/PATCH/DELETE）、`path`（含查询串）、`contentType?`、`bodyLen`；
正文 ≤ 单帧分片上限时内联于 REQ 帧，否则以 0 个或多个 REQ_BODY 续帧承载
（`id`、`seq` 从 0 递增、`end` 布尔）。发送方 MUST 使所有帧 ≤ 会话层 1 MiB 帧
上限；正文分片上限默认 256 KiB（远小于帧上限，规避同连接队头阻塞；可配置，
MUST ≤ 960 KiB）。接收方 MUST 按 seq 顺序重组，`end` 前序号缺断时回送 ERROR
（code `protocol_seq`）；重组后总字节数超过总上限（默认 8 MiB，可配置）时回送
ERROR（code `body_too_large`）并丢弃该请求剩余分片。

#### Scenario: 小请求单帧完成

- **WHEN** 使用方转发一个 2 KiB 正文的 POST 请求
- **THEN** 整个请求由一个内联正文的 REQ 帧承载，提供者直接得到完整正文

#### Scenario: 超限正文被拒

- **WHEN** 请求重组后正文达 9 MiB，超过 8 MiB 总上限
- **THEN** 提供者回送 `body_too_large` ERROR 帧，不向上游发起请求

### Requirement: 响应下行（RESP_META / RESP_CHUNK / RESP_END）

提供者收到上游响应后 SHALL 先发 RESP_META 帧（JSON 头含 `id`、`status`、
`contentType`、可选 `headers` 白名单子集：`x-request-id`、`retry-after`），随后
以上游到达顺序发 0 个或多个 RESP_CHUNK 帧（`id` + `seq` + 原始字节分片），成功
终结发 RESP_END 帧。流式（SSE/chunked）上游 MUST 边到达边分片转发，不得为拼齐
完整响应而缓冲。发送方对同一 `id` 的在途未终结分片施加队列上限（默认 64 帧），
达限后 MUST 暂停读取上游直至队列回落（fabric send 无应用层背压，此为兜底）。
消费方按 seq 保序还原字节流。

#### Scenario: SSE 逐块还原

- **WHEN** 上游以 SSE 分 20 个事件块推送补全结果
- **THEN** 使用方按原始顺序收到 20 次分片并逐块向本地客户端 flush，客户端观感与直连上游一致

#### Scenario: 非流式 JSON 响应

- **WHEN** 上游返回单次 1.5 KiB JSON
- **THEN** 使用方收齐分片与 RESP_END 后，向本地客户端返回 status、contentType 与完整正文

### Requirement: 中止与错误语义

使用方本地客户端断开时，网关 SHALL 发 ABORT 帧（`id`）；提供者收到后 MUST 中止
上游请求并停止分片，回送 ERROR（code `aborted`）作终结。提供者侧失败（上游不可
达、上游错误、限额触发、协议错误）以 ERROR 帧终结，JSON 头含 `id`（可得时）、
`code`、`message`（脱敏：不含密钥与上游凭据）。终结帧（RESP_END / ERROR）之后
该 `id` 不得再出现任何帧。错误码集合 SHALL 稳定：`aborted`、`unauthorized`、
`key_invalid`、`key_revoked`、`unknown_service`、`upstream_unreachable`、
`upstream_status`、`body_too_large`、`rate_limited`、`quota_exceeded`、
`forbidden_method`、`protocol_version`、`protocol_seq`、`protocol_error`、
`internal`。

#### Scenario: 客户端中途断开

- **WHEN** 本地客户端在流式响应进行到一半时断开连接
- **THEN** 使用方网关发出 ABORT，提供者中止上游请求，双方以 ERROR(aborted) 终结该请求并释放资源

#### Scenario: 终结后不再收帧

- **WHEN** 某 `id` 已收到 ERROR 帧
- **THEN** 之后到达的任何同 `id` 帧被丢弃，不产生副作用

### Requirement: 帧资源上限

除正文分片上限外，子协议 SHALL 施加结构上限：`path` ≤ 4 KiB、JSON 头总长
≤ 16 KiB。超限帧以 ERROR（code `protocol_error`）回应（携带对应 `id` 时）并丢弃。

#### Scenario: 超长路径被拒

- **WHEN** REQ 帧 path 字段长 8 KiB
- **THEN** 提供者回送 `protocol_error` ERROR 帧并丢弃该请求
