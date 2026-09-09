# Design: net-fly-core

> 决策编号 A*（内部工程决策）；Owner 裁决见 proposal 的 DL-1~12（grilling 2026-09-09）。

## Context

ai-fly 引擎（内部分层标签 net-fly）构建在 npm `@jixo/opendweb-client-sdk`（0.3.2，
napi-rs）之上。SDK 工程边界已经两轮子代理逐行实证（2026-09-09，证据均在 dweb
仓库源码）：

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

Goals：headless 引擎跑通"提供方配置服务/分组/密钥 → share 链接 → 使用方三入口
导入（含多密钥钥环）→ 本地端口 ↔ 远程服务（HTTP 流式 + WebSocket 双向）"全链路；
两级撤销；多提供方并存；目录同步（含 relay 在线刷新与 detail 披露）；测试全覆盖。
Non-Goals（设计级）：代理模式（永久取消，DL-9）、UI/壳/预设（M2）、路径级匹配、
本地鉴权、本地 TLS、PAUSE/RESUME 帧（v2）。

## Architecture

```
使用方机器                                   提供方机器
┌────────────────────────────┐    ┌────────────────────────────────┐
│ 本地客户端（Agent/浏览器）    │    │ 服务: match(展示集)→upstream    │
│   http://127.0.0.1:11434/…  │    │  +rewrite(host/前缀/$env 头)   │
│   ws://127.0.0.1:11434/…    │    │  (HTTP + WS 升级)              │
└─────────┬──────────────────┘    └──────────▲─────────────────────┘
          │ HTTP/WS(回环,明文)                │ fetch(凭据仅 $env)
┌─────────▼──────────────────┐    ┌──────────┴─────────────────────┐
│ consumer engine            │    │ provider engine                │
│  ├ 每服务一个 127.0.0.1 监听 │    │  ├ AUTH(多密钥钥环→分组视图     │
│  ├ join/key add/import 三入口│   │  │  +detail 披露 +relayUrls)    │
│  ├ 请求↔aifly1 帧            ├─QUIC┤  ├ 服务定位+origin断言+重写     │
│  │  目录同步/jitter 重连      ├─envelope├ 限额(keyId 级)             │
│  ├ 接收缓冲 4MiB→ABORT 兜底  │    │  └ 目录推送(refresh 全量替换)   │
│  └ SSE 逐块 flush + WS 中继  │    │                                │
└─────────┬──────────────────┘    └──────────┬─────────────────────┘
          │      每提供者一个 Fabric 实例（身份/名册/门控/relay）
          └────dweb1. 令牌（设备）+ sk-aifly- 密钥（分组）分离流转────┘
```

## Decisions

### A1 服务模型：match 集纯展示（DL-1/DL-9）

服务 = `{match(域名展示集 exact/suffix/regex), upstream, rewrite, defaultPort}`。
代理模式取消后 match 无任何运行时路由用途——它是目录披露（DL-4 detail）与 UI
归属说明的元数据；运行时路由永远走 serviceId（密钥→分组→服务）。正则仅保存期
语法检查（无执行面，无 ReDoS 暴露）。出口型/egress 语义随代理模式一并作废。

### A2 拓扑 = 一提供方一 fabric；授权在应用层（AUTH 帧承载钥环）

fabric 管传输信任（名册成员才能建连），密钥管服务授权（AUTH_OK 才收 REQ）；
令牌=设备准入（一机一兑），密钥=分组授权（与设备解耦）——两级撤销。使用方多
提供方并存 = 同进程多 Fabric 实例（SDK 已实证）+ 数据目录按提供者隔离。同一
提供方多密钥 = 钥环：AUTH 一次呈交全部密钥，单钥撤销 → refresh 剔除（无余钥
才断会话）。

### A3 帧协议 aifly1（HTTP/WS 级通用，magic 6 字节）

```
envelope := "aifly1"(6B) | type(1B) | jsonLen(u16 BE) | json(UTF-8) | body(剩余)
type: 0x01 AUTH  0x02 AUTH_OK  0x03 AUTH_ERR  0x04 REQ  0x05 REQ_BODY
      0x06 RESP_META  0x07 RESP_CHUNK  0x08 RESP_END  0x09 ERROR  0x0A ABORT
      0x0B PING  0x0C DATA_UP  0x0D DATA_DOWN  0x0E CLOSE
      （PAUSE/RESUME v2 届时分配，不预留具体号）
AUTH       {v, keys[]}                    AUTH_OK {v, alias, relayUrls[],
                                            groups:[{keyId, group,
                                              limits{maxConcurrency?,dailyRequests?},
                                              services:[{serviceId,name,match,defaultPort,
                                                detail?{upstream,rewrite(凭据●)}}]}],
                                            rejected?:[{code}], refresh?}
REQ        {v,id,serviceId,method,path,headers?,contentType?,bodyLen}   body 内联(≤256KiB)或空
REQ_BODY   {id,seq,end}                   正文分片默认 256KiB（队头阻塞实证→远小于 1MiB）
RESP_CHUNK {id,seq}                       PING {id}（首字节等待期每 30s）
DATA_UP/DATA_DOWN {id,seq}                CLOSE {id,code?}（WS 终结帧）
```

