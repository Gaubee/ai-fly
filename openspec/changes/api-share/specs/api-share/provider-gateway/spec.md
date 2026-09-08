# api-share/provider-gateway Specification

## Purpose

定义提供侧网关的行为契约：以 fabric 成员身份向名册内消费者代理一个 OpenAI 兼容上游、
路径与方法的严格白名单、双向凭据隔离、限额与用量记录、模型目录广播。成员资格与撤销
语义完全复用 fabric 名册/会话层，本能力不新增门控机制。

## ADDED Requirements

### Requirement: 提供者命令面

提供者 SHALL 以长驻命令启动：`serve --data <dir> --upstream <url>`，可选项至少包含
`--alias <name>`（人可读提供者名，默认主机名）、`--models <a,b,...>`（显式模型目录）、
`--model-map <alias=model,...>`（请求侧模型名重写）、`--api-key-env <ENV>`（上游凭据的
环境变量名，绝不接受内联密钥）、`--concurrency <N>`、`--rpm <N>`、`--daily-requests <N>`、
`--log-usage`。`serve` SHALL 支持便捷项 `--invite-ttl <dur>`：启动即签发一枚邀请令牌
并打印（TTL 值域同 `invite`）。配套命令：`invite --ttl <dur>`（复用 dweb1. 邀请令牌，
默认 TTL 60 分钟，复用既有 TTL 值域与 `--allow-relayless` 逃生阀）、
`revoke <endpointId>`、`status`。
用户面字符串 SHALL 为英文且码位 < 128；选项解析 SHALL 同时接受 `--opt value` 与
`--opt=value`；路径值 SHALL 做 `~` 展开；未知选项以退出码 2 报错。`serve` 启动时 SHALL
自检：上游可达性（探测 `/v1/models`，失败降级为 WARNING 不阻断）、relay 配置有效性，
随后打印 EndpointId、fabric-id、上游 URL、模型目录与生效限额。对已存在的数据目录，
`serve` SHALL 以既有身份复入（open 语义）而非新建。

#### Scenario: 启动横幅

- **WHEN** 运行 `serve --data ~/.aifly/provider --upstream http://127.0.0.1:11434/v1`
- **THEN** 打印 EndpointId、fabric-id、上游 URL、探测所得或 `--models` 声明的模型目录与生效限额，进程持续运行

#### Scenario: 重启复入

- **WHEN** `serve` 中断后以同一 `--data` 目录再次启动
- **THEN** 复用既有 EndpointId 与名册，已加入的消费者无需重新兑换邀请

#### Scenario: 上游探测失败降级

- **WHEN** 启动时上游 `/v1/models` 探测失败（如 ollama 未启动）
- **THEN** 打印 WARNING（含上游 URL 与失败原因）后继续运行；`--models` 显式声明时以声明为准

### Requirement: 路径与方法白名单

提供者 SHALL 仅接受 GET 或 POST 到恰好 `/v1/models`、`/v1/chat/completions`、
`/v1/completions`、`/v1/embeddings`（含可选查询串）的转发请求；其它路径回送 ERROR
（`forbidden_path`），其它方法回送 ERROR（`forbidden_method`）。提供者 MUST NOT
按帧内参数对上游做任意主机/端口寻址——上游 URL 仅来自本地 serve 配置。REQ 帧
JSON 头为固定 schema；携带凭据类字段（`authorization`、`api-key`、`x-api-key`）或
schema 外字段时回送 ERROR（`forbidden_header`）并拒绝该请求。

#### Scenario: 白名单外路径拒绝

- **WHEN** 消费者帧请求 `POST /v1/files`
- **THEN** 回送 `forbidden_path` ERROR 帧，不产生任何上游请求

#### Scenario: 不可借此代理内网

- **WHEN** 恶意成员将帧内 path 构造为 `http://192.168.1.1/admin` 形式
- **THEN** 不匹配白名单的精确匹配规则，回送 `forbidden_path`，无上游请求发生

#### Scenario: 凭据类字段拒绝

- **WHEN** REQ 帧 JSON 头携带 `authorization` 字段
- **THEN** 回送 `forbidden_header` ERROR 帧，该请求不产生上游调用

### Requirement: 双向凭据隔离

提供者向上游转发时 SHALL 仅附加来自 `--api-key-env` 指定环境变量的凭据（未设置时
不带 Authorization）。上游凭据 MUST NOT 出现在任何帧、目录广播、日志或错误消息中。
消费侧凭据（本地 API key）MUST NOT 被转发至上游。

#### Scenario: 上游 key 不泄漏

- **WHEN** 消费者请求触发上游 500，提供者回送 ERROR 帧
- **THEN** ERROR 帧仅含错误码与脱敏 message，不含上游凭据或上游响应中的任何凭据字段

### Requirement: 限额与用量记录

提供者 SHALL 施加三层限额，超限时在拨号上游之前回送 ERROR：并发在途请求数
（`--concurrency`，默认 2）、每分钟请求数（`--rpm`，默认 60）、每日请求数
（`--daily-requests`，默认 10000；计数持久化于数据目录并按 UTC 日界重置）。超限分别
回送 `rate_limited` 与 `quota_exceeded`。用量记录默认关闭；开启 `--log-usage` 时
SHALL 以 JSONL 追加记录（request-id、模型名、status、出入字节数、起止时间），
MUST NOT 记录请求/响应正文。

#### Scenario: 并发限额

- **WHEN** `--concurrency 2` 生效且两个流式请求在途，第三个请求到达
- **THEN** 第三个请求立即收到 `rate_limited` ERROR，不影响前两个请求

#### Scenario: 用量记录不含正文

- **WHEN** `--log-usage` 开启并完成一次 chat 请求
- **THEN** JSONL 新行仅含元数据字段，grep 不到任何 prompt/completion 内容

### Requirement: 模型目录与重写

提供者 SHALL 在消费网关连接建立（peer-connected）时发送 CATALOG 帧（别名、协议
版本、模型列表；`--models` 显式声明优先，否则取上游 `/v1/models` 探测结果）。
`--model-map alias=model` 生效时，提供者 SHALL 对白名单路径中携带 JSON 正文的请求
解析顶层 `model` 字段并按映射重写为上游模型名后再转发；无映射命中的请求原样转发；
正文非 JSON 或无 `model` 字段时原样转发。上游 4xx（模型不存在等）按 `upstream_status`
原样回送 status 与正文。

#### Scenario: 模型名重写

- **WHEN** `--model-map gpt-4o=qwen3:32b` 生效，消费者请求 `model: "gpt-4o"`
- **THEN** 上游收到的请求体 `model` 为 `qwen3:32b`，消费侧响应保持上游原样

#### Scenario: 无映射命中原样转发

- **WHEN** 未配置 `--model-map`，消费者请求 `model: "llama3.1:8b"`
- **THEN** 上游收到的请求体与消费侧提交的字节一致

### Requirement: 撤销即断

被撤销成员的在途请求 SHALL 随会话层断连而终止，消费侧观测为连接错误；其后续连接被
既有会话门控拒绝。提供者无需（MUST NOT 依赖）应用层黑名单——撤销语义单一来源于名册。

#### Scenario: revoke 后在途请求终止

- **WHEN** 提供者 `revoke <consumer>` 且该消费者有一个流式请求在途
- **THEN** 会话断连导致该请求在消费侧以错误终结，之后的转发尝试立即失败
