# Design: net-fly-core

> 决策编号 A*（与 proposal 的 Owner 台账 D* 分离命名空间；对应关系在 proposal）。

## Context

net-fly 引擎构建在 npm `@jixo/opendweb-client-sdk`（0.3.2，napi-rs）之上。SDK 工程
边界已经两轮子代理逐行实证（2026-09-09，证据均在 dweb 仓库源码）：

```
多 Fabric 实例（同进程，不同 dataDir）   支持；SDK 测试有双实例并存先例，无全局单例
send() 语义                             每消息一条新 QUIC 双向流；无应用层队列；
                                        resolve = 写入本地 QUIC（≠对端已读）；
                                        对端 tokio 停读时 10s 超时
接收侧                                  msg_task 无条件 accept/read/emit（永不因应用
                                        层慢而停）→ 广播 channel(256) → TSFN NonBlocking
                                        无界投递 JS —— QUIC 流控窗口永远推进
事件丢批                                广播容量 256，Lagged 静默跳批、JS 无感知
单帧上限                                MAX_FRAME = 1 MiB（含 5B 帧头），超限拒绝
保序                                    同连接顺序 await 的 send 按发送序投递；
                                        并发未 await 的 send 之间无顺序承诺（流 ID 竞态）
同连接队头阻塞                          接收循环严格串行：一条大帧阻塞该 peer 全部后续 envelope
平台                                    原生二进制仅 darwin-arm64 / win32-x64（无 Linux）
e2e 手法                                example e2e：freePort + startServer({gatewayBind,
                                        relayBind})（httpBind 被静默忽略——勿用）+
                                        独立 HOME + 剥离 DWEB_*/proxy 环境 + SIGINT→SIGKILL
```

关键推论（塑造 A4/A5）：**fabric 数据面不存在可用的端到端背压信道**——对端接收
循环永不停读，发送侧永远"畅通"，压力只会堆积在接收端应用缓冲。因此背压策略必须
是"接收侧设限 + 超限中止"，而非"对端暂停"。

## Goals / Non-Goals

Goals：headless 引擎跑通"提供方配置服务/分组/密钥 → share 链接 → 使用方导入
（含多密钥钥环）→ 本地端口 ↔ 远程服务（含 SSE 流式与慢客户端兜底）"全链路；
两级撤销；多提供方并存；目录同步；vitest + node --test 全覆盖。
Non-Goals（设计级）：代理模式（M4）、UI（M2）、ai-fly 预设（M3）、出口型规则、
路径级匹配、本地鉴权、本地 TLS、PAUSE/RESUME 帧（v2）。

## Architecture

```
使用方机器                                   提供方机器
┌────────────────────────────┐    ┌────────────────────────────────┐
│ 本地客户端（Agent/浏览器）    │    │ 服务: match(域名集)→upstream    │
│   http://127.0.0.1:11434/…  │    │  +rewrite(host/前缀/$env 头)   │
└─────────┬──────────────────┘    └──────────▲─────────────────────┘
          │ HTTP(回环,明文)                  │ fetch(凭据仅 $env)
┌─────────▼──────────────────┐    ┌──────────┴─────────────────────┐
│ consumer engine            │    │ provider engine                │
│  ├ 每服务一个 127.0.0.1 监听 │    │  ├ AUTH(多密钥钥环→分组视图)     │
│  ├ 请求↔netfly1 帧          ├─QUIC┤  ├ 服务定位+origin断言+重写      │
│  │  目录同步 / jitter 重连    ├─envelope├ 限额(keyId 级)             │
│  ├ 接收缓冲 4MiB→ABORT 兜底  │    │  └ 目录推送(refresh 全量替换)   │
│  └ SSE 逐块 flush           │    │                                │
└─────────┬──────────────────┘    └──────────┬─────────────────────┘
          │      每提供者一个 Fabric 实例（身份/名册/门控/relay）
          └──────────────dweb1. 邀请 + 密钥（分享链接，钥环可多枚）────┘
```

## Decisions

### A1 规则语义 = 入站匹配型（Owner 台账 D1）

服务 = `{match(域名集 exact/suffix/regex), upstream, rewrite, defaultPort}`；
匹配集是服务身份：目录展示、M4 代理模式 CONNECT 路由、`strict-host`（后续）校验
的依据。v1 端口模式"端口即路由"宽松转发——本地端口请求全部经对应服务转发，不
校验 Host。OpenAI 兼容客户端把 base URL 指到 `127.0.0.1:port` 后 Host 头就是
127.0.0.1，强制校验反而破坏"base URL 即接入"的核心体验。出口型规则（提供方作为
任意命中域名的出口网关）授权面过大，v1 否决，模型预留（未来 `egress: true`
服务类型）。

### A2 拓扑 = 一提供方一 fabric；授权在应用层（AUTH 帧承载钥环）

