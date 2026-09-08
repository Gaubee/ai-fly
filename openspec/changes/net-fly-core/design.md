# Design: net-fly-core

## Context

net-fly 引擎构建在 npm `@jixo/opendweb-client-sdk`（0.3.2，napi-rs）之上。SDK 工程边界
已经子代理逐行实证（2026-09-09，证据均在 dweb 仓库源码）：

```
多 Fabric 实例（同进程，不同 dataDir）   支持；SDK 测试有双实例并存先例，无全局单例
send() 语义                             每消息一条新 QUIC 双向流；无应用层队列/背压；
                                        对端不读→10s 硬超时；resolve ≠ 对端已读
单帧上限                                MAX_FRAME = 1 MiB（含 5B 帧 头），超限拒绝
保序                                    同连接顺序 await 的 send 按发送序投递；
                                        并发未 await 的 send 之间无顺序承诺（流 ID 竞态）
事件                                    异步队列投递；广播容量 256，消费滞后丢批（Lagged）
同连接队头阻塞                          接收循环严格串行：一条大帧阻塞该 peer 全部后续 envelope
e2e 手法                                example e2e：freePort 抢端口 + startServer({gatewayBind,
                                        relayBind})（httpBind 被静默忽略——勿用）+ 独立 HOME +
                                        剥离 DWEB_*/proxy 环境变量 + SIGINT→SIGKILL 清理
```

这些事实直接塑造以下决策。

## Goals / Non-Goals

Goals：headless 引擎跑通"提供方配置服务/分组/密钥 → share 链接 → 使用方导入 →
本地端口 ↔ 远程服务（含 SSE 流式）"全链路；两级撤销；多提供方并存；vitest 全覆盖。
Non-Goals（设计级）：代理模式（M4）、UI（M2）、ai-fly 预设（M3）、出口型规则、
路径级匹配、本地鉴权、本地 TLS。

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
│  ├ 每服务一个 127.0.0.1 监听 │    │  ├ AUTH 校验(分组密钥,常数时间)  │
│  ├ 请求↔netfly1 帧          ├─QUIC┤  ├ 服务定位+重写+上游转发        │
│  │  AUTH / 目录刷新 / 重连   ├─envelope├ 限额(keyId 级)             │
│  └ SSE 逐块 flush           │    │  └ 目录推送(服务变更)           │
└─────────┬──────────────────┘    └──────────┬─────────────────────┘
          │      每提供者一个 Fabric 实例（身份/名册/门控/relay）
          └──────────────dweb1. 邀请 + 密钥（分享链接）──────────────┘
```

## Decisions

### D1 规则语义 = 入站匹配型（Owner 决策台账 D1，待确认）

服务 = `{match(域名集 exact/suffix/regex), upstream, rewrite, defaultPort}`；
匹配集是服务身份：目录展示、M4 代理模式 CONNECT 路由、`strict-host`（后续）校验
的依据。v1 端口模式"端口即路由"宽松转发——本地端口请求全部经对应服务转发，不校验
Host。备选（出口型：提供方作为任意命中域名的出口网关）授权面过大，v1 否决，
模型预留（match 语义不变，未来加 `egress: true` 的服务类型）。
**为什么端口模式不需要 Host 校验也成立**：OpenAI 兼容客户端把 base URL 指到
`127.0.0.1:port` 后 Host 头就是 127.0.0.1——域名字段在该模式下仅承载展示与未来
路由，强制校验反而破坏"base URL 即接 入"的核心体验。

### D2 拓扑 = 一提供方一 fabric；授权在应用层（AUTH 帧）

fabric 管传输信任（名册成员才能建连），密钥管服务授权（AUTH_OK 才收 REQ）。
使用方多提供方并存 = 同进程多 Fabric 实例（SDK 已实证）+ 数据目录按提供者隔离
（`~/.netfly/consumers/<endpointId8>/`）。两级撤销语义见 share-link spec。
备选（每分组一 fabric）：N 组 = N 个 fabric 实例、N 套名册维护，撤销与目录管理
复杂化——否决。

### D3 帧协议 netfly1（HTTP 级通用）

```
envelope := "netfly1"(7B) | type(1B) | jsonLen(u16 BE) | json(UTF-8) | body(剩余)
type: 0x01 AUTH  0x02 AUTH_OK  0x03 AUTH_ERR  0x04 REQ  0x05 REQ_BODY
      0x06 RESP_META  0x07 RESP_CHUNK  0x08 RESP_END  0x09 ERROR  0x0A ABORT
