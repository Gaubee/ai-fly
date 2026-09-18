# Tasks: opendweb-kernel-migration

## 1. 文档与依赖

- [x] 1.1 package.json `@jixo/opendweb-client-sdk` → ^0.5.0；本地 link 开发
      对接说明（README 一段：`npm link @jixo/opendweb-client-sdk` 指向
      opendweb workspace）
- [x] 1.2 openspec validate --strict 过（本 change 文档齐备）

## 2. consumer 侧迁移

- [x] 2.1 ProviderConnection 状态机改 Session 驱动：删除**连接级** retry
      （attemptConnect/poll/connecting/inflight/dataUpSeq），保留**终态
      session 重建** retry（scheduleRetry/retryTimer——只驱动 ensureSession
      在 dead/closed 终态后重建新会话，见 design §4）；
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
      （0.6.0 收口：SDK 0.6.0 handler 事件已带 sessionId——ProviderPeerServer
      改 sessionAuths Map（LRU cap 32），同 peer 异 session 不继承授权；e2e T7
      真内核断言「新 session AUTH 前 forward/watch 401、自行 AUTH 后独立
      生效」。此前偏差登记留档：peer 级实现时期，撤钥传播 peer 级闭合。）
- [x] 3.2b cancel 信号接入（SDK 0.6.0 对偶面）：forward 挂 req.signal →
      ctrl（reply:true 经 sink error 收口）；消费端 abortKey/abortFetch
      head 等待期即时 RESET——e2e T8 真内核断言「gated 上游秒停」
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
- [x] 5.2 Codex 复核（herdr；评分 + 阻塞项清零）后 archive
      （终评 2026-09-18：NO-GO 7.1/10——四阻塞中三闭合（依赖 ^0.5.0 registry
      实证 / 取消语义全链 / e2e fail-closed），归档阻塞为 3.2 授权缓存语义
      peer 级 vs spec session 级（见 3.2 标注）。change 保持开放至 0.6.0
      完成 session 级隔离后归档。
      收口 2026-09-18：opendweb 0.6.0（sessionId/signal/writer 三态/close 语义）
      发布后，ai-fly 落地 session 级授权隔离（sessionAuths LRU + invalidateWatch
      唤醒）与取消信号全链（abortKey/abortFetch + 预中止零上游触达含 TCP 计数）；
      复核轨迹 7.1 → 7.8（预中止竞态 + watch 失效收敛 P2）→ 8.1（probe 边界 +
      watch 测试路径 + 归档前置）→ 全部修复并实跑验证（vitest 646/646、
      integration 11/11、e2e 门禁 10/10、tsc、openspec strict 7/7）；
      SPEC-COVERAGE.md 对照归档合并后正式 specs 全量重写，归档执行。终评微复核
      （8.3/10）指出两处正式 spec 与实现的合同漂移后，完成 spec-sync：wire-protocol
      重写为内核承载口径（帧族条款 superseded，14 Scenario），provider 密钥原文
      条款按 Owner 2026-09-13 裁决同步（本地可取回 + 远程面禁原文）；coverage
      同步重写（85 Scenario：覆盖 76、部分 8、未覆盖 2））
