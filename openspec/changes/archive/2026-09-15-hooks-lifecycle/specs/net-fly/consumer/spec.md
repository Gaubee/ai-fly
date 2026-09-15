# net-fly/consumer Delta

## MODIFIED Requirements

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