AUTH       {v,key}                          AUTH_OK {v,alias,services[],limits,refresh?}
REQ        {v,id,serviceId,method,path,contentType?,bodyLen}   body 内联(≤256KiB)或空
RESP_CHUNK {id,seq}                          正文分片默认 256KiB（队头阻塞实证→远小于 1MiB）
```

- 方法集 GET/POST/PUT/PATCH/DELETE（通用转发，不限 OpenAI 面）。
- zod strict schema：未知字段/凭据类字段一律 protocol_error（防帧内指定上游）。
- 分片 256KiB 默认值依据：接收循环串行（队头阻塞），大帧会饿死同 peer 的交互
  流量；JS 边界每消息三份拷贝（Vec→base64→JSON），小分片更稳。上限可配置 ≤960KiB。

### D4 背压与可靠性 = 应用层兜底，不依赖 fabric 流控

- 发送侧：同 id 在途分片队列上限 64；达限暂停读上游，队列回落续读。
- 同一 id 的帧顺序 await 发送（保序实证成立的前提）；不同 id 并行。
- 空闲超时 300s（可配）：请求无任何帧推进即双端清理。
- peer-disconnected / send 失败：本端全部在途 id 即刻终结（对端同样以断连收敛，
  不依赖对端配合——半开场景双端各自超时兜底）。
- 心跳：AUTH 后每 30s PING 类帧（0x0B，预留）？——v1 不做：fabric QUIC 有连接级
  保活（relay WS 15s ping 实证），请求级空闲超时已覆盖应用层判死。预留类型号。

### D5 存储（提供方数据目录）

```
~/.netfly/provider/            # netfly serve --data 缺省
  fabric/                       # SDK dataDir（身份+名册，SDK 自管）
  services.json                 # 服务+分组+密钥哈希（原子写：tmp+rename）
  quota-day.json                # {date(UTC), counts: {keyId: n}}（原子写）
  usage.jsonl                   # --log-usage 时追加，仅元数据
```

密钥：`sk-netfly-<z32(32B)>`；存储仅 SHA-256 哈希 + salt；签发时打印一次原文。
比较：哈希后常数时间比较（哈希消除长度泄漏）。

### D6 使用方存储与端口管理

```
~/.netfly/consumers/<endpointId8>/
  fabric/                       # 该提供者的 SDK dataDir
  import.json                   # {alias, endpointId, relayUrls, key, keyId, group, services[], ports: {serviceId: n}}
```

端口分配：默认服务 defaultPort；冲突报错不阻塞其它服务（逐服务隔离失败）；
`--port 0` 自动分配。重连：指数退避 1s→60s，恢复后自动 AUTH + 目录刷新。

### D7 CLI 面（bin `netfly`）

```
netfly serve   [--data <dir>] [--relay <url>…]            # 提供方长驻
netfly service add|list|remove …                          # 服务管理（add 全交互式参数）
netfly group   add|list …                                  # 分组管理
netfly key     issue|list|revoke --group <name>            # 密钥管理
netfly share   --group <name> [--ttl <dur>]                # 生成分享链接
netfly import  <link> [--data <dir>] [--run] [--preview]   # 使用方导入
netfly run     [--data <dir>]                              # 使用方网关长驻
netfly ports   [--data <dir>] [service --port <n>]         # 端口查看/调整
netfly status  [--data <dir>]                              # 双角色状态
netfly forget  <provider> [--data <dir>]                   # 移除导入
netfly revoke  <endpointId> [--data <dir>]                 # fabric 级踢出
```

沿用既有 args 模块约定（英文 ASCII/等价形式/~ 展开/退出码 2）；命令分发 ts-pattern。

### D8 工程骨架与仓库重构

```
ai-fly/                        # 仓库（保持现名；发布名待 Owner）
  packages/net-fly/            # 引擎（本次 change 全部内容）
    src/cli/                   # 既有 args/config/errors 迁入 + commands/*
    src/wire/                  # codec.ts frames.ts mux.ts（netfly1）
    src/provider/              # store.ts auth.ts upstream.ts rewrite.ts limits.ts link.ts
    src/consumer/              # store.ts ports.ts gateway.ts（hono）providers.ts
    test/                      # unit / integration / e2e
  packages/app/                # M2 UI（本 change 不建目录，仅里程碑占位于文档）
  vitest + tsdown + tsx；Node ≥20；SDK 原生模块与 vitest worker 池不兼容 →
  SDK 相关 integration 测试用 node --test 单独入口（对齐 dweb SDK 测试先例）
