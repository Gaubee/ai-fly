# Tasks: net-fly-core

> Owner 裁决 DL-1~12 已全部落进 specs/design。§2 帧子协议是两侧引擎的共同地基，
> 先行完成并锁定测试后再并行 §3/§4。SDK 相关 integration/e2e 用 node --test 独立
> 入口（vitest worker 池与原生模块不兼容，对齐 dweb 先例）。

## 1. 工程底座（单包，不拆 workspace）

- [ ] 1.1 bin/包名确认 `ai-fly`（脚手架已是）；src 分层目录（cli/wire/provider/
      consumer）建立；LICENSE 双文本（MIT OR Apache-2.0，DL-11）落盘
- [ ] 1.2 依赖补齐：`ws`（WS 中继）；dev 补 `@types/ws`；测试骨架双入口
      （vitest unit + node --test integration/e2e 串联脚本，空集通过）
- [ ] 1.3 README 重写为最终定位（唯一产品 ai-fly；HTTP/WS 桥接 + 分组密钥 +
      三入口；里程碑 M1 引擎/M2 产品化；平台支持面 darwin-arm64/win32-x64）+ commit

## 2. 帧子协议（wire/）

- [ ] 2.1 `frames.ts`：aifly1 zod strict schema（AUTH{keys[]}/AUTH_OK{alias,
      relayUrls[], groups[](含 services[].detail), rejected?,refresh?}/AUTH_ERR/
      REQ{headers?}/REQ_BODY/RESP_META/RESP_CHUNK/RESP_END/ERROR/ABORT/PING/
      DATA_UP/DATA_DOWN/CLOSE）+ 稳定错误码常量（key_invalid/key_revoked 仅入
      rejected 载荷）；未知字段 protocol_error；凭据类头（authorization/
      proxy-authorization/cookie/host/content-type）拒绝、WS 握手头（connection/
      upgrade/sec-websocket-*）放行；path 形态校验（单 / 开头、无 scheme、非
      // /\ 开头、无 `.`/`..` 段）；method 枚举边界
- [ ] 2.2 `codec.ts`：magic+type+u16BE jsonLen+json+body 编解码；整帧 ≤1MiB 断言、
      正文分片默认 256KiB、path ≤4KiB、headers ≤32 项/键 1KiB/值 8KiB、头 ≤16KiB
- [ ] 2.3 `mux.ts`：request-id 生成（不复用）、Map<id,Ctx> 解复用、未知/已终结 id
      静默丢弃、seq 缺断 → protocol_seq 终结 + 标记连接毒化（HTTP 分片与 WS DATA
      同规）、8MiB 重组上限、空闲计时（任意帧含 PING/WS DATA 重置；首字节等待期
      提供方侧挂起）、同 id 同方向顺序 await 发送 + 64 帧本地队列、
      peer-disconnected 全量终结、WS 请求的 CLOSE 终结语义
- [ ] 2.4 单测（vitest）：codec 往返/畸形/超限、schema 拒绝矩阵（凭据头/未知字段/
      path 形态/method 边界/WS 头放行）、mux 并发交错/乱序/终结后丢帧/空闲超时/
      毒化标记、非 aifly1 envelope 静默忽略、未知 type 前向兼容、帧方向矩阵

## 3. 提供方引擎（provider/）

- [ ] 3.1 `store.ts`：services.json（服务/分组/密钥哈希，0700/0600/原子写）往返；
      密钥 issue（sk-aifly- 原文一次性展示）/revoke；serviceId 随机 8B z32；
      正则保存期语法检查；defaultPort 规则（<1024 强制显式）
- [ ] 3.2 `auth.ts`：多密钥 AUTH 逐钥校验（哈希常数时间）→ AUTH_OK 分组视图
      （含 detail 脱敏：$env 头值 → `●`，变量名不显示）+ relayUrls + rejected；
      全无效 → AUTH_ERR 即断；未授权帧（含方向违规）静默计数断连（32 帧，未
      AUTH 检查先于方向检查）；撤钥 → refresh 剔除或断会话；limits 结构
      {maxConcurrency?, dailyRequests?}
- [ ] 3.3 `rewrite.ts` + `upstream.ts`：服务定位（unknown_service 统一响应）、
      URL 拼接 + 双重断言（origin 一致 + 规范化后基础路径前缀，防 //host 与 ..
      逃逸，零上游请求）、重写链（host/前缀/headerSet $env 每请求解析、空=未
      设置=省略）、headers 透传（凭据类协议层拒绝）、fetch 转发 + 流式分片下发 +
      首字节 PING(30s) + ABORT→AbortController + 超时族（连接 10s/首字节 600s/
      停滞 120s/首字节等待期提供方侧空闲计时挂起）
