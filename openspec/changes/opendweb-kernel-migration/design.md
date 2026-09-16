# 设计：opendweb 内核迁移

契约权威：opendweb `openspec/changes/app-protocol-layer/design.md`（§2.4 业务流帧
/§3.3 TS 消费面/§3.4 ABI）；本文件只定义 ai-fly 侧映射与不变量。

## 1. 状态映射（ProviderStateKind ← SessionPhase）

| ProviderStateKind | SessionPhase | 语义 |
|---|---|---|
| `not-connected` | （无 session/初建）negotiating | 建会话中 |
| `connected-unauthed` | active 且 AUTH 未过 | 会话通、鉴权未过 |
| `direct` / `relay` | active 且 AUTH 过 | 按 continuitySnapshot.path 投影 |
| `offline`（新语义 = recovering） | recovering | **瞬断不直达**：在途请求挂起等续传，新请求也进队（有界）——不提前 503 |
| `key-all-invalid` | active 且 AUTH_ERR 全拒 | 等待 key add |
| `offline`（终态 = dead/closed） | dead / closed | 在途请求确定错误（504/网络错误）；**新请求**才映射 provider_offline 503 |

不变量（design §3.3）：
- recovering 不自行 `Fabric.connect()`/退避循环——auto-resume 在 SDK 内核
  （SessionHandle 驱动，90s 恢复窗口）。
- AUTH/目录刷新/provider policy 留在 ai-fly 应用层，消费 Session 状态而非
  `peer-disconnected` 事件。

## 2. consumer 数据面

### forward（HTTP/SSE）
```
gateway → ProviderConnection.forward(input, handlers)
  → session.fetchHttp({ method, path: input.path, headers, body: [input.body] })
  → resp.status/headers → handlers.onMeta（映射既有 RESP_META 白名单三头约束）
  → 循环 bodyNext() → handlers.onChunk（SSE 逐块；commit point 在内核 journal）
  → null（EOF）→ handlers.onEnd
```
- 断线窗口：bodyNext 内核侧挂起（recovering），auto-resume 续传后原序继续——
  gateway 无感知。
- 确定错误：session dead → bodyNext 抛错 → handlers.onError（映射 504/
  网络错误语义；仅 dead 才 503 provider_offline）。

### WS 升级
```
gateway.beginUpgrade → fetchHttp({ keepOpen: true, path, headers(Upgrade) })
  → 101 → sendTunnel(客户端帧) + bodyNext(服务端帧) 双向泵
```
隧道字节不透明（RFC6455 帧端到端）；断线续传同 SSE（内核字节级）。

### AUTH（会话级，一次性）
session active 后首请求前：
```
POST /_aifly/auth { v:1, keys:[...] } → 200 { services, ports, detail } |
403 { reason:"key_all_invalid" }
```
- 复用既有 AUTH 校验/目录脱敏逻辑（provider 侧）；AUTH_OK 全量替换服务视图
  + 端口映射（既有 onCatalog 路径不变）。
- 空钥环（join-only）：不发起 AUTH，保持 connected-unauthed（既有语义）。
- AUTH 失败不重建 session（会话是内核资产）；仅标记状态。

## 3. provider 数据面

```
Fabric.serveHttp(fabric, peerId, handler)
handler(request):
  path == /_aifly/auth → 既有 AUTH 校验 + 目录脱敏视图 JSON
  其他 → 既有上游转发管线（routes/strip/append/auth/headers/onRequest 阶段、
        upstream fetch、SSE 透传）→ { status, headers, body chunks }
```
- per-peer handler 无状态化：鉴权结果缓存在 handler 侧 per-session 表
  （session_id → keys 状态），断线恢复不重 AUTH（会话级授权，内核续传）。
- 限额/背压：内核 journal 上限即发送侧反压；provider 侧既有 bufferOverflows
  记账退役（内核 journalBytes 观测替代）。

## 4. 退役清单（删除使用点）

- providers.ts：attemptConnect/scheduleRetry/poll()/retryTimer/pollTimer/
  connecting/intentionalTeardown/inflight/dataUpSeq/WireSession/rawSession
- serve.ts：WireSession/FabricWireAdapter 装配
- wire/mux.ts + wire/codec.ts + wire/fabric-adapter.ts：无引用后删除文件
  （wire/frames.ts schema 保留——share-link 依赖；wire-protocol spec 帧族
  REMOVED）

## 5. 装配（engine-host/runtime）

- consumer：per-provider `Fabric.openSession(peerId)`（幂等——active/
  recovering 返回既有；SDK 侧句柄表）；gateway 持句柄而非 WireSession。
- provider：`Fabric.serveHttp` 常驻（accept 循环在内核引擎）。
- 本地 link：开发期 `npm link @jixo/opendweb-client-sdk`（opendweb workspace
  packages/client-sdk）；package.json 语义版本 ^0.5.0。

## 6. 验收（tasks 对应）

- 60s SSE 中途断线（第 N chunk 后 provider 注入 reset/relay down 15s）：
  原序续传、零重复 token、不重发上游请求（provider 侧 exec 计数==1）
- dead 确定错误：90s 恢复窗口耗尽 → 在途 504；新请求 503 provider_offline
- WS 三态：active 收发 / recovering 挂起不断 / dead 关闭（1012 语义）
- provider 重启：RESUME → REQUEST_STATE_LOST → 会话重建 + 重 AUTH
  （新 session id；在途请求确定错误不悬挂）
