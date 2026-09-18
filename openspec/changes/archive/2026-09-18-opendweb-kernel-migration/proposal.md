# opendweb 内核迁移（app-protocol-layer 对接）

## Why

ai-fly 的 provider 连通层自建了第二套连接生命周期（`src/consumer/providers.ts`
ProviderConnection：full-jitter 指数退避重连 1s→60s + linkStatus 30s 轮询 +
`peer-disconnected` 事件驱动重建），叠在 opendweb legacy envelope 传输上。
实证问题：内核自动重连与应用层重连竞速（opendweb 仓库 fabric.rs:2366-2375
`PeerDisconnected` 与 reconnect_tx 同时发出），偶发 `provider_offline` 503 后
Codex 重试又成功——瞬断直达应用、SSE 中途断线整流作废重新计费。

opendweb 已完成 app-protocol-layer（openspec change，Phase 0-3）：
连接层/会话连续性层（epoch/两代滑窗 token/journal 重放/字节级去重）+
HTTP/WS Rust 引擎 + `@jixo/opendweb-client-sdk` 五子路径（`./http` 的
fetchHttp/serveHttp + SessionHandle auto-resume——断线续传对 JS 透明）。
Owner 里程碑裁决（2026-09-16 /goal）：ai-fly 升级 opendweb 对接新内核
（本地 link），重构相关测试，多轮迭代提升内核稳定性。

## What Changes

- **依赖**：`@jixo/opendweb-client-sdk` ^0.4.3 → ^0.5.0（开发期本地 link
  对接 opendweb workspace；发布随双发布里程碑走）
- **consumer 侧**（`src/consumer/providers.ts` + gateway）：
  - ProviderConnection **删除第二套重连竞速**（attemptConnect/scheduleRetry/
    pollTimer/backoff/linkStatus 轮询/connecting 全退役）；状态机改消费
    `SessionHandle.state()/onState`（active/recovering/dead ↔ ProviderStateKind
    映射；recovering 期间不提前 503，dead 才映射 provider_offline）
  - `forward()` 改 `fetchHttp`：SSE 响应 body `bodyNext()` 逐块 → 既有
    ForwardHandlers.onChunk；EOF → onEnd。WS 升级改 keepOpen 隧道
    （sendTunnel + bodyNext 双向）
  - inflight/dataUpSeq/REQ/RESP 族多路复用记账全退役（内核逻辑流承接）
- **provider 侧**（`src/provider/serve.ts`）：
  - FabricWireAdapter + WireSession envelope 会话退役 → `Fabric.serveHttp`
    handler；AUTH 改 HTTP 端点（`/_aifly/auth`，keys 呈交复用既有校验与
    目录脱敏视图返回）；forward 端点内部走**既有**上游转发管线
    （routes/strip/append/auth/headers 阶段不动——hooks-lifecycle 变更另立）
- **wire 层**：mux.ts/codec.ts/fabric-adapter.ts 退役（删除使用点；文件
  本体清理随后续 change）；wire/frames.ts 的 ServiceEntry schema 保留
  （share-link 依赖）
- **测试重构**：providers/gateway 既有测试改 Session 驱动；新增验收
  （60s SSE 中途断线原序续传不重复 token / dead 确定错误 / WS 三态 /
  新请求 dead 前不提前 503）与故障注入（relay down 窗口、provider 重启
  REQUEST_STATE_LOST）

## 非目标

- 上游转发管线（hooks 生命周期/头改写）行为变更——hooks-lifecycle change 管
- wire-protocol 帧族的向后兼容/迁移路径（双端同仓同发；Owner 无迁移先例裁决）
- opendweb 内核行为修改（缺陷回流 opendweb 仓库修）

## Impact

- 代码：src/consumer/providers.ts（大改）、src/consumer/gateway.ts（forward/
  WS 面）、src/provider/serve.ts（大改）、src/app/engine-host.ts（装配）、
  src/wire/{mux,codec,fabric-adapter}.ts（退役）
- 规格：net-fly/consumer（转发与在线性）、net-fly/provider（AUTH 与转发）、
  net-fly/wire-protocol（帧族 REMOVED）
- 发布：依赖 ^0.5.0；ai-fly alpha 与 opendweb latest 双发布（里程碑步 5）
