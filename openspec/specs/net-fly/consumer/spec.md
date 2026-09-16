# net-fly/consumer Specification

## Purpose

定义使用方（ai-fly 引擎，内部分层标签 net-fly）的行为契约：三种凭据入口（令牌入网/密钥入环/组合链接）、钥环与多提供方并存、本地端口映射、HTTP/WS 请求经帧子协议转发与流式还原、接收侧背压兜底、提供者在线性观测与离线语义、状态观测。使用方通过显式的本地端口消费远程服务——本能力不做任何系统级网络拦截，不做代理（Owner 决策 2026-09-09：代理模式取消）。

## Requirements

### Requirement: 三入口凭据模型（令牌/密钥/组合链接）

使用方 SHALL 提供三个凭据入口，语义与凭据两层模型严格对应：

- `ai-fly join <dweb1令牌> --data <dir>`：**设备入网**（fabric 层）——兑换邀请、
  持久化该提供者的 fabric 身份。仅入网不含任何服务授权（无密钥时 AUTH 全拒）。
- `ai-fly key add <sk-aifly-密钥> --provider <endpointId|别名>`：**密钥入环**
  （应用层）——把裸密钥字符串（任意带外渠道获得）并入指定**已入网**提供者的
  钥环；裸密钥不携带组网信息，对未入网的提供者 MUST 报错指引先 join 或 import。
- `ai-fly import <aifly1.链接> [--data <dir>] [--run] [--preview]`：**组合信封**
  ——链接内含 1 令牌 + 1 密钥 + 元数据；本机已有该提供者 fabric 身份时跳过
  兑换（令牌未被消耗也不需要）、密钥直接入环；否则先兑换再入环。`--preview`
  离线解析链接显示摘要（提供者别名、分组、服务列表与默认端口），零网络请求。
  旧格式链接（payload 不合当前 schema）SHALL 报「分享链接格式已过期，请让
  提供方重新生成」（无迁移路径）。

钥环按 `(提供者, keyId)` 合并幂等；导入/入环 SHALL 显示摘要（别名、EndpointId、
relay、各分组服务与默认端口）。使用方 SHALL 支持多提供者并存：每提供者一个
fabric 实例（同进程多实例已由 SDK 实证），数据目录按提供者隔离；同一提供者的
多枚密钥并存于钥环，AUTH 时一次性呈交全部密钥。`ai-fly forget <endpointId 或
8 字符前缀>` 移除整个导入（本地凭证与映射删除；提供方侧撤销需提供方操作）。
存储目录 0700、文件 0600（钥环含密钥原文）；钥环加载按**提供者记录逐条过滤**
——services 数组内不合当前服务条目 schema 的**陈旧服务条目 SHALL 丢弃**（提供
者记录与密钥保留；发生丢弃即原子写回），下轮 AUTH_OK 目录同步全量重建该提供
者服务视图（自愈，无迁移）；文件级 JSON 非法维持既有告警/损坏语义。

#### Scenario: 新设备组合链接一步到位

- **WHEN** 提供者在线时新设备导入含两服务（defaultPort 11434 与 8787）的组合链接
- **THEN** 兑换 + 入环完成，摘要显示两服务及其默认本地端口，网关运行后两端口在 127.0.0.1 可用

#### Scenario: 老设备追加分组跳过兑换

- **WHEN** 已入网设备导入同提供方另一分组的组合链接
- **THEN** 不消耗令牌（连接已存在），密钥直接入环，两分组服务同时可用

#### Scenario: 裸密钥入环

- **WHEN** 已入网设备运行 `ai-fly key add sk-aifly-xxx --provider <id>`
- **THEN** 密钥入环，下次 AUTH 呈交，对应分组服务可用

#### Scenario: 裸密钥无法替代入网

- **WHEN** 对未入网的提供者运行 `key add`
- **THEN** 报错并指引先 `join` 或 `import`（裸密钥不携带组网信息）

#### Scenario: 多提供方并存

- **WHEN** 使用方先后导入提供者 P1、P2 的链接并启动网关
- **THEN** 两组本地映射同时可用；P1 离线不影响 P2 的映射

#### Scenario: 签发者离线时导入失败

- **WHEN** 提供者进程不在线时新设备导入链接
- **THEN** 复用既有 join 错误语义快速失败，不残留半初始化状态

