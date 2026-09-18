# net-fly/wire-protocol Specification

## Purpose

定义 ai-fly 引擎在 fabric 不透明 envelope 之上的帧子协议（内部分层标签 net-fly）：命名空间隔离、AUTH 握手、HTTP 请求多路复用、WebSocket 升级通道、流式分片保序、中止/超时与错误语义、资源上限。协议是 HTTP/WS 级通用转发（方法/路径/头/正文/双向流的承载与还原），不解析业务语义。会话层不解析本协议；本协议不依赖会话层之外的任何内核改动。

## Requirements

### Requirement: 命名空间与版本隔离

所有 ai-fly 帧 SHALL 以固定 magic（`aifly1`，6 字节 ASCII）开头，其后为 1 字节
帧类型与 JSON 头（UTF-8）。接收方对不以该 magic 开头的 envelope MUST 静默忽略
（同一 fabric 可并存其它应用的 envelope 流量）。对 magic 匹配但协议版本不识别的帧，
MUST 回送 ERROR 帧（code `protocol_version`）并丢弃原帧；对版本匹配但类型未知的帧
MUST 记录并忽略，不得终止连接或影响其它请求。

#### Scenario: 混流共存

- **WHEN** 同一 fabric 上另一应用向 ai-fly 端点发送不含 magic 的 envelope
- **THEN** 端点静默忽略该 envelope，既有请求转发不受影响

#### Scenario: 未知帧类型前向兼容

- **WHEN** 接收到 magic 与版本均匹配、但帧类型未定义的帧
- **THEN** 该帧被忽略，同一连接上的后续帧与在途请求正常处理

### Requirement: 帧方向与未知标识符

帧方向 SHALL 固定：使用方→提供方仅 AUTH/REQ/REQ_BODY/DATA_UP/ABORT/CLOSE；
提供方→使用方仅 AUTH_OK/AUTH_ERR/RESP_META/RESP_CHUNK/RESP_END/DATA_DOWN/ERROR/
PING（ERROR 帧仅提供方发出；使用方侧的一切终结均为本地动作：关闭本地连接、清理
在途状态、（适用时）发送 ABORT/CLOSE）。方向违规的处理按侧不同：提供方侧以 ERROR
（code `protocol_error`）回敬并丢弃（若可定位 `id`）；使用方侧静默丢弃并计数。
**检查顺序**：未 AUTH 检查先于方向检查（未授权连接上除 AUTH 外一切帧——含方向
违规——一律静默丢弃计数）。携带**未知 request-id 或已终结 request-id** 的任何帧
MUST 静默丢弃（不回帧、不放大流量）；request-id 一经分配 MUST NOT 复用。

#### Scenario: 方向反转被拒

- **WHEN** 提供方收到使用方发来的 RESP_META 帧
- **THEN** 回送 `protocol_error` ERROR 帧并丢弃；连接与其它请求不受影响

#### Scenario: 使用方侧反向帧静默处理

- **WHEN** 使用方收到提供方发来的 REQ 帧
- **THEN** 帧被静默丢弃计数（使用方不回 ERROR 帧），连接继续服务其它请求

#### Scenario: 已终结 id 的迟到帧

- **WHEN** 某 `id` 已因 ERROR 终结后，又收到该 id 的 RESP_CHUNK
- **THEN** 帧被静默丢弃，不产生任何副作用

### Requirement: 空闲超时

请求级空闲超时 SHALL 双端各自执行：任一端在超时窗（默认 300s，可配置）内未收到
该 `id` 的任何帧（含 PING；WS 请求含任一方向的 DATA 帧）即终结并清理（提供方以
ERROR code `idle_timeout` 回送；使用方为本地动作——关闭本地连接、发 ABORT、清理
在途）。**首字节等待期豁免**：提供方侧对该请求的空闲计时在首字节等待期内挂起——
此阶段使用方不发帧，活度由提供方自身的 PING 发送节奏与上游首字节超时（默认
600s，可配置）管辖，不会在 300s 自杀；使用方侧计时照常（以收到的 PING 为活度
信号）。提供者侧另对上游施加流中途停滞超时（默认 120s，可配置），超时即中止上游
并回送 `idle_timeout`；上游连接期超时（10s）回送 `upstream_unreachable`。终结帧
（RESP_END / CLOSE / ERROR）之后该 `id` 不得再出现任何帧。

#### Scenario: 空闲请求被清理

- **WHEN** 某流式请求 300s 无任何帧推进（也无 PING）
- **THEN** 双端各自以 `idle_timeout` 终结该请求并释放资源

#### Scenario: 深度推理长等待不误杀

- **WHEN** 上游 400 秒未返回首字节（> 300s 空闲窗、< 600s 首字节超时）
- **THEN** 使用方因持续收到 PING 不误杀；提供方侧空闲计时挂起不自杀；至 600s 提供方中止上游并回送 `idle_timeout`

### Requirement: 中止与错误语义