fabric 管传输信任（名册成员才能建连），密钥管服务授权（AUTH_OK 才收 REQ）。
使用方多提供方并存 = 同进程多 Fabric 实例（SDK 已实证）+ 数据目录按提供者隔离。
**同一提供方多密钥** = 钥环（Owner 弹性条款）：AUTH 一次呈交全部密钥，提供方逐钥
校验、按组合并授权视图；单钥撤销 → refresh 剔除（无余钥才断会话）。备选（每分组
一 fabric）：N 组 = N 实例 N 名册，复杂化——否决。

### A3 帧协议 netfly1（HTTP 级通用）

```
envelope := "netfly1"(7B) | type(1B) | jsonLen(u16 BE) | json(UTF-8) | body(剩余)
type: 0x01 AUTH  0x02 AUTH_OK  0x03 AUTH_ERR  0x04 REQ  0x05 REQ_BODY
      0x06 RESP_META  0x07 RESP_CHUNK  0x08 RESP_END  0x09 ERROR  0x0A ABORT
      0x0B PING                                    （0x0C/0x0D 预留 PAUSE/RESUME，v2）
AUTH       {v, keys[]}                    AUTH_OK {v, alias, groups:[{keyId, group,
                                              limits{maxConcurrency?,dailyRequests?},
                                              services:[{serviceId,name,match,defaultPort}]}],
                                            rejected?:[{code}], refresh?}
REQ        {v,id,serviceId,method,path,headers?,contentType?,bodyLen}   body 内联(≤256KiB)或空
REQ_BODY   {id,seq,end}                   正文分片默认 256KiB（队头阻塞实证→远小于 1MiB）
RESP_CHUNK {id,seq}                       PING {id}（首字节等待期每 30s）
```

- 方法枚举 GET/HEAD/POST/PUT/PATCH/DELETE；越界 `forbidden_method`、非字符串
  `protocol_error`。
- `headers`：小写规范化键值对象；`authorization`/`proxy-authorization`/`cookie`/
  `host`/`content-type` 由 schema 拒绝（`forbidden_header`）——凭据类双向零过桥。
- zod strict schema：未知字段一律 `protocol_error`；`path` 必须单个 `/` 开头、
  无 scheme、非 `//`/`/\` 开头。
- 分片 256KiB 依据：接收循环串行（队头阻塞）+ JS 边界三份拷贝（Vec→base64→JSON），
  小分片更稳；可配置 ≤960KiB。

### A4 背压 = 接收侧兜底（实证修正：无端到端背压信道）

fabric 接收链（msg_task 永续读 → 广播 256 → TSFN 无界）意味着发送侧永远畅通、
压力只能堆积在接收端应用缓冲。因此：

- **发送侧** 64 帧队列上限仅防本地 send 并发堆积（同 id 顺序 await）；**不构成
  对端背压**，不得据此推导"暂停读上游就能止血"。
- **接收侧**（使用方）每请求待消费缓冲默认 4 MiB：本地客户端消费过慢 → 达限 →
  ABORT 该请求 + 本地连接错误关闭 + `buffer_overflow` 记账；进程 RSS 有界。
- 提供方侧请求重组 8 MiB 上限同理（`body_too_large`）。
- PAUSE/RESUME 帧预留（0x0C/0x0D）随 v2 设计 ACK/窗口时一并引入（届时也是 M4
  TCP 隧道的可靠层基础）。

### A5 事件丢批 = 毒化即重建

数据面（REQ/RESP/AUTH_OK）整体依赖广播事件，丢批是批次性的且无信号——任何
`protocol_seq` 检出都意味着该连接上的流已不可信：终结受影响请求 + **重建该提供者
连接**（重连成本远低于静默数据损坏）。连接状态机不依赖事件做请求级正确性，仅做
状态观测；`linkStatus()` 30s 低频轮询复核（事件丢失兜底）。

### A6 超时与活度

```
首字节等待期   提供者每 30s PING(id)（维持使用方空闲计时）；上游首字节超时 600s（可配）
流中途停滞     无分片 120s（可配）→ 提供者中止上游 → ERROR(idle_timeout)
请求空闲       双端各 300s（可配）无任何帧（含 PING）→ ERROR(idle_timeout) 清理
上游连接期     10s（可配）→ upstream_unreachable
重连退避       full jitter 指数：1s → 60s 上限
```

深度推理首字节可超 5 分钟——PING 心跳让使用方侧计时以"提供者仍在等"为准，
避免一刀切误杀。

### A7 存储（0700 目录 / 0600 文件 / 原子写 tmp+rename）

```
~/.netfly/provider/
  fabric/                       # SDK dataDir（身份+名册，SDK 自管）
  services.json                 # 服务+分组+密钥哈希（SHA-256；原文不可再现）
  quota-day.json                # {date(UTC), counts:{keyId:n}}
  usage.jsonl                   # --log-usage 时追加，仅元数据
~/.netfly/consumers/<endpointId8>/
  fabric/                       # 该提供者的 SDK dataDir
  keyring.json                  # {alias, endpointId, relayUrls,
                                #  keys:[{keyId, key, group}],   # 密钥原文（0600）
                                #  services:[…], ports:{serviceId:n}}