#### Scenario: 旧格式链接明确报过期

- **WHEN** 使用方导入一条 v1 时期生成的 aifly1. 分享链接
- **THEN** import/preview 报「分享链接格式已过期，请让提供方重新生成」，不残留半初始化状态

#### Scenario: 钥环陈旧条目自愈

- **WHEN** 使用方升级后钥环文件中某提供者的内嵌服务条目为旧形状
- **THEN** 加载时该批条目被丢弃而提供者记录与密钥保留；该提供者在线的下轮目录同步后服务视图完整重建

### Requirement: 端口映射与冲突

使用方网关（`ai-fly run --data <dir>` 长驻，或 `import --run` 一步到位）SHALL
为每个已授权且启用的服务建立本地监听：仅绑定 `127.0.0.1`（MUST NOT 绑定非回环
接口）；端口默认取服务 `defaultPort`，`ai-fly ports <serviceId> --port <n>` 可改。
端口不可用（被占、冲突、特权）时 SHALL 自动改由系统分配空闲端口并在摘要与状态
中**显著标注**实际端口与原因（不打断导入/启动流程）；`--strict-ports` 可改为遇
冲突即报错退出。本地端点为明文 HTTP（含 WS 升级），v1 不做本地鉴权（回环边界即
信任边界）。

#### Scenario: 端口冲突自动错开

- **WHEN** 服务 A 默认端口 11434 被本机 ollama 占用，服务 B 默认端口 8787 空闲
- **THEN** A 自动分配到随机空闲端口并显著标注，B 按 8787 正常映射

#### Scenario: 不监听外网

- **WHEN** 网关运行时从非回环接口探测任一映射端口
- **THEN** 连接被拒绝，所有监听地址仅为 127.0.0.1

### Requirement: 转发、流式还原与接收侧兜底

对本地映射端口的 HTTP 请求，网关 SHALL 按 wire-protocol 构帧转发至对应服务的
提供者（Host 头不进帧——上游 Host 由提供者按服务配置决定）。流式响应
（SSE/chunked）SHALL 逐分片 flush 还原；非流式响应收齐 RESP_END 后整体返回；
WS 升级请求经协议升级通道中继（本地侧 node:http upgrade 事件 + ws 库）。上游
status/contentType/正文按 `upstream_status` 语义原样透传。ERROR 帧终结的请求
SHALL 按 HTTP 生命周期分流映射：**尚未下发响应头时**（pending 阶段）映射为本地
HTTP 错误响应——错误码 → 状态码映射表为**穷举 Record**（wire enum 严格校验保证
消费侧不会收到未知码；新增错误码 MUST 同步登记，由类型系统强制，`hook_failed`
映射 502 并携带脱敏 message）；**已进入流式后**失败 SHALL 关闭本地连接终结该
响应（状态码已不可改，观感与上游流中断一致）。客户端断开时网关 SHALL 发
ABORT（WS 场景发 CLOSE）帧并清理在途状态；本地客户端消费过慢致接收缓冲达限
（默认 4 MiB，WS 双向各自计）时 SHALL 以 `buffer_overflow` 语义终结该请求并
关闭本地连接（内存有界，其它请求不受影响）。

#### Scenario: 流式对话

- **WHEN** 本地客户端请求映射端口上的 `/v1/chat/completions`（上游为 SSE）
- **THEN** SSE 事件按上游顺序逐块到达本地客户端，观感与直连上游一致

#### Scenario: WS 双向中继

- **WHEN** 本地客户端对映射端口发起 WS 升级（上游为 Responses API WS 端点）
- **THEN** 升级成功后双向消息经 DATA 帧中继，观感与直连一致

#### Scenario: 上游错误透传

- **WHEN** 提供者回送上游 429 status 与正文
- **THEN** 本地客户端收到 429 与原始正文，contentType 一致

#### Scenario: 慢客户端不拖垮内存

- **WHEN** 本地客户端发起流式请求后停止读取
- **THEN** 待消费缓冲达 4 MiB 时该请求被中止、连接以错误关闭，进程内存有界

#### Scenario: 脚本失效的本地观感