- [ ] 3.4 `ws-upstream.ts`：WS 握手头识别 → `ws` 客户端对上游升级（101 经
      RESP_META + sec-websocket-accept 白名单透传）→ DATA_UP/DATA_DOWN 双向原始
      字节中继（不解析 WS 帧）→ 上游 Close ↔ CLOSE 帧；握手失败按 upstream_status
- [ ] 3.5 `limits.ts`：分组级并发/日限（keyId 计数、UTC 日界、quota-day.json 原子
      持久化）、--log-usage JSONL 仅元数据
- [ ] 3.6 `link.ts`：aifly1. 组合链接生成（1 令牌 + 1 密钥 + 元数据 + 服务
      detail 脱敏视图；前置检查：分组非空/密钥有效/relay + 稳定入口部署指引提示；
      TTL CLI 校验 1s..30d）、"链接即凭证"提示
- [ ] 3.7 `serve` 命令：fabric createRoot/open 复入、启动横幅（含空 $env 变量
      WARNING）、relay 接入（resolveRelayUrls）；`service/group/key(issue|list|
      revoke)/share/revoke/status` CLI 面（bin ai-fly）
- [ ] 3.8 单测：store 往返/密钥哈希/defaultPort 规则、重写表驱动矩阵（含 $env
      空/未设置）、origin+前缀断言注入用例（//host 与 /../../admin）、限额矩阵、
      detail 脱敏断言（无变量名/值）、链接构成/脱敏

## 4. 使用方引擎（consumer/）

- [ ] 4.1 `store.ts`：按提供者隔离的 keyring.json（0600，密钥原文；fabric 身份
      目录与钥环分离）；(提供者,keyId) 合并幂等、forget 整环删除
- [ ] 4.2 `join.ts`/`import.ts`：join <dweb1令牌>（仅入网）；key add <密钥>
      --provider（未入网报错指引）；import <aifly1.链接>（新设备=兑换+入环，
      老设备=跳过兑换直接入环）、--preview 离线解析、导入摘要（别名/分组/服务/
      端口/detail）、--run 一步到位；失败不残留
- [ ] 4.3 `providers.ts`：每提供者 Fabric 实例管理、AUTH 钥环呈交与状态机、
      refresh 目录同步处理（新增映射/删除关端口+终结在途/relayUrls 更新本地
      存储）、protocol_seq 毒化→连接重建、full jitter 指数退避（1s→60s）+
      linkStatus 30s 复核、离线快速失败（provider_offline / key_all_invalid
      含别名）
- [ ] 4.4 `ports.ts` + `gateway.ts`（hono + ws）：每服务 127.0.0.1 监听、默认
      端口/冲突自动错开+显著标注/--strict-ports/--port 0、请求→帧转发（Host 不
      进帧）、SSE 逐块 flush、WS 升级本地侧（node:http upgrade 事件 + ws 库 →
      DATA_UP/DOWN 中继 + CLOSE）、upstream_status 透传、客户端断开→ABORT/CLOSE、
      接收缓冲 4MiB（WS 双向各自计）→ buffer_overflow 中止（慢客户端内存有界）
- [ ] 4.5 `run/ports/status(-v 含 detail)/forget` 命令 + 单测：端口冲突矩阵、
      离线快速失败、多提供方并存、同提供方双钥并存、恢复续用、服务删除收敛

## 5. 集成与端到端

- [ ] 5.1 integration（node --test，进程内双 Fabric + hono mock 上游含 SSE 限速
      流 + WS echo 上游）：AUTH 全矩阵（多钥/单钥/全拒/未授权断连/撤钥剔除刷新/
      relayUrls 更新）、端到端流式与非流式、**WS 端到端（升级/双向/关闭/慢客户端
      双向兜底/握手失败 404 透传）**、4xx 透传、限额、ABORT→上游断开、慢 HTTP
      客户端反例（RSS 有界 + buffer_overflow）、路径注入零上游请求、丢批→重建、
      目录推送（新增/删除/relay 变更）、多提供方并存、必需头透传
      （anthropic-version）
- [ ] 5.2 e2e（CLI 多进程 + server-binary relay，gatewayBind 注意）：
      serve→service→group→key→share→import --run→curl 流式 + WS 连接；
      密钥轮换端到端（revoke→reissue→key add→恢复）；链接二次兑换被拒；
      老设备跳过兑换；裸密钥未入网报错；签发者离线导入不残留；提供方重启→
      自动恢复；revoke 成员→离线；撤钥→余钥继续
- [ ] 5.3 `pnpm test` + typecheck 全绿 + spec Scenario 逐条覆盖自查标注

## 6. 收尾

- [ ] 6.1 remix 子代理复核意见消化与复验（内部验收通过）
- [ ] 6.2 Codex 复核（遵守 Codex 串行纪律）与迭代
- [ ] 6.3 openspec archive + commit + push
