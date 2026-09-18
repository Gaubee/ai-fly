# net-fly/consumer 增量

## MODIFIED Requirements

### Requirement: 转发、流式还原与接收侧兜底

对本地映射端口的 HTTP 请求，网关 SHALL 经 opendweb 会话连续性内核
（`SessionHandle.fetchHttp`）转发至对应服务的提供者（Host 头不进请求——上游
Host 由提供者按服务配置决定）。流式响应（SSE/chunked）SHALL 经 bodyNext 逐块
拉取并 flush 还原；非流式响应收齐（EOF）后整体返回；WS 升级请求经内核 keepOpen
字节隧道双向中继（本地侧 node:http upgrade 事件 + ws 库）。上游
status/contentType/正文按 `upstream_status` 语义原样透传。会话终态（dead）
终结的请求 SHALL 按 HTTP 生命周期分流映射：**尚未下发响应头时**映射为本地
HTTP 错误响应（错误码 → 状态码映射表为穷举 Record；`hook_failed` 映射 502 并
携带脱敏 message；会话 dead 映射 504/网络错误语义）；**已进入流式后**失败
SHALL 关闭本地连接终结该响应（状态码已不可改，观感与上游流中断一致）。客户端
断开时网关 SHALL 关闭内核请求（body 迭代器 return / 会话流取消）并清理在途
状态；本地客户端消费过慢时由内核 journal 上限反压（发送侧暂停，内存有界），
达限语义终结该请求并关闭本地连接。

断线窗口（内核 recovering）在途请求 SHALL 挂起等待原序续传，不提前报错、
不重发上游请求；续传后已交付字节零重复。

#### Scenario: 流式对话

- **WHEN** 本地客户端请求映射端口上的 `/v1/chat/completions`（上游为 SSE）
- **THEN** SSE 事件按上游顺序逐块到达本地客户端，观感与直连上游一致

#### Scenario: WS 双向中继

- **WHEN** 本地客户端对映射端口发起 WS 升级（上游为 Responses API WS 端点）
- **THEN** 升级成功后双向消息经内核字节隧道中继，观感与直连一致

#### Scenario: 上游错误透传

- **WHEN** 提供者回送上游 429 status 与正文
- **THEN** 本地客户端收到 429 与原始正文，contentType 一致

#### Scenario: 慢客户端不拖垮内存

- **WHEN** 本地客户端发起流式请求后停止读取
- **THEN** 内核发送侧反压暂停上游供给，内存有界；达限语义该请求被中止、连接以错误关闭，其它请求不受影响

#### Scenario: 脚本失效的本地观感

- **WHEN** 提供者分别在响应头下发前与流式进行中回送 ERROR(hook_failed)
- **THEN** 前者本地客户端收到 502 与脱敏 message；后者本地连接被关闭（已发头部不回退），观感与上游流中断一致

#### Scenario: SSE 中途断线原序续传

- **WHEN** 消费端经 forward 消费 SSE，第 N chunk 后传输连接死亡并在恢复窗口内恢复
- **THEN** 已交付 chunk 不重复、后续 chunk 原序到达、上游请求不重发（provider 副作用执行恰好一次）

#### Scenario: WS 三态

- **WHEN** 会话 active 时双向收发；recovering 时在途帧挂起；dead 时通道关闭
- **THEN** active 正常往返；recovering 不断开本地 WS 且不提前报错；dead 关闭并报网络错误

### Requirement: 提供者在线性与离线语义

网关 SHALL 基于 opendweb `SessionHandle` 状态与 AUTH 状态维护每提供者的连接
状态（未连接 / direct / relay / 已连接未 AUTH / 离线 / key_all_invalid），
`ai-fly status` 如实展示（含各服务映射端口、提供者别名、路径类型、已服务请求
计数）。**在线性消费会话状态而非 peer-disconnected 事件；应用层不再自建
重连/退避/轮询**（第二套生命周期退役——重连由内核 auto-resume 驱动，恢复窗口
90s）。会话 recovering（瞬断窗口）时：在途与新请求 SHALL 挂起等待续传，**不
提前 503**。会话 dead（恢复窗口耗尽/对端终局拒绝）时：在途请求确定错误（504/
网络错误）；**新请求** MUST 立即返回 503 与 JSON 错误（code `provider_offline`，
含提供者别名），不发起注定失败的转发。AUTH 全拒时新请求返回 503
`key_all_invalid`。恢复（新会话）后自动重新 AUTH 并刷新目录。流式/WS 进行中
会话 dead 时，网关 MUST 关闭本地连接（客户端观测为网络错误）并清理在途请求。
provider 重启（REQUEST_STATE_LOST → 重建会话）SHALL 自动续用。relay 断联
无法自愈时，M2 UI 提供一键重新导入兜底。

#### Scenario: 离线快速失败

- **WHEN** 提供者会话 dead 后，客户端向映射端口发起新请求
- **THEN** 立即收到 503 provider_offline，错误信息含提供者别名

#### Scenario: 恢复自动续用

- **WHEN** 提供者重启后内核会话重建（重 AUTH）
- **THEN** 不需使用方干预，映射端口恢复可用，目录与服务视图刷新

#### Scenario: 密钥全被撤销的可见性

- **WHEN** 提供方撤销使用方钥环中全部密钥
- **THEN** 网关状态显示 key_all_invalid，请求返回 503 并提示需要提供方重新签发；`key add` 新钥后自动恢复

#### Scenario: 恢复窗口内瞬断不直达

- **WHEN** 传输瞬断（内核 recovering）期间消费端发起新请求
- **THEN** 请求挂起等待续传而非立即 503；恢复后正常完成

#### Scenario: 恢复窗口耗尽

- **WHEN** 会话 recovering 超过恢复窗口进入 dead
- **THEN** 在途请求确定错误；后续新请求映射 provider_offline 503