- 方法枚举 GET/HEAD/POST/PUT/PATCH/DELETE；越界 `forbidden_method`、非字符串
  `protocol_error`。
- `headers`：小写规范化键值对象；拒绝 `authorization`/`proxy-authorization`/
  `cookie`/`host`/`content-type`（`forbidden_header`）——凭据类双向零过桥；
  允许 WS 握手头（`connection`/`upgrade`/`sec-websocket-*`）。
- zod strict schema：未知字段一律 `protocol_error`；`path` 必须单个 `/` 开头、
  无 scheme、非 `//`/`/\` 开头、无 `.`/`..` 段；提供方拼接后另做 origin + 基础
  路径前缀双重断言（纵深防御）。
- 帧方向：ERROR 帧仅提供方发出；使用方侧方向违规帧静默丢弃计数；未 AUTH 检查
  先于方向检查；`key_invalid`/`key_revoked` 仅作为 AUTH_OK.rejected 载荷码。
- 分片 256KiB 依据：接收循环串行（队头阻塞）+ JS 边界三份拷贝（Vec→base64→JSON），
  小分片更稳；可配置 ≤960KiB。

### A4 背压 = 接收侧兜底（实证修正：无端到端背压信道）

fabric 接收链（msg_task 永续读 → 广播 256 → TSFN 无界）意味着发送侧永远畅通、
压力只能堆积在接收端应用缓冲。因此：

- **发送侧** 64 帧队列上限仅防本地 send 并发堆积（同 id 同方向顺序 await）；
  **不构成对端背压**。
- **接收侧**（使用方）每请求待消费缓冲默认 4 MiB——HTTP 响应单向计、WS 双向
  各自计：本地客户端消费过慢 → 达限 → ABORT 该请求 + 本地连接错误关闭 +
  `buffer_overflow` 记账；进程 RSS 有界。
- 提供方侧请求重组 8 MiB 上限同理（`body_too_large`）。
- PAUSE/RESUME 帧随 v2 流控设计引入。

### A5 事件丢批 = 毒化即重建

数据面（REQ/RESP/AUTH_OK/DATA）整体依赖广播事件，丢批是批次性的且无信号——
任何 `protocol_seq` 检出都意味着该连接上的流已不可信：终结受影响请求 + **重建
该提供者连接**。连接状态机不依赖事件做请求级正确性，仅做状态观测；
`linkStatus()` 30s 低频轮询复核（事件丢失兜底）。

### A6 超时与活度

```
首字节等待期   提供者每 30s PING(id)（维持使用方空闲计时）；上游首字节超时 600s（可配）；
              提供方侧该请求的空闲计时在此阶段挂起（使用方不发帧，活度由 PING 节奏
              与首字节超时管辖，不会 300s 自杀）
流中途停滞     无分片 120s（可配）→ 提供者中止上游 → ERROR(idle_timeout)
请求空闲       双端各 300s（可配）无任何帧（含 PING；WS 含任一方向 DATA）→ 终结清理
               （提供方发 ERROR 帧，使用方为本地动作）
上游连接期     10s（可配）→ upstream_unreachable
重连退避       full jitter 指数：1s → 60s 上限
```

WS 连接的活度由双向 DATA 天然维持（客户端/上游的 WS ping/pong 字节即心跳）。

### A7 存储（0700 目录 / 0600 文件 / 原子写 tmp+rename）

```
~/.aifly/provider/
  fabric/                       # SDK dataDir（身份+名册，SDK 自管）
  services.json                 # 服务+分组+密钥哈希（SHA-256；原文不可再现）
  quota-day.json                # {date(UTC), counts:{keyId:n}}
  usage.jsonl                   # --log-usage 时追加，仅元数据
~/.aifly/consumers/<endpointId8>/
  fabric/                       # 该提供者的 SDK dataDir
  keyring.json                  # {alias, endpointId, relayUrls,
                                #  keys:[{keyId, key, group}],   # 密钥原文（0600）
                                #  services:[…含 detail], ports:{serviceId:n}}
