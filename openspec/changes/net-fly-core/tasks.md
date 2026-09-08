# Tasks: net-fly-core

> 共享文件（workspace 配置/package.json/tsconfig）由 ZCode 统一落盘；§2 帧子协议是
> 两侧引擎的共同地基，先行完成并锁定测试后再并行 §3/§4。SDK 相关 integration/e2e
> 用 node --test 独立入口（vitest worker 池与原生模块不兼容，对齐 dweb 先例）。

## 1. 仓库重构为 workspace

- [ ] 1.1 pnpm-workspace.yaml（packages/*）；`packages/net-fly` 建包（bin `netfly`、
      engines node≥20、private）并平移既有脚手架（src/cli 的 args/config/errors、
      工具链配置、测试）；根目录保留 openspec/README
- [ ] 1.2 依赖归位（运行时 @jixo/opendweb-client-sdk、hono、@hono/node-server、
      zod、ts-pattern；dev vitest、tsdown、tsx、typescript、@types/node、
      @jixo/opendweb-server-binary）；交付测试骨架：vitest（unit）+ node --test
      （integration/e2e）双入口串联脚本（空集通过）
- [ ] 1.3 README 重写为 net-fly 双层产品定位（net-fly 基座 + ai-fly 预设层 +
      里程碑地图 M1-M4；平台支持面 darwin-arm64/win32-x64 说明）+ commit

## 2. 帧子协议（wire/）

- [ ] 2.1 `frames.ts`：netfly1 zod strict schema（AUTH{keys[]}/AUTH_OK{groups[],
      rejected?,refresh?}/AUTH_ERR/REQ{headers?}/REQ_BODY/RESP_META/RESP_CHUNK/
      RESP_END/ERROR/ABORT/PING）+ 稳定错误码常量；未知字段 protocol_error；
      凭据类头（authorization/proxy-authorization/cookie/host/content-type）拒绝；
      path 形态校验（单 / 开头、无 scheme、非 // /\ 开头）；method 枚举
      （forbidden_method 与 protocol_error 的边界）
- [ ] 2.2 `codec.ts`：magic+type+u16BE jsonLen+json+body 编解码；整帧 ≤1MiB 断言、
      正文分片默认 256KiB、path ≤4KiB、headers ≤32 项/键 1KiB/值 8KiB、头 ≤16KiB
- [ ] 2.3 `mux.ts`：request-id 生成（不复用）、Map<id,Ctx> 解复用、未知/已终结 id
      静默丢弃、seq 缺断 → protocol_seq 终结 + 标记连接毒化、8MiB 重组上限、
      空闲计时（任意帧含 PING 重置）、同 id 顺序 await 发送 + 64 帧本地队列、
      peer-disconnected 全量终结
- [ ] 2.4 单测（vitest）：codec 往返/畸形/超限、schema 拒绝矩阵（凭据头/未知字段/
      path 形态/method 边界）、mux 并发交错/乱序/终结后丢帧/空闲超时/毒化标记、
      非 netfly1 envelope 静默忽略、未知 type 前向兼容、帧方向矩阵

## 3. 提供方引擎（provider/）

- [ ] 3.1 `store.ts`：services.json（服务/分组/密钥哈希，0700/0600/原子写）往返；
      密钥 issue（原文一次性展示）/revoke；serviceId 随机 8B z32；regex 保存期
      静态危险检查；defaultPort 规则（<1024 强制显式）
- [ ] 3.2 `auth.ts`：多密钥 AUTH 逐钥校验（哈希常数时间）→ AUTH_OK 分组视图 +
      rejected；未授权帧计数断连（32 帧 / 3 次 AUTH 失败）；撤钥 → refresh 剔除或
      断会话；limits 结构 {maxConcurrency?, dailyRequests?}
- [ ] 3.3 `rewrite.ts` + `upstream.ts`：服务定位（unknown_service 统一响应）、
      URL 拼接 + origin 断言（防 //host 与 .. 逃逸，零上游请求）、重写链（host/
      前缀/headerSet $env 每请求解析、空=未设置=省略）、headers 透传（凭据类已
      协议层拒绝）、fetch 转发 + 流式分片下发 + 首字节 PING(30s) + ABORT→
      AbortController + 超时族（连接 10s/首字节 600s/停滞 120s）
- [ ] 3.4 `limits.ts`：分组级并发/日限（keyId 计数、UTC 日界、quota-day.json 原子
      持久化）、--log-usage JSONL 仅元数据
- [ ] 3.5 `link.ts`：netfly1. 链接生成（前置检查：分组非空/密钥有效/relay；
      TTL CLI 校验 1s..30d）、payload 脱敏断言（无 upstream/rewrite/env 引用）、
      "链接即凭证"提示
- [ ] 3.6 `serve` 命令：fabric createRoot/open 复入、启动横幅（含空 $env 变量
      WARNING）、relay 接入（resolveRelayUrls）；`service/group/key/share/revoke/
      status` CLI 面
- [ ] 3.7 单测：store 往返/密钥哈希/危险 regex/defaultPort 规则、重写表驱动矩阵
      （含 $env 空/未设置）、origin 断言注入用例、限额矩阵、链接构成/脱敏

## 4. 使用方引擎（consumer/）

- [ ] 4.1 `store.ts`：按提供者隔离的 keyring.json（0600，密钥原文）；(提供者,
      keyId) 合并幂等、forget 整环删除
- [ ] 4.2 `import.ts`：链接解析/--preview（离线可解析）、joinWithToken 兑换、
      钥环合并、导入摘要（别名/分组/服务/端口）、--run 一步到位；失败不残留
- [ ] 4.3 `providers.ts`：每提供者 Fabric 实例管理、AUTH 钥环呈交与状态机、
      refresh 目录同步处理（新增映射/删除关端口+终结在途）、protocol_seq 毒化→
      连接重建、full jitter 指数退避（1s→60s）+ linkStatus 30s 复核、离线快速
      失败（provider_offline / key_all_invalid 含别名）
- [ ] 4.4 `ports.ts` + `gateway.ts`（hono）：每服务 127.0.0.1 监听、默认端口/
      冲突自动错开+显著标注/--strict-ports/--port 0、请求→帧转发（Host 不进帧）、
      SSE 逐块 flush、upstream_status 透传、客户端断开→ABORT、接收缓冲 4MiB →
      buffer_overflow 中止（慢客户端内存有界）
- [ ] 4.5 `run/ports/status/forget` 命令 + 单测：端口冲突矩阵、离线快速失败、
      多提供方并存、同提供方双钥并存、恢复续用、服务删除收敛

## 5. 集成与端到端

- [ ] 5.1 integration（node --test，进程内双 Fabric + hono mock 上游）：
      AUTH 全矩阵（多钥/单钥/全拒/未授权断连/撤钥剔除刷新）、端到端流式与非流式、
      4xx 透传、限额、ABORT→上游断开、**慢客户端反例（RSS 有界 + buffer_overflow）**、
      路径注入零上游请求、丢批→重建、目录推送（新增/删除）、多提供方并存、
      必需头透传（anthropic-version）
- [ ] 5.2 e2e（CLI 多进程 + server-binary relay，gatewayBind 注意）：
      serve→service→group→key→share→import --run→curl 流式；密钥轮换端到端
      （revoke→reissue→re-import→恢复）；链接二次兑换被拒；签发者离线导入不残留；
      提供方重启→自动恢复；revoke 成员→离线；撤钥→余钥继续
- [ ] 5.3 `pnpm -r test` + typecheck 全绿 + spec Scenario 逐条覆盖自查标注

## 6. 收尾

- [ ] 6.1 remix 子代理复核意见消化与复验（内部验收通过）
- [ ] 6.2 Codex 复核（Owner 确认后启动）与迭代
- [ ] 6.3 openspec archive + commit + push
