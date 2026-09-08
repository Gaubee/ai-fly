# net-fly/consumer Specification

## Purpose

定义使用方的行为契约：分享链接导入（多密钥钥环）、本地端口映射、请求经帧子协议
转发与流式还原、接收侧背压兜底、提供者在线性观测与离线语义、状态观测。使用方
通过显式的本地端口消费远程服务——本能力不做任何系统级网络拦截，不做代理。

## ADDED Requirements

### Requirement: 链接导入、钥环与多提供方并存

使用方 SHALL 以 `netfly import <link> --data <dir>` 完成导入：解析链接（见
share-link spec）、兑换 fabric 邀请（签发者在线语义复用既有规则）、按
`(提供者, keyId)` 合并进钥环并持久化、显示导入摘要（提供者别名、EndpointId、
relay、各分组服务列表与默认本地端口）。同一提供者的重复导入 SHALL 幂等合并
（新钥入环、旧钥保留直至其被撤销或 `forget`；服务视图刷新）。使用方 SHALL 支持
同时导入多个提供者的链接并存：每提供者一个 fabric 实例（同进程多实例已由 SDK
实证），数据目录按提供者隔离存放；**同一提供者的多枚密钥并存于钥环**（Owner
弹性条款：使用方可同时使用多个密钥），AUTH 时一次性呈交全部密钥。既有导入可
`netfly forget <endpointId 或其 8 字符前缀>` 移除（本地凭证与映射删除；提供方侧
撤销需提供方操作）。存储目录 0700、文件 0600（钥环含密钥原文）。

#### Scenario: 导入即映射

- **WHEN** 提供者在线时导入含两服务（defaultPort 11434 与 8787）的链接
- **THEN** 摘要显示两服务及其默认本地端口，网关运行后两端口在 127.0.0.1 可用

#### Scenario: 同提供方二钥并存

- **WHEN** 使用方先后导入同一提供方两个分组（两枚密钥）的链接
- **THEN** 钥环持有两钥；两个分组的服务同时可见可用，互不干扰

#### Scenario: 多提供方并存

- **WHEN** 使用方先后导入提供者 P1、P2 的链接并启动网关
- **THEN** 两组本地映射同时可用；P1 离线不影响 P2 的映射

#### Scenario: 签发者离线时导入失败

- **WHEN** 提供者进程不在线时导入链接
- **THEN** 复用既有 join 错误语义快速失败，不残留半初始化状态

### Requirement: 端口映射与冲突

使用方网关（`netfly run --data <dir>` 长驻，或 `import --run` 一步到位）SHALL
为每个已授权且启用的服务建立本地监听：仅绑定 `127.0.0.1`（MUST NOT 绑定非回环
接口）；端口默认取服务 `defaultPort`，`netfly ports <serviceId> --port <n>` 可改。
端口不可用（被占、冲突、特权）时 SHALL 自动改由系统分配空闲端口并在摘要与状态
中**显著标注**实际端口与原因（不打断导入/启动流程）；`--strict-ports` 可改为遇
冲突即报错退出。本地端点为明文 HTTP，v1 不做本地鉴权（回环边界即信任边界）。

#### Scenario: 端口冲突自动错开

- **WHEN** 服务 A 默认端口 11434 被本机 ollama 占用，服务 B 默认端口 8787 空闲
- **THEN** A 自动分配到随机空闲端口并显著标注，B 按 8787 正常映射

#### Scenario: 不监听外网

- **WHEN** 网关运行时从非回环接口探测任一映射端口
- **THEN** 连接被拒绝，所有监听地址仅为 127.0.0.1

### Requirement: 转发、流式还原与接收侧兜底

对本地映射端口的 HTTP 请求，网关 SHALL 按 wire-protocol 构帧转发至对应服务的
提供者（Host 头不进帧——上游 Host 由提供者按服务配置决定；v1 端口模式不校验
请求域名）。流式响应（SSE/chunked）SHALL 逐分片 flush 还原；非流式响应收齐
RESP_END 后整体返回。上游 status/contentType/正文按 `upstream_status` 语义原样
透传。客户端断开时网关 SHALL 发 ABORT 帧并清理在途状态；本地客户端消费过慢致
接收缓冲达限（默认 4 MiB）时 SHALL 以 `buffer_overflow` 语义 ABORT 该请求并关闭
本地连接（内存有界，其它请求不受影响）。

#### Scenario: 流式对话

- **WHEN** 本地客户端请求映射端口上的 `/v1/chat/completions`（上游为 SSE）
- **THEN** SSE 事件按上游顺序逐块到达本地客户端，观感与直连上游一致

#### Scenario: 上游错误透传

- **WHEN** 提供者回送上游 429 status 与正文
- **THEN** 本地客户端收到 429 与原始正文，contentType 一致

#### Scenario: 慢客户端不拖垮内存

- **WHEN** 本地客户端发起流式请求后停止读取
- **THEN** 待消费缓冲达 4 MiB 时该请求被中止、连接以错误关闭，进程内存有界

### Requirement: 目录同步处理

网关 SHALL 处理提供者的 refresh AUTH_OK：以全量替换更新服务视图与本地映射——
新增服务按端口规则建立映射；被移除服务 SHALL 关闭其本地监听并终结该服务在途
请求（已建立的本地连接以错误关闭）。检测到 `protocol_seq`（流不可信）时 SHALL
主动重建与该提供者的连接并以新连接恢复服务。

#### Scenario: 服务删除后的收敛

- **WHEN** 提供者删除某服务并推送刷新
- **THEN** 使用方关闭该服务的本地端口，其新请求立即失败，其它服务不受影响

#### Scenario: 丢批后连接重建

- **WHEN** 使用方检测到某请求分片序号缺断（protocol_seq）
- **THEN** 该请求终结并重建与提供者的连接，重连后其余服务自动恢复

### Requirement: 提供者在线性与离线语义

网关 SHALL 基于会话层事件与 AUTH 状态维护每提供者的连接状态（未连接 / direct /
relay / 已连接未 AUTH / 离线 / key_revoked），`netfly status` 如实展示（含各服务
映射端口、提供者别名、路径类型、已服务请求计数）。提供者离线或 AUTH 全拒时：
新请求 MUST 立即返回 503 与 JSON 错误（code `provider_offline` 或
`key_all_invalid`，含提供者别名），不发起注定失败的转发；网关 SHALL 以带 full
jitter 的指数退避重连（起点 1s、上限 60s），并以 `linkStatus()` 低频轮询
（30s）复核事件丢失；恢复后自动重新 AUTH 并刷新目录。流式进行中提供者断连时，
网关 MUST 关闭本地连接（客户端观测为网络错误）并清理在途请求。

#### Scenario: 离线快速失败

- **WHEN** 提供者进程退出后，客户端向映射端口发起请求
- **THEN** 立即收到 503 provider_offline，错误信息含提供者别名

#### Scenario: 恢复自动续用

- **WHEN** 提供者重启后网关重连成功并通过 AUTH
- **THEN** 不需使用方干预，映射端口恢复可用，目录与服务视图刷新

#### Scenario: 密钥全被撤销的可见性

- **WHEN** 提供方撤销使用方钥环中全部密钥
- **THEN** 网关状态显示 key_all_invalid，请求返回 503 并提示需要提供方重新签发；重新导入新链接后自动恢复
