# Design: api-share

## Context

ai-fly 是独立产品仓库，唯一组网依赖是 npm 上的 `@jixo/opendweb-client-sdk`
（napi-rs，darwin-arm64 / win32-x64）。SDK 已提供本设计所需的全部原语
（`packages/client-sdk/index.d.ts`，2026-09-09 核对）：

```
Fabric.createRoot/open/joinWithToken   身份生命周期（provider 用 createRoot/open，
                                       consumer 用 joinWithToken/open 复入）
connect/disconnect/send                会话与不透明 envelope（单帧 ≤1MiB，离线 send 报错）
on(event)                              peer-connected/disconnected、message{from,data}、
                                       path-changed、relay-online/offline
invite/join/revoke/members/isMember    名册操作（invite root-only，dweb1. 令牌）
linkStatus(id) → direct|relay|unknown  路径类型查询
relayStatus()                          relay 快照
deriveErrorCode(msg)                   SDK 稳定错误码派生
```

约束：envelope 是消息帧语义（非字节流）；同连接保序；对端离线时 send 失败、无存储转发。

## Goals / Non-Goals

Goals：单包双角色 CLI 跑通"提供者 serve → 邀请 → 消费者 use → Agent 指 base URL →
流式对话"全链路；安全默认（回环绑定、双向凭据隔离、白名单、限额）；vitest 全覆盖。
Non-Goals（设计级）：多提供者路由、请求持久化/重放、CORS、Web UI、npm 发布形态。

## Architecture

```
消费者机器                                提供者机器
┌─────────────────────────────┐         ┌─────────────────────────────┐
│ Agent (Codex/Cursor/Cline)  │         │ ollama :11434 / vllm / 任意  │
│  base_url=127.0.0.1:8788/v1 │         │ OpenAI 兼容上游 URL          │
└──────────────┬──────────────┘         └──────────────▲──────────────┘
               │ HTTP + Bearer sk-aifly-*             │ fetch + 上游 key(env)
┌──────────────▼──────────────┐         ┌──────────────┴──────────────┐
│ consumer gateway (hono)     │         │ provider gateway            │
│  ├ auth (timing-safe)       │         │  ├ whitelist (4 路径×2 方法) │
│  ├ request mux ──REQ/ABORT──┼──QUIC──►│  ├ quotas (并发/rpm/日)      │
│  │   ◄──RESP_*/ERROR/CATALOG┼──envelope├─ model rewrite (--model-map)│
│  └ SSE 还原 (逐块 flush)     │         │  └ catalog 广播 (peer-conn) │
└──────────────┬──────────────┘         └──────────────┬──────────────┘
               │            Fabric (identity/roster/gating/relay)
               └────────共享自托管 relay / QUIC 直连────────────┘
```

## Decisions

### D1 单包双角色，bin `ai-fly`

`ai-fly serve`（提供者）/ `ai-fly use`（消费者）/ `invite` / `revoke` / `status` /
`key rotate` / `setup`。备选：两个 bin、或并入 opendweb 插件面——否决：双角色是同一
信任圈的两面，单 bin 降低分发与文档成本；插件面集成留待产品成熟后（见 Open Questions）。

### D2 HTTP 层 = hono + @hono/node-server

消费网关与测试用 mock 上游都用 hono：路由/中间件适合白名单+鉴权，`streamSSE`/
ReadableStream 原生支持逐块 flush。备选：裸 node:http——控制力相当但样板与测试成本
更高。上游转发用全局 `fetch`（undici），`AbortController` 承接 ABORT。

### D3 帧编码 = magic + type byte + JSON 头 + 原始正文

