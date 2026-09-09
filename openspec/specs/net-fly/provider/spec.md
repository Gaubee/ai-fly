# net-fly/provider Specification

## Purpose

定义提供方（ai-fly 引擎，内部分层标签 net-fly）的行为契约：服务（域名展示集+上游+重写）与分组、密钥的管理与持久化、AUTH 校验与应用层授权、上游转发与重写（含 WebSocket 升级）、限额、目录同步、分享链接签发。成员资格与撤销语义复用 fabric 名册/会话层；分组/密钥授权是应用层，二者两级并存。凭据两层分离：令牌（fabric/设备准入）与密钥（应用层/分组授权）是不同的东西。

## Requirements

### Requirement: 服务模型与持久化

提供方 SHALL 以本地存储（数据目录内，目录 0700、文件 0600，原子写 tmp+rename）
管理**服务**：每服务含 `serviceId`（8 字节随机 z-base-32）、`name`（人可读、
提供方内唯一）、`match`（域名匹配数组，元素为 `{type: exact|suffix|regex,
value}`——**纯展示元数据**：用于目录披露与 UI 归属说明，无任何运行时路由语义，
代理模式已取消）、`upstream`（上游 URL：scheme/host/port/基础路径）、`rewrite`
（可选：host 头覆盖、路径前缀剥离/追加、headerSet/headerRemove；headerSet 值
支持 `$env:VAR` 间接引用——空串与未设置同义，该头省略，serve 启动时对已声明但
为空的变量输出 WARNING；解析时机为每请求）、`defaultPort`（使用方本地默认端口，
缺省取上游端口；上游端口 < 1024 时 MUST 显式声明）。服务可属多个分组。正则规则
MUST 在保存时通过编译检查（语法合法即可——match 无运行时执行面，无 ReDoS 暴露）。

#### Scenario: 服务定义往返

- **WHEN** 提供方添加服务 `{name:"ollama", match:[{type:"suffix",value:".local"}], upstream:"http://127.0.0.1:11434", defaultPort:11434}` 后重启进程
- **THEN** 服务从本地存储完整恢复，EndpointId 与名册不变

#### Scenario: 非法正则被拒

- **WHEN** 保存语法非法的正则规则
- **THEN** 保存被拒绝并说明原因，既有服务不受影响

#### Scenario: 特权上游端口强制显式

- **WHEN** 添加 upstream 为 `https://api.example.com`（端口 443）的服务而未声明 defaultPort
- **THEN** 保存被拒绝并要求显式 defaultPort（避免使用方侧连环冲突与特权端口）

### Requirement: 分组与密钥

提供方 SHALL 将服务编入**分组**（分组含 `name` 与服务引用列表；一服务可属多组），
并为分组签发**访问密钥**（`keyId` + 随机密钥原文，`sk-aifly-` 前缀、z-base-32；
原文仅在签发时展示一次，存储仅保留 SHA-256 哈希）。一分组可持多枚密钥；密钥可
单独撤销（撤销即刻生效：剔除其授权视图或断开无余钥会话，后续 AUTH 计入
rejected）。密钥校验 MUST 常数时间比较（哈希后比较）。密钥与设备无关：任何已
入网设备持钥即得访问，撤钥切断所有持钥设备，撤令牌只踢一台设备（两级撤销）。

#### Scenario: 一组多钥独立撤销

- **WHEN** 分组持有钥 A、B，两使用方分别在线；提供方撤销钥 A
- **THEN** 钥 A 的授权被剔除（无余钥则断会话）、重连后 AUTH 计入 rejected；钥 B 的使用方完全不受影响

#### Scenario: 密钥原文不可再现

- **WHEN** 提供方查看既有密钥列表
- **THEN** 仅显示 keyId、创建时间与状态；原文不再出现

### Requirement: AUTH 校验与目录同步

提供者 SHALL 按 wire-protocol 处理 AUTH（多密钥集合）：逐钥校验 → 定位分组 →
AUTH_OK（`alias`、`relayUrls`（当前生效 relay 入口，随目录刷新同步）、每有效密钥
的 `{keyId, group, limits, services}` 视图、`rejected` 列表）。服务视图含**完整
脱敏披露 `detail`**（upstream、match 全集、rewrite 规则；`$env` 注入头值仅显示
`●`，变量名不显示）——除凭据值外无隐藏。`limits` 结构 SHALL 为
`{maxConcurrency?: number, dailyRequests?: number}`（分组级，可选、缺省不限）。
REQ 的 `serviceId` 不在授权视图内时统一回送 `unknown_service`（不区分不存在与
无权，防枚举）。服务或密钥变更时 SHALL 向已授权在线会话推送 `refresh: true` 的
AUTH_OK（全量替换语义）。

#### Scenario: 目录随服务变更推送

- **WHEN** 使用方在线期间提供方向其分组新增一服务
- **THEN** 使用方收到 refresh AUTH_OK（含新服务 detail），按默认端口规则尝试本地映射