使用方本地客户端断开或接收缓冲达限时，网关 SHALL 发 ABORT 帧（`id`）；提供者
收到后 MUST 中止上游请求并停止分片，回送 ERROR（code `aborted`）作终结。提供者
侧失败（上游不可达、上游错误、限额触发、协议错误、生命周期脚本失效）以 ERROR
帧终结，JSON 头含 `id`（可得时）、`code`、`message`（脱敏：不含密钥与上游凭据、
不含脚本路径与返回值）。ERROR 帧错误码集合 SHALL 稳定：`aborted`、
`buffer_overflow`、`idle_timeout`、`unauthorized`、`key_all_invalid`、
`unknown_service`、`upstream_unreachable`、`upstream_status`、`body_too_large`、
`rate_limited`、`quota_exceeded`、`forbidden_method`、`forbidden_header`、
`secret_missing`、`path_not_offered`、`hook_failed`（②③④ 生命周期脚本失效：
绑定缺席、抛错、返回形状非法、流中途失败）、`protocol_version`、`protocol_seq`、
`protocol_error`、`internal`（`key_invalid`/`key_revoked` 仅作为 AUTH_OK.rejected
载荷码存在）。

#### Scenario: 客户端中途断开

- **WHEN** 本地客户端在流式响应进行到一半时断开连接
- **THEN** 使用方网关发出 ABORT，提供者中止上游请求，双方以 ERROR(aborted) 终结该请求并释放资源

#### Scenario: 终结后不再收帧

- **WHEN** 某 `id` 已收到 ERROR 帧
- **THEN** 之后到达的任何同 `id` 帧被丢弃，不产生副作用

#### Scenario: 脚本失效以 hook_failed 终结

- **WHEN** 服务绑定的 request 脚本在流中途抛错
- **THEN** 提供者以 ERROR(hook_failed) 终结该请求（消息脱敏），使用方按既有 ERROR 处理路径终结本地响应

### Requirement: 目录同步（AUTH_OK 复用）

提供者 SHALL 以 AUTH_OK 帧承载目录：初次授权与后续推送同构，推送时带
`refresh: true`，语义为**全量替换**使用方当前视图（含 `relayUrls` 与服务
`detail`）。服务 detail 投影 SHALL 携带生命周期四槽（auth/headers/request/
response）v2 形状（脚本/密钥注入位掩码 `●`）；投影形状变更不提供跨版本兼容
——**提供者与使用方 SHALL 运行同版本**（开发期 trunk 约定，两端同步升级）。
使用方对 detail 投影解析失败 SHALL 视为**该提供者的目录同步失败**：保留既有
服务视图与映射不动、记录本地错误提示（经通知通道呈现），不影响其它提供者
（不区分专门的版本不匹配状态）；保留旧视图期间后续 AUTH_OK 照常接受，任一次
成功的目录同步 SHALL 覆盖视图并清除该错误态。服务被删除时，刷新视图不含该服务；使用方 SHALL 关闭其本地映射
端口并终结该服务在途请求。未 AUTH 的连接收到 AUTH_OK SHALL 静默丢弃。

#### Scenario: 目录随服务变更推送

- **WHEN** 使用方在线期间提供方向其分组新增一服务
- **THEN** 使用方收到 refresh AUTH_OK，新服务可见并按端口规则尝试本地映射

#### Scenario: 服务删除后的收敛

- **WHEN** 提供者删除某服务并推送刷新
- **THEN** 使用方关闭该服务的本地端口，其新请求立即失败，其它服务不受影响

#### Scenario: 四槽投影脱敏下发

- **WHEN** 服务 auth 槽为脚本绑定、headers.set 含字面量注入头，目录同步推送
- **THEN** 使用方 detail 中四槽结构可见，脚本绑定与注入值渲染为 `●`，无脚本路径与值

#### Scenario: 跨版本目录被安全拒绝

- **WHEN** 旧版本使用方收到新版 detail 投影且解析失败
- **THEN** 该提供者目录同步失败：既有服务视图与本地映射保持不变，本地记录错误提示，其它提供者不受影响

### Requirement: 帧资源上限

除正文分片上限外，子协议 SHALL 施加结构上限：`path` ≤ 4 KiB、`headers` ≤ 32 项、
单键 ≤ 1 KiB、单值 ≤ 8 KiB、JSON 头总长 ≤ 16 KiB。超限帧以 ERROR（code
`protocol_error`）回应（携带对应 `id` 时）并丢弃。REQ 的 `path` 经服务基础路径
拼接并规范化后，提供者 SHALL 双重断言：产物 origin（scheme/host/port）MUST 与
服务 upstream 配置一致，且规范化路径 MUST 仍以服务基础路径为前缀；任一不成立按
`protocol_error` 拒绝且零上游请求（防 `//host` 逃逸与 `..` 回溯越界——path 含
`.`/`..` 段已在 schema 层拒绝，此处断言为纵深防御）。

#### Scenario: 超长路径被拒

- **WHEN** REQ 帧 path 字段长 8 KiB
- **THEN** 提供者回送 `protocol_error` ERROR 帧并丢弃该请求

#### Scenario: 路径注入逃逸被拦

- **WHEN** REQ 帧携带 path `//evil.example.com/v1/keys`
- **THEN** 拼接后 origin 断言失败，回送 `protocol_error`，不发生任何上游请求

#### Scenario: 回溯越界被拦

- **WHEN** REQ 帧携带 path `/../../admin`（schema 层拒绝失效时的纵深防御）
- **THEN** 规范化后基础路径前缀断言失败，回送 `protocol_error`，不发生任何上游请求
