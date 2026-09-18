# net-fly/wire-protocol Specification

## Purpose

定义 ai-fly 引擎在 opendweb 会话连续性内核之上的应用层子协议（内部分层标签
net-fly）。**承载面自 opendweb-kernel-migration 起为 HTTP 投影**：控制面端点
（`/_aifly/auth` 多密钥呈交、`/_aifly/catalog-watch` 目录长轮询）与数据面转发
（`SessionHandle.fetchHttp` + bodyNext 流式还原、WS keepOpen 字节隧道）。协议是
HTTP/WS 级通用转发（方法/路径/头/正文/双向流的承载与还原），不解析业务语义。
会话层不解析本协议；本协议不依赖会话层之外的任何内核改动。

**退役声明（superseded）**：旧 aifly1 envelope 帧族——magic 前缀、REQ/RESP 帧
类型与帧方向、分片序号（protocol_seq）、PING 活度、ABORT 帧——随内核迁移退役。
其承载的保证由内核承接：请求多路复用与分片保序（journal 原序重放）、断线原序
续传（recovering 挂起 + 90s 恢复窗口）、发送侧反压（journal 上限）、中止传播
（cancel signal / RESET）与终态后迟到数据幂等。仍在运行的静态遗产为共享 schema
与常量（错误码集合、服务 detail 四槽投影、路径/头资源上限——`src/wire/frames.ts`），
服务于 HTTP 投影与 share-link 编码，不再是线上帧格式。

## Requirements

### Requirement: 会话承载与端点语义

同一内核会话 SHALL 同时承载 ai-fly 控制面（auth/catalog-watch）与数据面
（forward）流量，与该会话上的其它应用流量互不干扰（内核多流契约）。控制面对
未知路径与不支持的请求方法 SHALL 按 HTTP 语义本地处理（未授权 401、方法不支持
405 forbidden_method），不得影响同一会话上的其它请求。会话/流终态（dead/
closed/RESET）后到达的迟到数据 MUST 零副作用（内核终态幂等；ai-fly 侧不再自建
帧方向/序号检查）。

#### Scenario: 控制面与数据面并存

- **WHEN** 同一内核会话上 AUTH、catalog-watch 与 forward 请求并发进行
- **THEN** 各端点互不干扰，请求各自正常完成

#### Scenario: 未知路径与方法的本地处理

- **WHEN** 控制面收到未知路径或枚举外方法的请求
- **THEN** 本地回 401/405（不触达上游），同一会话的其它请求不受影响

#### Scenario: 终态后迟到数据零副作用

- **WHEN** 某请求已因终结（会话终态或流终结）关闭后仍有迟到数据到达
- **THEN** 迟到数据被内核终态幂等丢弃，不产生任何副作用（原「帧方向/已终结
  id 迟到帧」族条款的内核承接形态）

### Requirement: 上游与请求超时

提供者 SHALL 对上游施加：连接期超时（默认 10s，超时回送 `upstream_unreachable`
且零 fetch）、首字节超时（默认 600s，超时中止上游并回送 `idle_timeout`）与流
中途停滞超时（默认 120s，可配置，超时中止上游并回送 `idle_timeout`）。请求级
双端空闲窗与 PING 活度信号随 envelope 退役：传输中断期间的活度与保序由内核
恢复窗口承接——消费端在 recovering（90s 窗口内）SHALL 挂起在途与新请求、不提
前报错；窗口耗尽入 dead 后按消费侧离线语义终结。

#### Scenario: 流中途停滞被清理

- **WHEN** 流式响应在传输中途超过停滞超时窗（默认 120s）无任何字节推进
- **THEN** 提供者中止上游并以 `idle_timeout` 终结该请求、释放资源

#### Scenario: 长等待与瞬断不误杀

- **WHEN** 上游长时间未返回首字节，或传输瞬断处于恢复窗口内
- **THEN** 消费端挂起等待不提前报错；恢复后原序续传；至首字节超时提供方以
  `idle_timeout` 终结

### Requirement: 中止与错误语义

