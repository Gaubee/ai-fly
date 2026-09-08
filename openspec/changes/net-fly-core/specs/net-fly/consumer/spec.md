# net-fly/consumer Specification

## Purpose

定义使用方的行为契约：分享链接导入、本地端口映射、请求经帧子协议转发与流式
还原、提供者在线性观测与离线语义、状态观测。使用方通过显式的本地端口消费远程
服务——本能力不做任何系统级网络拦截，不做代理。

## ADDED Requirements

### Requirement: 链接导入与多提供方并存

使用方 SHALL 以 `netfly import <link> --data <dir>` 完成导入：解析链接（见
share-link spec）、兑换 fabric 邀请（签发者在线语义复用既有规则）、持久化分组
凭证与服务视图、显示导入摘要（提供者别名、EndpointId、relay、服务列表与各自
默认本地端口）。对同一提供者的重复导入 SHALL 幂等更新（刷新密钥与服务视图），
不产生重复映射。使用方 SHALL 支持同时导入多个提供者的链接并存：每提供者一个
fabric 实例（同进程多实例已由 SDK 实证），数据目录按提供者隔离存放。既有导入
可 `netfly forget <provider>` 移除（本地凭证删除；提供方侧撤销需提供方操作）。

#### Scenario: 导入即映射

- **WHEN** 提供者在线时导入含两服务（defaultPort 11434 与 8787）的链接
- **THEN** 摘要显示两服务及其默认本地端口，网关运行后两端口在 127.0.0.1 可用

#### Scenario: 多提供方并存

- **WHEN** 使用方先后导入提供者 P1、P2 的链接并启动网关
- **THEN** 两组本地映射同时可用；P1 离线不影响 P2 的映射

#### Scenario: 签发者离线时导入失败

- **WHEN** 提供者进程不在线时导入链接
- **THEN** 复用既有 join 错误语义快速失败，不残留半初始化状态

### Requirement: 端口映射与冲突

使用方网关（`netfly run --data <dir>` 长驻，或 `import --run` 一步到位）SHALL
为每个已启用的服务建立本地监听：仅绑定 `127.0.0.1`（MUST NOT 绑定非回环接口）；
端口默认取服务 `defaultPort`，`netfly ports <service> --port <n>` 可改。端口被
其它进程占用时该服务映射 MUST 明确报错（含占用端口与服务名）且不阻塞其它服务
的映射；`--port 0` 表示自动分配并在状态中显示实际端口。本地端点为明文 HTTP，
v1 不做本地鉴权（回环边界即信任边界）。

#### Scenario: 端口冲突隔离

- **WHEN** 服务 A 默认端口 11434 被本机 ollama 占用，服务 B 默认端口 8787 空闲
- **THEN** 启动时 A 报冲突错误并指引改端口，B 正常映射可用

#### Scenario: 不监听外网

- **WHEN** 网关运行时从非回环接口探测任一映射端口
- **THEN** 连接被拒绝，所有监听地址仅为 127.0.0.1

### Requirement: 转发与流式还原

对本地映射端口的 HTTP 请求，网关 SHALL 按 wire-protocol 构帧转发至对应服务的
提供者：请求头中 `host` 重写为目的服务的域名视图（服务 match 集首个 exact/suffix
值或上游域名的本地视图，供提供者重写链参考；v1 端口模式不因 Host 不匹配而拒绝
——宽松转发）。流式响应（SSE/chunked）SHALL 逐分片 flush 还原；非流式响应收齐
RESP_END 后整体返回。上游 status/contentType/正文按 `upstream_status` 语义原样
透传。客户端断开时网关 SHALL 发 ABORT 帧并清理在途状态。

#### Scenario: 流式对话

- **WHEN** 本地客户端请求映射端口上的 `/v1/chat/completions`（上游为 SSE）
- **THEN** SSE 事件按上游顺序逐块到达本地客户端，观感与直连上游一致

#### Scenario: 上游错误透传

- **WHEN** 提供者回送上游 429 status 与正文
- **THEN** 本地客户端收到 429 与原始正文，contentType 一致

### Requirement: 提供者在线性与离线语义

网关 SHALL 基于会话层事件与 AUTH 状态维护每提供者的连接状态（未连接 / direct /
relay / 已连接未 AUTH / 离线），`netfly status` 如实展示（含各服务映射端口、
提供者别名、路径类型、已服务请求计数）。提供者离线或 AUTH 被拒时：新请求 MUST
立即返回 503 与 JSON 错误（code `provider_offline` 或 `key_revoked`，含提供者
别名），不发起注定失败的转发；网关 SHALL 周期性重连（指数退避，上限 60s），
恢复后自动重新 AUTH 并刷新目录。流式进行中提供者断连时，网关 MUST 关闭本地
连接（客户端观测为网络错误）并清理在途请求。

#### Scenario: 离线快速失败

- **WHEN** 提供者进程退出后，客户端向映射端口发起请求
- **THEN** 立即收到 503 provider_offline，错误信息含提供者别名

#### Scenario: 恢复自动续用

- **WHEN** 提供者重启后网关重连成功并通过 AUTH
- **THEN** 不需使用方干预，映射端口恢复可用，目录与服务视图刷新

#### Scenario: 密钥被撤销的可见性

- **WHEN** 提供方撤销使用方所持密钥
- **THEN** 网关状态显示 key_revoked，请求返回 503 并提示需要提供方重新签发