#### Scenario: 越权服务统一拒绝

- **WHEN** 使用方请求的 serviceId 属于其未获授权的分组
- **THEN** 回送 `unknown_service`，与不存在的 serviceId 响应无差别

#### Scenario: detail 披露脱敏

- **WHEN** 服务的 rewrite 含 headerSet `Authorization: $env:ZAI_KEY`
- **THEN** 目录 detail 中该项显示为 `Authorization: ●`；环境变量名与值均不出现在任何帧

### Requirement: 上游转发与重写

对通过 AUTH 的 REQ，提供者 SHALL：按 `serviceId` 定位服务（未授权/未知 →
`unknown_service`）；以服务配置构造上游 URL（upstream 基础路径 + 前缀剥离/追加
后的请求路径，拼接规范化后 origin MUST 等于 upstream origin **且** 路径 MUST
仍以基础路径为前缀，任一不成立 `protocol_error` 且零上游请求）；转发头集 =
REQ.headers（凭据类已在协议层剥离并拒绝）经服务 headerSet/headerRemove 覆盖
（`$env:VAR` 解析，空/未设置则该头省略）；Host 头由服务配置决定（缺省上游
host，rewrite 可覆盖），MUST NOT 来自帧内。携带 WS 握手头的请求 SHALL 按协议
升级通道条款与上游执行握手并进入双向中继。上游 4xx/5xx 按 `upstream_status`
原样回送 status 与正文；上游不可达/连接期超时（默认 10s）回送
`upstream_unreachable`；首字节超时与流中途停滞超时按 wire-protocol 空闲超时
条款。上游 URL 目标仅来自本地服务配置，MUST NOT 受帧内任何字段影响（防
SSRF）。

#### Scenario: 重写后命中上游

- **WHEN** 服务 upstream 为 `http://127.0.0.1:11434`、rewrite 含 headerSet
  `Authorization: $env:UPSTREAM_KEY`（环境变量已设），使用方请求 `POST /v1/chat/completions`
- **THEN** 上游收到 `http://127.0.0.1:11434/v1/chat/completions`，Authorization 为环境变量值，且请求不含使用方侧凭据头

#### Scenario: 帧内不可指定上游

- **WHEN** 恶意使用方在 REQ 帧 path 或 headers 构造 `//evil.com/…`、`/../../admin`、`Host:` 覆盖等注入
- **THEN** schema 层 `..` 段拒绝 / 拼接 origin 与基础路径前缀断言 / headers 白名单拒绝（`protocol_error` / `forbidden_header`），零上游请求

#### Scenario: 上游错误原样透传

- **WHEN** 上游返回 401 与 JSON 正文
- **THEN** 使用方本地客户端收到 401 与原始正文，contentType 一致

### Requirement: 限额

提供方 SHALL 支持分组级可选限额：并发在途请求数（`maxConcurrency`）、每日请求数
（`dailyRequests`，按 keyId 分别计数，UTC 日界重置，持久化于数据目录）。超限在
拨号上游之前回送 `rate_limited` / `quota_exceeded`。用量记录默认关闭；开启时仅
元数据（keyId、serviceId、status、字节数、时间戳），MUST NOT 记录正文。

#### Scenario: 并发限额

- **WHEN** 分组并发上限 2 且两个流式请求在途，第三个请求到达
- **THEN** 第三个请求立即收到 `rate_limited` ERROR，不影响前两个请求

### Requirement: 提供方命令面

提供方 CLI（bin `ai-fly`）SHALL 提供：`ai-fly serve --data <dir>`（长驻：加载
服务/分组/密钥、fabric createRoot/open 复入、启动横幅打印 EndpointId/fabric-id/
服务数/分组与密钥数/relay 配置/空 `$env` 变量 WARNING）、`ai-fly service
<add|list|remove>`、`ai-fly group <add|list>`、`ai-fly key <issue|list|revoke>
--group <name>`、`ai-fly share --group <name> [--ttl <dur>]`（生成分享链接，见
share-link spec）、`ai-fly revoke <endpointId>`（fabric 级踢出设备）、
`ai-fly status`。TTL 值域校验在 CLI 层执行（1s..30d，复用时长解析约定）。用户面
字符串 SHALL 为英文且码位 < 128；选项解析 `--opt value`/`--opt=value` 等价、
路径值 `~` 展开、未知选项退出码 2（沿用既有 args 模块）。

#### Scenario: serve 复入

- **WHEN** `serve` 中断后以同一 `--data` 再次启动
- **THEN** 复用既有 EndpointId、名册、服务与密钥，在线使用方自动重连后凭既有密钥通过 AUTH

#### Scenario: share 前置检查

- **WHEN** 对空分组运行 `share`
- **THEN** 报错退出（分组无服务，链接无意义），不签发令牌