```
envelope := "aifly1" (6B ASCII) | type (1B) | jsonLen (u16 BE) | json (UTF-8) | body (剩余字节)
type: 0x01 REQ  0x02 REQ_BODY  0x03 RESP_META  0x04 RESP_CHUNK
      0x05 RESP_END  0x06 ERROR  0x07 ABORT  0x08 CATALOG
REQ         {v,id,method,path,query?,contentType?,bodyLen}   body 内联(≤512KiB)或空
REQ_BODY    {id,seq,end}                                      body 分片
RESP_META   {id,status,contentType,headers?}                  headers ⊆ {x-request-id,retry-after}
RESP_CHUNK  {id,seq}                                          body 分片
RESP_END    {id}
ERROR       {id?,code,message}
ABORT       {id}
CATALOG     {v,role:"provider",alias,models}
```

JSON 头可读可调试、zod strict schema 校验（未知字段/凭据类字段拒绝）；正文走原始字节
零转义损耗。编码器断言整帧 ≤ 1 MiB（正文分片默认 512 KiB，上限 960 KiB）。
备选：纯二进制头（省几十字节，调试成本高）/ 全 JSON+base64（膨胀 33%）——均否决。

### D4 请求生命周期与多路复用

```
consumer                          provider
  REQ ──────────────────────────►  quota/whitelist 检查
  REQ_BODY* ────────────────────►  重组(8MiB cap) ── fetch upstream ──►
  ◄─────────────────────────────  RESP_META
  ◄─────────────────────────────  RESP_CHUNK* (SSE 逐块, 队列上限 64)
  ◄─────────────────────────────  RESP_END
客户端断开: ABORT ──────────────►  abort fetch, ERROR(aborted) ──►
```

- request-id = 16B 随机 z-base-32；两侧各持 `Map<id, ReqCtx>`；终结帧后延迟 GC。
- 背压：provider 对同一 id 在途未终结分片 ≥64 时暂停读上游 reader，回落后续读。
  不做 ACK 帧（envelope/QUIC 已有流控；队列上限是保守兜底）。
- 空闲超时：请求建立后 300s 无任何帧 → 双侧按 internal 清理（SSE 长生成可达分钟级，
  默认从宽；`--idle-timeout` 可调）。
- provider 侧 send 失败或 peer-disconnected：全部在途 id 本地终结，发不出就算了
  （consumer 侧同样以断连事件终结——双方各自收敛，不依赖对端配合）。

### D5 提供者发现 = CATALOG 自声明，不解析令牌

consumer `use` 后 `members()` 全量 `connect()`（幂等）；谁是指提供者由
peer-connected 后收到的 `CATALOG(role=provider)` 自声明决定——不依赖邀请令牌里
是否可提取 issuer EndpointId（SDK 未暴露），也为未来多提供者留了缝。无任何
provider 在线声明时按 `provider_offline` 语义处理。

### D6 数据目录与配置

```
~/.aifly/
  config.json          # relay URLs 等全局配置（0600；flag > env > file > default）
  provider/            # serve 默认 --data：fabric 身份 + quota-day.json + usage.jsonl
  consumer/            # use 默认 --data：fabric 身份 + api-key.json(0600)
```

- 本地 key：32B 随机 → `sk-aifly-<z-base-32>`；`crypto.timingSafeEqual` 比较；
  `key rotate` 重生成并打印一次。
- 日限计数 `quota-day.json`：{date:"YYYY-MM-DD(UTC)", count}，原子写（tmp+rename），
  跨 UTC 日界重置。
- `--api-key-env` 只存环境变量名；上游凭据仅存在于 provider 进程内存。

### D7 SSE 还原

consumer 收 RESP_META 即向客户端写头（status + contentType，SSE 时
`text/event-stream`），RESP_CHUNK 入 ReadableStream（hono stream 回调逐块 enqueue、
逐块 flush），RESP_END 关闭；`data: [DONE]` 等字节原样透传，不解析、不重组事件。
非流式：收齐 END 后整体返回。

### D8 错误码 → HTTP 映射（consumer 侧）

```
rate_limited/quota_exceeded→429  forbidden_path→404  forbidden_method→405
forbidden_header→400             body_too_large→413  upstream_status→透传status+body
upstream_unreachable→502         provider_offline→503  protocol_*/internal→500
```

