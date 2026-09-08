# api-share/consumer-gateway Specification

## Purpose

定义消费侧网关的行为契约：在回环地址暴露 OpenAI 兼容端点、本地 API key 鉴权、
请求经帧子协议转发与 SSE 还原、提供者在线性观测与离线语义、Agent 配置写手。
目标用户显式修改 Agent 的 base URL——本能力不做任何系统级网络拦截。

## ADDED Requirements

### Requirement: 消费者命令面与接入流

消费者 SHALL 以 `use <dweb1-invite-token>` 一步完成：兑换邀请加入 fabric（签发者
在线语义复用既有规则）、在数据目录持久化成员身份与提供者 EndpointId、生成本地 API
key、启动网关并打印接入卡（base URL `http://127.0.0.1:<port>/v1`、本地 key、提供者
别名与 EndpointId、模型目录）。对已存在的数据目录，`use` SHALL 复用既有身份直接
连接提供者（跳过兑换）。配套命令：`status`（提供者在线状态与当前路径类型
direct/relay、已服务请求计数）、`key rotate`、`setup <agent>`。选项解析与用户面
字符串约束与提供者命令面一致（英文 ASCII、`--opt value`/`--opt=value` 等价、`~`
展开、未知选项退出码 2）。

#### Scenario: 一步接入

- **WHEN** 提供者在线时运行 `use <token> --data ~/.aifly/consumer --port 8788`
- **THEN** 兑换成功，打印接入卡（base URL、sk-aifly- 开头 key、提供者别名与模型目录），网关持续运行

#### Scenario: 再次 use 直连

- **WHEN** 数据目录已含成员身份，再次运行 `use`（无论是否带 token）
- **THEN** 不重新兑换，直接以既有身份连接提供者并启动网关

#### Scenario: 签发者离线时兑换失败

- **WHEN** 提供者进程不在线时运行首次 `use <token>`
- **THEN** 复用既有 join 错误语义快速失败（如 DIAL_TIMEOUT 指引），不残留半初始化状态

### Requirement: 回环端点与本地鉴权

网关 SHALL 仅绑定 `127.0.0.1`（MUST NOT 绑定非回环接口）。默认端口 8788；端口被占时
MUST 以退出码非零报错并给出指引，`--port 0` 时由系统分配并打印实际端口。请求 MUST
携带 `Authorization: Bearer <本地 key>`；缺失或不匹配返回 OpenAI 风格 401 JSON；
比较 MUST 常数时间。本地 key 生成于首次 `use`，落盘权限 0600，MUST NOT 经帧子协议
离开本机。白名单路径集（与提供者一致）之外的请求返回 404。

#### Scenario: key 错误被拒

- **WHEN** 客户端以错误 Bearer key 调用 `/v1/chat/completions`
- **THEN** 返回 401 与 OpenAI 风格 error JSON，不产生任何对外帧

#### Scenario: 不监听外网

- **WHEN** 网关运行时从非回环接口探测默认端口
- **THEN** 连接被拒绝，监听地址仅为 127.0.0.1

### Requirement: 转发与流式还原

对白名单路径的合法请求，网关 SHALL 按 wire-protocol 构帧转发至提供者 EndpointId。
`stream: true` 的响应 SHALL 以 `text/event-stream` 逐分片 flush 还原；非流式响应收齐
RESP_END 后整体返回。提供者按 `upstream_status` 回送上游 status 与正文时，网关 SHALL
原样透传 status、contentType 与正文（消费侧 Agent 得以上游视角排障）。客户端断开时
网关 SHALL 发 ABORT 帧并清理在途状态。

#### Scenario: 流式对话

- **WHEN** Agent 以 base URL 指向网关发起 `stream: true` 的 chat 请求
- **THEN** SSE 事件按上游顺序逐块到达，以 `data: [DONE]` 语义收尾，观感与直连上游一致

#### Scenario: 上游错误透传

- **WHEN** 提供者回送上游 429 status 与正文
- **THEN** Agent 收到 429 与原始正文，contentType 一致

### Requirement: 提供者在线性与离线语义

网关 SHALL 基于会话层事件维护提供者在线状态（未连接 / direct / relay / 离线），
`status` 命令如实展示。提供者离线时新请求 MUST 立即返回 503 与 OpenAI 风格 error
（code `provider_offline`），不发起注定失败的转发；流式进行中断连时，网关 MUST 关闭
本地连接（客户端观测为网络错误），同时清理在途请求。

#### Scenario: 离线快速失败

- **WHEN** 提供者进程退出后，Agent 向网关发起请求
- **THEN** 立即收到 503 provider_offline，错误信息含提供者别名

#### Scenario: 流中断连

- **WHEN** 流式响应进行中提供者掉线
- **THEN** 本地连接被关闭，网关在途状态清零，后续请求进入离线快速失败

### Requirement: Agent 配置写手

`setup <agent>` SHALL 支持 `codex`、`cursor`、`cline`、`continue`：定位对应配置文件，
写入 base URL（回环端点）与本地 key 的环境变量引用（写入文件的是变量名而非明文 key；
对不支持环境变量间接的 Agent 写 key 并提示权限收紧）。写手 MUST 先打印每个将改动
文件的统一 diff，经 `--yes` 或交互确认后原子写入；已存在同名配置项时更新而非重复追加。
`--print` 仅打印配置片段不落盘（覆盖未支持 Agent 的场景）。

#### Scenario: codex 接入

- **WHEN** 运行 `setup codex` 并确认
- **THEN** codex 配置新增/更新 ai-fly provider（base_url 指向回环端点，凭据经环境变量引用），终端打印改动 diff

#### Scenario: 空跑不落盘

- **WHEN** 运行 `setup cursor --print`
- **THEN** 仅打印应写入的配置片段，磁盘无任何变更