~/.aifly/config.json            # 既有全局配置（relay 等，0600）
```

密钥：`sk-aifly-<z32(32B)>`；提供方存哈希（32B 高熵密钥，常数时间比较）；使用
方钥环存原文（消费侧无校验对象）。fabric 身份目录（`join` 产物）与钥环分离：
令牌与密钥是两层凭据，存储上也分层。

### A8 CLI 面（bin `ai-fly`，唯一产品名）

```
# 提供方
ai-fly serve   [--data <dir>] [--relay <url>…]            # 长驻
ai-fly service add|list|remove …                          # 服务管理
ai-fly group   add|list …                                  # 分组管理
ai-fly key     issue|list|revoke --group <name>            # 密钥管理（应用层）
ai-fly share   --group <name> [--ttl <dur>]                # 组合链接（1 令牌 + 1 密钥）
ai-fly revoke  <endpointId> [--data <dir>]                 # fabric 级踢出设备
ai-fly status  [--data <dir>] [--verbose]                  # 状态（-v 含 detail）
# 使用方
ai-fly join    <dweb1令牌> [--data <dir>]                  # 设备入网（fabric 层）
ai-fly key     add <sk-aifly-密钥> --provider <id|别名>     # 裸密钥入环（应用层）
ai-fly import  <aifly1.链接> [--data <dir>] [--run] [--preview]
ai-fly run     [--data <dir>] [--strict-ports]             # 网关长驻
ai-fly ports   [--data <dir>] [<serviceId> --port <n>]
ai-fly status  [--data <dir>] [--verbose]
ai-fly forget  <endpointId|8字符前缀> [--data <dir>]       # 移除整个导入
```

`key` 命令组按角色分流：`issue/list/revoke` 提供方、`add` 使用方。沿用既有 args
模块约定（英文 ASCII/等价形式/~ 展开/退出码 2）；命令分发 ts-pattern。

### A9 工程骨架与测试（M1 单包，不拆 workspace）

```
ai-fly/                        # 仓库 = 产品（name/bin = ai-fly）
  src/cli/                     # 既有 args/config/errors + commands/{serve,service,group,
                               #   key,share,revoke,join,import,run,ports,status,forget}.ts
  src/wire/                    # codec.ts frames.ts mux.ts（aifly1）
  src/provider/                # store.ts auth.ts upstream.ts rewrite.ts limits.ts link.ts
  src/consumer/                # store.ts(keyring) join.ts ports.ts gateway.ts(hono+ws)
                               #   providers.ts
  test/unit/                   # vitest
  test/integration/            # node --test（SDK 原生模块与 vitest worker 池不兼容）
  test/e2e/                    # node --test（CLI 多进程 + server-binary relay）
  packages/app                 # M2 UI（本 change 不建目录，里程碑占位）
```

- HTTP 层 hono + @hono/node-server（本地端点 + mock 上游同栈）；WS 本地侧用
  node:http `upgrade` 事件 + `ws` 库（hono 的 Node WS 支持待实现期验证，不通
  就 WS 路径绕过 hono 直挂 http server）；上游转发全局 fetch + AbortController
  （WS 上游用 `ws` 客户端）。
- 测试要点（对齐 spec Scenario）：AUTH 全矩阵（多钥/单钥/全拒/未授权帧计数断连/
  撤钥剔除刷新/relayUrls 更新）；SSE 逐块还原 + 慢客户端反例（RSS 有界 +
  buffer_overflow）；**WS 端到端（升级/双向消息/关闭/慢客户端双向兜底/上游握手
  失败 404）**；路径注入（`//evil.com`、`..`）origin 断言零上游请求；
  protocol_seq → 连接重建；目录推送（新增/删除→端口关闭/relay 变更）；detail
  脱敏断言（无 env 变量名/值）；密钥轮换端到端；链接二次兑换被拒 + 老设备跳过
  兑换；裸密钥 key add 全矩阵（未入网报错/入环生效）；签发者离线导入不残留；
  多提供方并存；限额矩阵；`$env` 空/未设置省略 + 启动警告。

## Risks / Trade-offs

- [接收侧 4MiB 兜底以中止换内存有界] → 慢客户端请求被中止是显式语义
  （buffer_overflow），错误信息可指引"消费更快或调大上限"；v2 PAUSE/RESUME 消除。
- [事件丢批需连接重建] → A5 毒化策略；重建期间请求快速失败（provider_offline
  瞬时），Agent 自带重试。
- [同连接队头阻塞] → 256KiB 小分片 + 每提供者独立连接天然隔离；同一提供者内
  大传输排队接受。
- [256KiB 分片对大上下文数十帧] → 8MiB 上限内 ~32 帧，可控；上限可配置逃生。
- [WS 升级对上游是 `ws` 客户端二次握手] → 与 fetch 路径并存的第二条上游通道，
  复杂度 +1；握手失败按 upstream_status 原样透传，不产生半开状态。
- [链接含密钥原文] → 产品面"链接即凭证"提示 + TTL 60min 兑换窗口；裸密钥本来
  就是同级敏感物。
- [relay 入口固化在钥环] → DL-12 三层组合：稳定入口部署指引（治本）+
  AUTH_OK relayUrls 在线刷新 + 断联一键重新导入（M2）兜底。
- [defaultPort = 上游端口在 AI 预设下连环冲突（443/80）] → 特权端口强制显式
  defaultPort + 冲突自动错开 + 显著标注。
- [无 Linux 原生包] → CI 用 macOS runner；服务器/NAS 部署场景 v1 明确不支持
  （proposal Impact 在案）。

## Migration Plan

新引擎首版，无迁移。既有仓库脚手架（args/config/errors/工具链，bin 本就是
`ai-fly`）原地复用。回滚 = 停用；无系统级残留。

## Open Questions

- 发布流程细节（trustpublish 配置）——Owner 行动项，发布前完成（DL-8）。
- hono 对 Node WS 升级的原生支持程度——实现期验证，不通则 WS 路径直挂
  node:http（A9 已备选）。
- M2 产品化 change 的 UI 信息架构（ai-fly 默认视图 + net-fly 高级设置）——
  M2 立项时设计。
