# net-fly/provider 增量

## MODIFIED Requirements

### Requirement: AUTH 校验与目录同步

AUTH 改 HTTP 端点（`/_aifly/auth`，经 opendweb `Fabric.serveHttp` 会话承载）：
会话 active 后消费端呈交多密钥集合；逐钥校验 → 定位分组 → 200 AUTH_OK 语义
（`alias`、`relayUrls`、每有效密钥的 `{keyId, group, limits, services}` 视图、
`rejected` 列表）。服务视图含**完整脱敏披露 `detail`**（upstream、match 全集、
rewrite 规则、生命周期绑定——自定义模式四槽与预设模式 `hooks` 槽，脚本注入位
显示 `●`；`$env` 注入头值仅显示 `●`，变量名不显示）——除凭据值外无隐藏。
`limits` 结构 SHALL 为 `{maxConcurrency?: number, dailyRequests?: number}`
（分组级，可选、缺省不限）。`serviceId` 不在授权视图内时统一回送
`unknown_service`（不区分不存在与无权，防枚举）。服务或密钥变更时 SHALL 向
已授权会话经目录刷新通道推送 `refresh: true` 的全量视图（语义不变）。鉴权
结果按 session_id 缓存——传输断线恢复（同会话续传）不重 AUTH；provider 重启
（会话注册表丢失 → REQUEST_STATE_LOST）时消费端重建会话并重 AUTH。空钥环
（join-only）保持 connected-unauthed，不发起 AUTH。

#### Scenario: 目录随服务变更推送

- **WHEN** 使用方在线期间提供方向其分组新增一服务
- **THEN** 使用方收到 refresh 全量视图（含新服务 detail），按默认端口规则尝试本地映射

#### Scenario: 越权服务统一拒绝

- **WHEN** 使用方请求的 serviceId 属于其未获授权的分组
- **THEN** 回送 `unknown_service`，与不存在的 serviceId 响应无差别

#### Scenario: detail 披露脱敏

- **WHEN** 服务的 rewrite 含 headerSet `Authorization: $env:ZAI_KEY`
- **THEN** 目录 detail 中该项显示为 `Authorization: ●`；环境变量名与值均不出现在任何响应

#### Scenario: 断线恢复不重 AUTH

- **WHEN** 已 AUTH 会话传输断线并在恢复窗口内续传
- **THEN** 目录视图不变、无需重呈密钥、在途请求继续

#### Scenario: provider 重启

- **WHEN** provider 进程重启（内存会话注册表丢失）
- **THEN** 消费端 RESUME 被 REQUEST_STATE_LOST 拒绝 → 重建会话重 AUTH；重启前的在途请求确定错误不悬挂

### Requirement: 上游转发与重写

对已授权会话的请求，提供者 SHALL：按 `serviceId` 定位服务（未授权/未知 →
`unknown_service`）；以服务配置构造上游 URL（upstream 基础路径 + 前缀剥离/追加
后的请求路径，拼接规范化后 origin MUST 等于 upstream origin **且** 路径 MUST
仍以基础路径为前缀，任一不成立 `protocol_error` 且零上游请求）；转发头集 =
请求 headers（凭据类已在协议层剥离并拒绝）经生命周期 auth 阶段（Authorization
注入）与 headers 阶段（remove → set → 整段脚本增量）覆写；Host 头由服务配置
决定（缺省上游 host，rewrite 可覆盖），MUST NOT 来自帧内。绑定 request 脚本的
服务 SHALL 由脚本产出上游响应（归一形与流式契约见生命周期条款）；绑定 response
脚本的服务 SHALL 在响应归一后经脚本变换再下发。携带 WS 握手头的请求 SHALL 经
内核 keepOpen 字节隧道与上游执行握手并进入双向中继（auth/headers 阶段对 WS
生效，request 接管不适用于 WS）。上游 4xx/5xx 按 `upstream_status` 原样回送
status 与正文；上游不可达/连接期超时（默认 10s）回送 `upstream_unreachable`；
首字节超时与流中途停滞超时沿用现行空闲超时语义。上游 URL 目标仅来自本地服务
配置，MUST NOT 受请求内任何字段影响（防 SSRF）。

承载面：请求经 opendweb `Fabric.serveHttp` handler 的 HTTP 投影到达（OPEN
元数据 + DATA），响应 body 由 handler 供给（内核 journal 承接断线重放与
发送侧反压）。发送侧缓冲兜底（bufferOverflows）退役，观测面为内核
journalBytes。

#### Scenario: 重写后命中上游

- **WHEN** 服务 upstream 为 `http://127.0.0.1:11434`、auth 槽为密钥库引用、headers.set 含 `X-Custom: literal`，使用方请求 `POST /v1/chat/completions`
- **THEN** 上游收到 `http://127.0.0.1:11434/v1/chat/completions`，Authorization 为密钥库值（Bearer 前缀按 auth.bearer 开关），X-Custom 为字面量，且请求不含使用方侧凭据头

#### Scenario: 帧内不可指定上游

- **WHEN** 恶意使用方在请求 path 或 headers 构造 `//evil.com/…`、`/../../admin`、`Host:` 覆盖等注入
- **THEN** schema 层 `..` 段拒绝 / 拼接 origin 与基础路径前缀断言 / headers 白名单拒绝（`protocol_error` / `forbidden_header`），零上游请求

#### Scenario: 上游错误原样透传

- **WHEN** 上游返回 401 与 JSON 正文
- **THEN** 使用方本地客户端收到 401 与原始正文，contentType 一致

#### Scenario: 转发管线回归

- **WHEN** 既有上游转发用例（路径改写/头阶段/SSE 透传）经新承载面执行
- **THEN** 行为与旧承载面一致（回归测试全绿）