消费端本地客户端断开或接收缓冲达限时，网关 SHALL 取消内核请求（body 迭代器
return / abortKey `abortFetch` / 会话流取消）并清理在途状态；提供者收到取消
信号（signal，含预中止）MUST 中止上游请求、停止分片且零上游触达（预中止时含
零 TCP 探测）。提供者侧失败（上游不可达、上游错误、限额触发、协议错误、生命
周期脚本失效）以错误终结：响应头未下发时为本地 HTTP 错误响应，流式中为关闭
本地连接；错误消息 MUST 脱敏（不含密钥与上游凭据、不含脚本路径与返回值）。
错误码集合 SHALL 稳定：`aborted`、`buffer_overflow`、`idle_timeout`、
`unauthorized`、`key_all_invalid`、`unknown_service`、`upstream_unreachable`、
`upstream_status`、`body_too_large`、`rate_limited`、`quota_exceeded`、
`forbidden_method`、`forbidden_header`、`secret_missing`、`path_not_offered`、
`hook_failed`（②③④ 生命周期脚本失效：绑定缺席、抛错、返回形状非法、流中途
失败）、`protocol_version`、`protocol_seq`、`protocol_error`、`internal`
（`key_invalid`/`key_revoked` 仅作为 AUTH_OK.rejected 载荷码存在；
`protocol_version`/`protocol_seq` 为 envelope 时代历史码，保留枚举以稳定错误
映射，不再由运行时产生）。

#### Scenario: 客户端中途断开

- **WHEN** 本地客户端在流式响应进行到一半时断开连接
- **THEN** 网关取消内核请求，提供者中止上游请求，双方清理在途状态并释放资源

#### Scenario: 脚本失效以 hook_failed 终结

- **WHEN** 服务绑定的 request 脚本在流中途抛错
- **THEN** 提供者以 hook_failed 终结该请求（消息脱敏），使用方按既有错误处理
  路径终结本地响应

### Requirement: 目录同步（AUTH_OK 复用）

提供者 SHALL 以 AUTH_OK 响应承载目录：初次授权与后续推送同构（控制面
`/_aifly/auth` 响应与 `/_aifly/catalog-watch` 长轮询推送），推送时带
`refresh: true`，语义为**全量替换**使用方当前视图（含 `relayUrls` 与服务
`detail`）。服务 detail 投影 SHALL 携带生命周期四槽（auth/headers/request/
response）v2 形状（脚本/密钥注入位掩码 `●`）；投影形状变更不提供跨版本兼容
——**提供者与使用方 SHALL 运行同版本**（开发期 trunk 约定，两端同步升级）。
使用方对 detail 投影解析失败 SHALL 视为**该提供者的目录同步失败**：保留既有
服务视图与映射不动、记录本地错误提示（经通知通道呈现），不影响其它提供者
（不区分专门的版本不匹配状态）；保留旧视图期间后续 AUTH_OK 照常接受，任一次
成功的目录同步 SHALL 覆盖视图并清除该错误态。服务被删除时，刷新视图不含该
服务；使用方 SHALL 关闭其本地映射端口并终结该服务在途请求。未 AUTH 的会话
收到 AUTH_OK 语义载荷 SHALL 静默丢弃。

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

### Requirement: 请求资源上限

除正文上限外，子协议 SHALL 施加结构上限：本地网关 `path` ≤ 4 KiB（超限回
400 `protocol_error` 且零转发）、请求体 ≤ 8 MiB（413 `body_too_large` 零转发）、
`headers` ≤ 32 项、单键 ≤ 1 KiB、单值 ≤ 8 KiB。REQ 的 `path` 经服务基础路径
拼接并规范化后，提供者 SHALL 双重断言：产物 origin（scheme/host/port）MUST 与
服务 upstream 配置一致，且规范化路径 MUST 仍以服务基础路径为前缀；任一不成立
按 `protocol_error` 拒绝且零上游请求（防 `//host` 逃逸与 `..` 回溯越界——path
含 `.`/`..` 段已在 schema 层拒绝，此处断言为纵深防御）。

#### Scenario: 超长路径被拒

- **WHEN** 请求 path 字段长 8 KiB
- **THEN** 本地网关回 400 `protocol_error`，零转发

#### Scenario: 路径注入逃逸被拦

- **WHEN** 请求携带 path `//evil.example.com/v1/keys`
- **THEN** 拼接后 origin 断言失败，回送 `protocol_error`，不发生任何上游请求

#### Scenario: 回溯越界被拦

- **WHEN** 请求携带 path `/../../admin`（schema 层拒绝失效时的纵深防御）
- **THEN** 规范化后基础路径前缀断言失败，回送 `protocol_error`，不发生任何上游请求
