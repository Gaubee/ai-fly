# Tasks: opendweb-kernel-migration

## 1. 文档与依赖

- [x] 1.1 package.json `@jixo/opendweb-client-sdk` → ^0.5.0；本地 link 开发
      对接说明（README 一段：`npm link @jixo/opendweb-client-sdk` 指向
      opendweb workspace）
- [x] 1.2 openspec validate --strict 过（本 change 文档齐备）

## 2. consumer 侧迁移

- [x] 2.1 ProviderConnection 状态机改 Session 驱动：删 attemptConnect/
      scheduleRetry/poll/connecting/inflight/dataUpSeq；
      （边界澄清见 design §4：dead/closed 终态后的会话重建重试保留
      scheduleRetry/retryTimer 助手——只驱动 ensureSession 重建新会话）
      SessionHandle.onState → ProviderStateKind 映射（design §1 表）；
      recovering 不提前 503、dead 新请求才 provider_offline
- [x] 2.2 forward() → fetchHttp：onMeta/onChunk/onEnd 投影（RESP_META 白名单
      三头约束保持）；SSE 断线续传经内核 auto-resume 透明
- [x] 2.3 WS 升级 → keepOpen 隧道双向泵（sendTunnel + bodyNext）
- [x] 2.4 AUTH HTTP 化：session active 后 `POST /_aifly/auth`（keys 呈交 →
      AUTH_OK 目录/端口投影走既有 onCatalog；全拒 → key-all-invalid；
      空钥环保持 connected-unauthed）
- [x] 2.5 gateway/providers 既有测试重构（Session 驱动 mock/真内核双轨），
      全绿

## 3. provider 侧迁移

- [x] 3.1 serve.ts → Fabric.serveHttp handler：`/_aifly/auth` 端点（复用
      既有校验+目录脱敏）+ forward 端点走既有上游转发管线（阶段行为不动）
- [x] 3.2 per-session 鉴权缓存（session_id → keys 状态；断线恢复不重 AUTH）
      （实现语义偏差，终评 2026-09-18 裁定登记：授权缓存实为 **peer 级**——
      ProviderPeerServer 按 peerId 长驻，同 peer 新会话在重 AUTH 前继承既有
      grants；撤钥传播在 peer 级即时闭合（refreshSession 清 grants + 断传输
      + watch 401）。session 级隔离需 SDK handler 事件暴露 sessionId（内核
      HttpRequest → 桥事件），与 cancel 事件同属 design §3.4 生命周期信号族
      ——登记 0.6.0；补「同 peer 新 session AUTH 前被 401 拒」真内核测试随行）
- [x] 3.3 退役装配：WireSession/FabricWireAdapter/bufferOverflows 记账
      （journalBytes 观测替代）；mux/codec/fabric-adapter 无引用后删除文件
      （wire/frames.ts 保留）

## 4. 验收与故障注入（design §6）

- [x] 4.1 60s SSE 中途断线原序续传 e2e：不重复 token、上游 exec==1
- [x] 4.2 dead 确定错误：恢复窗口耗尽 → 在途 504；新请求 503
      provider_offline（dead 前不提前 503 断言）
- [x] 4.3 WS 三态：active/recovering 挂起/dead 关闭
- [x] 4.4 故障注入：relay down 15s 窗口续传；provider 重启
      REQUEST_STATE_LOST → 重建会话重 AUTH
- [x] 4.5 全量测试门禁（npm test / tsc / lint 按仓库 scripts 实跑器）绿

## 5. 收尾

- [x] 5.1 手工回归清单条目（codex e2e / SSE 断线）入 README
- [ ] 5.2 Codex 复核（herdr；评分 + 阻塞项清零）后 archive
      （终评 2026-09-18：NO-GO 7.1/10——四阻塞中三闭合（依赖 ^0.5.0 registry
      实证 / 取消语义全链 / e2e fail-closed），归档阻塞为 3.2 授权缓存语义
      peer 级 vs spec session 级（见 3.2 标注）。change 保持开放至 0.6.0
      完成 session 级隔离后归档）
