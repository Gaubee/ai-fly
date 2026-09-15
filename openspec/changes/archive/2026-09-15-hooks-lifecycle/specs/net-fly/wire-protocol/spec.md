# net-fly/wire-protocol Delta

## MODIFIED Requirements

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