全部以 OpenAI 风格 error JSON `{error:{message,type,code}}` 返回；`upstream_status`
透传时 message 用上游正文原样。

### D9 CLI/工程骨架

- 参数解析自研（对齐 opendweb-example 约定：`--opt value`/`--opt=value` 等价、`~`
  展开、未知选项退出码 2、英文 ASCII）；命令分发用 ts-pattern。
- tsconfig strict（禁 any/@ts-nocheck）；zod v4.5+ 做 frame schema 与配置校验；
  tsdown 打包 ESM + dts，bin 入口 `#!/usr/bin/env node`；Node ≥20 engines；
  vitest（unit + integration）；dev 直跑 tsx。
- 源码结构（意图正交）：

```
src/
  cli/        args.ts config.ts commands/{serve,use,invite,revoke,status,key,setup}.ts
  wire/       codec.ts（编解码+上限断言） frames.ts（schema+类型） mux.ts（多路复用/超时/背压）
  provider/   gateway.ts（帧→fetch 编排） upstream.ts quotas.ts catalog.ts rewrite.ts
  consumer/   gateway.ts（hono 应用） auth.ts router.ts providers.ts（CATALOG 归集）
  setup/      codex.ts cursor.ts cline.ts continue.ts diff.ts
test/         unit/* integration/* e2e/cli.test.ts
```

### D10 测试策略

- **unit**：codec 往返/超限断言、zod schema 拒绝（凭据字段/未知字段）、白名单表驱动、
  model rewrite（命中/未命中/非 JSON）、timing-safe auth、错误码→HTTP 映射、
  args 解析约定、quota 日界重置。
- **integration（进程内双 Fabric + mock 上游）**：createRoot(provider) 与
  joinWithToken(consumer) 直连；mock 上游用 hono 提供 `/v1/models` 与流式
  `/v1/chat/completions`（逐 50ms 推 SSE 块）；断言端到端流式内容、非流式 JSON、
  上游 4xx 透传、并发限额第三请求 429、ABORT（客户端中断后 mock 上游收到断开）、
  revoke 后在途失败 + 新请求 503、provider shutdown → consumer 503。
- **e2e（CLI 多进程）**：`@jixo/opendweb-server-binary`（devDependency）起 relay，
  spawn `ai-fly serve` / `ai-fly use`，真实 curl 走一次流式对话；镜像
  opendweb-example 的 e2e 手法。

## Risks / Trade-offs

- [SDK send() 对离线对端报错但语义细节未文档化] → mux 对 send 异常一律按请求失败
  处理并以 linkStatus/peer 事件复核；integration 测试锁行为。
- [fabric envelope 是否自带应用层流控未知] → D4 队列上限保守兜底，不依赖。
- [超大上下文（>8MiB）请求被拒] → 明确 body_too_large 错误与 `--max-body` 逃生口。
- [SSE 经 relay（WS）长连接被中间设备掐断] → iroh relay 15s 心跳存活（README 实证）；
  consumer 观测断连即按离线语义收敛，Agent 自带重试。
- [model rewrite 仅覆盖 JSON body] → 白名单 4 路径生态内均为 JSON；非 JSON 原样转发
  （content-type 判别）。
- [setup 写手触碰各家 Agent 配置格式漂移] → 每写手独立小模块 + 快照测试；`--print`
  永远可用作手工兜底。

## Migration Plan

新仓库首版，无迁移。回滚 = 停用二进制；不残留任何系统级改动（无证书、无服务注册）。

## Open Questions

- npm 发布名与 scope（`ai-fly` vs scoped）——发布决策时定，不影响实现。
- LICENSE（倾向 MIT OR Apache-2.0 对齐 opendweb 生态）——首个发布前定。
- opendweb 插件面集成（`opendweb ai-fly ...` 自适应派发）——产品验证后再议。