- **WHEN** 提供者分别在响应头下发前与流式进行中回送 ERROR(hook_failed)
- **THEN** 前者本地客户端收到 502 与脱敏 message；后者本地连接被关闭（已发头部不回退），观感与上游流中断一致

### Requirement: 目录同步处理

网关 SHALL 处理提供者的 refresh AUTH_OK：以全量替换更新服务视图、relay 入口
（`relayUrls`——更新本地存储，供下次重连使用）与本地映射——新增服务按端口规则
建立映射；被移除服务 SHALL 关闭其本地监听并终结该服务在途请求。服务 `detail`
（完整脱敏配置）SHALL 保存在视图内，`ai-fly status --verbose` 可展示（M2 UI
的"展开详情"同源）。检测到 `protocol_seq`（流不可信）时 SHALL 主动重建与该
提供者的连接并以新连接恢复服务。

#### Scenario: 服务删除后的收敛

- **WHEN** 提供者删除某服务并推送刷新
- **THEN** 使用方关闭该服务的本地端口，其新请求立即失败，其它服务不受影响

#### Scenario: relay 入口在线更新

- **WHEN** refresh AUTH_OK 携带与本地存储不同的 relayUrls
- **THEN** 本地 relay 入口被更新；此后重连使用新入口

#### Scenario: 丢批后连接重建

- **WHEN** 使用方检测到某请求分片序号缺断（protocol_seq）
- **THEN** 该请求终结并重建与提供者的连接，重连后其余服务自动恢复

### Requirement: 提供者在线性与离线语义

网关 SHALL 基于会话层事件与 AUTH 状态维护每提供者的连接状态（未连接 / direct /
relay / 已连接未 AUTH / 离线 / key_all_invalid），`ai-fly status` 如实展示（含
各服务映射端口、提供者别名、路径类型、已服务请求计数）。提供者离线或 AUTH 全拒
时：新请求 MUST 立即返回 503 与 JSON 错误（code `provider_offline` 或
`key_all_invalid`，含提供者别名），不发起注定失败的转发；网关 SHALL 以带 full
jitter 的指数退避重连（起点 1s、上限 60s），并以 `linkStatus()` 低频轮询
（30s）复核事件丢失；恢复后自动重新 AUTH 并刷新目录。流式/WS 进行中提供者断连
时，网关 MUST 关闭本地连接（客户端观测为网络错误）并清理在途请求。relay 断联
无法自愈时（提供方换 relay 且错过在线刷新），M2 UI 提供一键重新导入兜底。

#### Scenario: 离线快速失败

- **WHEN** 提供者进程退出后，客户端向映射端口发起请求
- **THEN** 立即收到 503 provider_offline，错误信息含提供者别名

#### Scenario: 恢复自动续用

- **WHEN** 提供者重启后网关重连成功并通过 AUTH
- **THEN** 不需使用方干预，映射端口恢复可用，目录与服务视图刷新

#### Scenario: 密钥全被撤销的可见性

- **WHEN** 提供方撤销使用方钥环中全部密钥
- **THEN** 网关状态显示 key_all_invalid，请求返回 503 并提示需要提供方重新签发；`key add` 新钥后自动恢复

### Requirement: 消费侧服务启停与可复活语义

`ai-fly services` SHALL 列出跨分组服务（状态 + 端口 + 环级停用标注）；
`services stop <provider>`（单参）停用该提供者**全部**服务，`services stop
<provider> <service>` 停用单服务（本地监听关闭，秒级生效）；`services start`
恢复（单服务停用态跨环级停用保持）。`services rm <provider>` SHALL 为
forget 语义（keyring + fabric 身份移除，真删）。consumer 侧停用条目在
provider 目录移除该服务时 SHALL 被修剪（防泄漏），provider 重新暴露后服务
自动复活（可复活语义：跨 provider 目录变化不持久化停用态）。

#### Scenario: 停用-恢复往返

- **WHEN** 消费者停用一个运行中的服务再启动
- **THEN** 端口秒级关闭后恢复同端口；期间 `ai-fly services` 列出
  `(off)`/`disabled` 标注

#### Scenario: forget 真删

- **WHEN** 消费者执行 `services rm <provider>`
- **THEN** 该提供者 keyring 与 fabric 身份被移除，服务列表不再出现
  （与停用的可复活语义不同）
