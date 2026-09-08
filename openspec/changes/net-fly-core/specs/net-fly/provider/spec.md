# net-fly/provider Specification

## Purpose

定义提供方的行为契约：服务（域名匹配集+上游+重写）与分组、密钥的管理与持久化、
AUTH 校验与应用层授权、上游转发与重写、限额、目录下发、分享链接签发。成员资格
与撤销语义复用 fabric 名册/会话层；分组/密钥授权是 net-fly 应用层，二者两级并存。

## ADDED Requirements

### Requirement: 服务模型与持久化

提供方 SHALL 以本地存储（数据目录内，原子写）管理**服务**：每服务含 `name`
（人可读、分组内唯一）、`match`（域名匹配数组，元素为 `{type: exact|suffix|regex,
value}`；命中任一即属该服务）、`upstream`（上游 URL：scheme/host/port/基础路径）、
`rewrite`（可选：host 头覆盖、路径前缀剥离/追加、headerSet/headerRemove；headerSet
值支持 `$env:VAR` 环境变量间接引用）、`defaultPort`（使用方本地默认端口，缺省取
上游端口）。`match` 为空数组时服务不参与任何域名路由（仅端口直达）。服务可随时
增删改；变更在下一次 AUTH_OK 或目录推送中反映给在线使用方。regex MUST 在加载时
校验可编译且匹配步数受引擎约束（防 ReDoS：禁无限量词回溯模式，超时即拒绝该规则）。

#### Scenario: 服务定义往返

- **WHEN** 提供方添加服务 `{name:"ollama", match:[{type:"suffix",value:".local"}], upstream:"http://127.0.0.1:11434", defaultPort:11434}` 后重启进程
- **THEN** 服务从本地存储完整恢复，endpointId 与名册不变

#### Scenario: 危险正则被拒

- **WHEN** 添加含嵌套无限量词的正则规则（如 `(a+)+$`）
- **THEN** 添加被拒绝并说明原因，既有服务不受影响

### Requirement: 分组与密钥

提供方 SHALL 将服务编入**分组**（v1 一服务属一分组；分组含 `name` 与服务引用
列表），并为分组签发**访问密钥**（`keyId` + 随机密钥原文，`sk-netfly-` 前缀、
z-base-32；原文仅在签发时展示一次，存储仅保留哈希）。一分组可持多枚密钥；密钥
可单独撤销（撤销即刻生效：既有 AUTH 会话断开，后续 AUTH 拒绝）。密钥校验 MUST
常数时间比较。

#### Scenario: 一组多钥独立撤销

- **WHEN** 分组持有钥 A、B，两使用方分别在线；提供方撤销钥 A
- **THEN** 钥 A 的会话立即断开、重连被拒；钥 B 的使用方完全不受影响

#### Scenario: 密钥原文不可再现

- **WHEN** 提供方查看既有密钥列表
- **THEN** 仅显示 keyId、创建时间与状态；原文不再出现

### Requirement: AUTH 校验与目录下发

提供者 SHALL 按 wire-protocol 处理 AUTH：校验密钥 → 定位分组 → 回送 AUTH_OK
（提供者别名、该分组的服务脱敏视图：name/match/defaultPort/服务 id，不含上游 URL
与重写细节）。服务变更时 SHALL 向已 AUTH 的在线会话推送目录更新帧（AUTH_OK 同构，
增量标记 `refresh`）。使用方可见的提供者元数据 SHALL 限于：别名、EndpointId、
relay 入口、服务视图——上游地址、重写细节、其它分组的存在均不可见。

#### Scenario: 目录随服务变更推送

- **WHEN** 使用方在线期间提供方向其分组新增一服务
- **THEN** 使用方收到目录更新，新服务可见且（自动模式下）按默认端口规则尝试本地映射

### Requirement: 上游转发与重写

对通过 AUTH 的 REQ，提供者 SHALL：按 `serviceId` 定位服务（未知 id 回送
`unknown_service`）；按服务重写规则构造上游请求（路径 = 服务基础路径 + 剥离/追加
后的请求路径；headerSet 注入，`$env:VAR` 解析为环境变量值，变量未设置时该头省略；
不透传使用方侧任何凭据头——`authorization`/`proxy-authorization` 除非服务重写
显式 headerSet 覆盖）；以上游响应为源按 wire-protocol 下发。上游 URL 中的目标
主机仅来自本地服务配置，MUST NOT 受帧内任何字段影响（防 SSRF）。上游 4xx/5xx
按 `upstream_status` 原样回送 status 与正文；上游不可达/超时（连接期默认 10s）
回送 `upstream_unreachable`。

#### Scenario: 重写后命中上游

- **WHEN** 服务 upstream 为 `http://127.0.0.1:11434`、rewrite 含 headerSet
  `Authorization: $env:UPSTREAM_KEY`（环境变量已设），使用方请求 `POST /v1/chat/completions`
- **THEN** 上游收到 `http://127.0.0.1:11434/v1/chat/completions`，Authorization 为环境变量值，且请求不含使用方侧凭据头

#### Scenario: 帧内不可指定上游

- **WHEN** 恶意使用方在 REQ 帧头塞入 `host`/`upstream` 类字段
- **THEN** 字段被 schema 拒绝（protocol_error），转发目标仅由服务配置决定

#### Scenario: 上游错误原样透传

- **WHEN** 上游返回 401 与 JSON 正文
- **THEN** 使用方本地客户端收到 401 与原始正文，contentType 一致

### Requirement: 限额

提供方 SHALL 支持按分组的可选限额（缺省不限）：并发在途请求数、每日请求数
（按 keyId 分别计数，UTC 日界重置，持久化于数据目录）。超限在拨号上游之前回送
`rate_limited` / `quota_exceeded`。用量记录默认关闭；开启时仅元数据（keyId、
serviceId、status、字节数、时间戳），MUST NOT 记录正文。

#### Scenario: 并发限额

- **WHEN** 分组并发上限 2 且两个流式请求在途，第三个请求到达
- **THEN** 第三个请求立即收到 `rate_limited` ERROR，不影响前两个请求

### Requirement: 提供方命令面

提供方 CLI SHALL 提供：`netfly serve --data <dir>`（长驻：加载服务/分组/密钥、
fabric createRoot/open 复入、启动横幅打印 EndpointId/fabric-id/服务数/分组与密钥
数/relay 配置）、`netfly service <add|list|remove>`、`netfly group <add|list>`、
`netfly key <issue|list|revoke> --group <name>`、`netfly share --group <name>
[--ttl <dur>]`（生成分享链接，见 share-link spec）、`netfly status`。用户面字符串
SHALL 为英文且码位 < 128；选项解析 `--opt value`/`--opt=value` 等价、路径值 `~`
展开、未知选项退出码 2（沿用既有 args 模块）。

#### Scenario: serve 复入

- **WHEN** `serve` 中断后以同一 `--data` 再次启动
- **THEN** 复用既有 EndpointId、名册、服务与密钥，在线使用方自动重连后凭既有密钥通过 AUTH

#### Scenario: share 前置检查

- **WHEN** 对空分组运行 `share`
- **THEN** 报错退出（分组无服务，链接无意义），不签发令牌