```

HTTP 层 hono + @hono/node-server（本地端点 + 测试 mock 上游同栈）；上游转发全局
fetch + AbortController。

### D9 测试策略

- **unit**：codec 往返/畸形/超限；schema 拒绝矩阵（未知/凭据字段）；mux 并发交错、
  乱序、终结后丢帧、空闲超时；密钥哈希/常数时间；服务存储往返；regex 危险模式拒绝；
  链接编码/预览；重写规则表驱动（host/前缀/$env 未设置省略）。
- **integration（进程内双 Fabric + hono mock 上游）**：AUTH 全矩阵（有效/无效/撤销/
  未授权先 REQ）；端到端流式与非流式；上游 4xx 透传；限额（并发/日限）；ABORT→
  上游收到断开；撤钥不断其它钥；多提供方并存（双 provider 实例 + 单 consumer）。
- **e2e（CLI 多进程 + server-binary relay）**：serve→service→group→key→share→
  import --run→curl 流式全链路；提供方重启→使用方自动恢复；revoke→离线语义。
  复用 example e2e 手法（gatewayBind 陷阱已记录）。

## Risks / Trade-offs

- [fabric 无背压 + 10s send 超时语义含糊] → D4 队列上限 + 顺序 await + 空闲超时；
  integration 测试覆盖慢消费者场景（mock 上游限速）。
- [同连接队头阻塞] → 256KiB 小分片 + 每提供者独立 fabric 连接（天然隔离不同提供者
  间流量）；同一提供者内大文件场景（非 AI 主路径）接受排队。
- [事件广播 256 容量丢批] → 引擎不依赖事件做请求级正确性（仅连接状态机）；
  状态以 linkStatus() 轮询复核（低频）。
- [256KiB 分片对大上下文请求数十帧] → 8MiB 上限内 ~32 帧，重组成本可控；分片上限
  可配置逃生。
- [regex ReDoS] → 服务加载时静态检查 + 引擎超时（spec 已定）；仅提供方本地配置面，
  攻击面限自伤。
- [链接含密钥原文] → 传输面：链接经用户自选渠道（IM 等），产品明确提示"链接即凭证"；
  技术面：链接内密钥可后续升级为按接收方封装（v2）；TTL 默认短（60min 兑换窗口）。
- [端口默认沿用上游端口易与本机同型服务冲突] → 冲突明确报错 + 一条命令改端口；
  M2 UI 上做成导入向导的一步。

## Migration Plan

新引擎首版，无迁移。既有仓库脚手架（args/config/errors/工具链）平移进
`packages/net-fly/`，无对外承诺破坏。回滚 = 停用；无系统级残留。

## Open Questions

- 发布名与 scope（`net-fly` / `@jixo/net-fly` / 其它）——发布时定，不影响实现。
- LICENSE（倾向 MIT OR Apache-2.0 对齐 opendweb 生态）——首次发布前定。
- PING 帧类型号已预留（0x0B），v1 不实现——若集成测试暴露半开误判再加。
- strict-host 严格模式与多服务共享端口（Host 分流）——M4 代理模式同期设计。