```

密钥：`sk-netfly-<z32(32B)>`；提供方存哈希（32B 高熵密钥，salt 无增益），比较用
常数时间；使用方钥环存原文（消费侧无校验对象）。

### A8 CLI 面（bin `netfly`）

```
netfly serve   [--data <dir>] [--relay <url>…]            # 提供方长驻
netfly service add|list|remove …                          # 服务管理
netfly group   add|list …                                  # 分组管理
netfly key     issue|list|revoke --group <name>            # 密钥管理
netfly share   --group <name> [--ttl <dur>]                # 生成分享链接
netfly revoke  <endpointId> [--data <dir>]                 # fabric 级踢出
netfly import  <link> [--data <dir>] [--run] [--preview]   # 使用方导入（并入钥环）
netfly run     [--data <dir>] [--strict-ports]             # 使用方网关长驻
netfly ports   [--data <dir>] [<serviceId> --port <n>]     # 端口查看/调整
netfly status  [--data <dir>]                              # 双角色状态
netfly forget  <endpointId|8字符前缀> [--data <dir>]       # 移除导入（整个钥环）
```

沿用既有 args 模块约定（英文 ASCII/等价形式/~ 展开/退出码 2）；命令分发 ts-pattern。

### A9 工程骨架与测试

```
ai-fly/                        # 仓库（保持现名；发布名待 Owner）
  packages/net-fly/
    src/cli/                   # 既有 args/config/errors 迁入 + commands/*
    src/wire/                  # codec.ts frames.ts mux.ts
    src/provider/              # store.ts auth.ts upstream.ts rewrite.ts limits.ts link.ts
    src/consumer/              # store.ts(keyring) ports.ts gateway.ts(hono) providers.ts
    test/unit/                 # vitest
    test/integration/          # node --test（SDK 原生模块与 vitest worker 池不兼容）
    test/e2e/                  # node --test（CLI 多进程 + server-binary relay）
  packages/app/                # M2 UI（本 change 不建目录，仅里程碑占位）
```

- HTTP 层 hono + @hono/node-server（本地端点 + mock 上游同栈）；上游转发全局
  fetch + AbortController。
- 测试要点（对齐 spec Scenario）：AUTH 全矩阵（多钥/单钥/全拒/未授权帧计数断连/
  撤钥剔除刷新）；SSE 逐块还原 + **慢客户端反例（fast mock 上游 + 不读的客户端 →
  RSS 有界 + buffer_overflow）**；路径注入（`//evil.com`、`..`）origin 断言零上游
  请求；protocol_seq → 连接重建；目录推送（新增/删除→端口关闭）；密钥轮换端到端
  （revoke→reissue→re-import→恢复）；链接二次兑换被拒；签发者离线导入不残留；
  多提供方并存；限额矩阵；`$env` 空/未设置省略 + 启动警告。

## Risks / Trade-offs

- [接收侧 4MiB 兜底以中止换内存有界] → 慢客户端请求被中止是显式语义
  （buffer_overflow），本地错误信息可指引"消费更快或调大上限"；v2 PAUSE/RESUME
  消除。已列 Non-goals。
- [事件丢批需连接重建] → A5 毒化策略；重建期间请求快速失败（provider_offline
  瞬时），Agent 自带重试。
- [同连接队头阻塞] → 256KiB 小分片 + 每提供者独立连接天然隔离；同提供者内大
  传输排队接受。
- [256KiB 分片对大上下文数十帧] → 8MiB 上限内 ~32 帧，可控；上限可配置逃生。
- [链接含密钥原文] → 产品面"链接即凭证"提示 + TTL 60min 兑换窗口；按接收方
  封装升级 v2。
- [正则规则] → v1 仅保存期静态检查（JS RegExp 不可中断，运行时防护诚实后置 M4）。
- [relay 入口固化在钥环] → 提供方换 relay 后使用方仍持旧值；v1 以重新导入兜底，
  Open Question 留自动刷新。
- [defaultPort = 上游端口在 AI 预设下连环冲突（443/80）] → 特权端口强制显式
  defaultPort + 冲突自动错开 + 显著标注。
- [无 Linux 原生包] → CI 用 macOS runner；服务器/NAS 部署场景 v1 明确不支持
  （proposal Impact 在案）。

## Migration Plan

新引擎首版，无迁移。既有仓库脚手架平移进 `packages/net-fly/`，无对外承诺破坏。
回滚 = 停用；无系统级残留。

## Open Questions

- 发布名与 scope（`net-fly` / `@jixo/net-fly` / 其它）——发布时定，不影响实现。
- LICENSE（倾向 MIT OR Apache-2.0 对齐 opendweb 生态）——首次发布前定。
- relay 入口自动刷新（提供方换 relay 后使用方如何得知）——M2 目录服务或 v2。
- strict-host 严格模式与多服务共享端口（Host 分流）——M4 代理模式同期设计。
- PAUSE/RESUME + ACK/窗口可靠层——与 M4 TCP 隧道共享设计。
