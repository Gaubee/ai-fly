# Tasks: net-fly-core

> 共享文件（workspace 配置/package.json/tsconfig）由 ZCode 统一落盘；§2 帧子协议是
> 两侧引擎的共同地基，先行完成并锁定测试后再并行 §3/§4。SDK 相关 integration 测试
> 用 node --test 独立入口（vitest worker 池与原生模块不兼容，对齐 dweb 先例）。

## 1. 仓库重构为 workspace

- [ ] 1.1 pnpm-workspace.yaml（packages/*）；`packages/net-fly` 建包（bin `netfly`、
      engines node≥20、private）并平移既有脚手架（src/cli 的 args/config/errors、
      工具链配置、测试）；根目录保留 openspec/README
- [ ] 1.2 依赖归位：运行时 @jixo/opendweb-client-sdk、hono、@hono/node-server、
      zod、ts-pattern；dev vitest、tsdown、tsx、typescript、@types/node、
      @jixo/opendweb-server-binary（e2e）；`pnpm -r test/typecheck/build` 全绿
- [ ] 1.3 README 重写为 net-fly 双层产品定位（net-fly 基座 + ai-fly 预设层 +
      里程碑地图 M1-M4）+ commit

## 2. 帧子协议（wire/）

- [ ] 2.1 `frames.ts`：netfly1 zod strict schema（AUTH/AUTH_OK/AUTH_ERR/REQ/
      REQ_BODY/RESP_META/RESP_CHUNK/RESP_END/ERROR/ABORT）+ 稳定错误码常量；
      未知字段与凭据类字段（authorization/proxy-authorization/host）拒绝
- [ ] 2.2 `codec.ts`：magic+type+u16BE jsonLen+json+body 编解码；整帧 ≤1MiB 断言、
      正文分片默认 256KiB、path ≤4KiB、JSON 头 ≤16KiB
- [ ] 2.3 `mux.ts`：request-id 生成、Map<id,Ctx> 解复用、seq 校验、8MiB 重组上限、
      终结后丢帧、300s 空闲超时、同 id 顺序 await 发送、64 帧在途队列上限、
      peer-disconnected 全量终结
- [ ] 2.4 单测：codec 往返/畸形/超限、schema 拒绝矩阵、mux 并发交错/乱序/终结后
      丢帧/空闲超时、非 netfly1 envelope 静默忽略、未知 type 前向兼容

## 3. 提供方引擎（provider/）

- [ ] 3.1 `store.ts`：services.json（服务/分组/密钥哈希+salt）原子读写往返；
      密钥 issue（sk-netfly- 原文一次性展示）/revoke；regex 危险模式静态检查+拒绝
- [ ] 3.2 `auth.ts`：AUTH 校验（哈希常数时间）、AUTH_OK/ERR、目录推送（refresh）、
      撤钥断会话、未授权 REQ → unauthorized
- [ ] 3.3 `rewrite.ts` + `upstream.ts`：服务定位（unknown_service）、重写链
      （host/前缀剥离追加/headerSet $env 解析、未设置省略、使用方凭据头剥离）、
      fetch 转发 + 流式分片下发 + ABORT→AbortController + 连接期 10s 超时
- [ ] 3.4 `limits.ts`：分组可选并发/日限（keyId 级计数、UTC 日界、quota-day.json
      原子持久化）、--log-usage JSONL 仅元数据
- [ ] 3.5 `link.ts`：netfly1. 链接生成（前置检查：分组非空/密钥有效/relay）、
      payload 脱敏断言（无 upstream/rewrite/env 引用）
- [ ] 3.6 `serve` 命令：fabric createRoot/open 复入、启动横幅、relay 配置接入
      （复用 resolveRelayUrls）；`service/group/key/share/revoke/status` CLI 面
- [ ] 3.7 单测：store 往返/密钥哈希/危险 regex、重写表驱动矩阵、限额矩阵、
      链接构成/脱敏

## 4. 使用方引擎（consumer/）

- [ ] 4.1 `store.ts`：按提供者隔离的 import.json（凭证/服务视图/端口表）；
      重复导入幂等更新、forget 清除
- [ ] 4.2 `import.ts`：链接解析/preview（离线可解析）、joinWithToken 兑换、
      导入摘要输出、--run 一步到位
- [ ] 4.3 `ports.ts` + `gateway.ts`（hono）：每服务 127.0.0.1 监听、默认端口沿用/
      冲突隔离报错/--port 0 自动分配、请求→帧转发、SSE 逐块 flush、
      upstream_status 透传、客户端断开→ABORT
- [ ] 4.4 `providers.ts`：每提供者 Fabric 实例管理、AUTH 状态机、指数退避重连
      （1s→60s）、恢复自动重 AUTH+目录刷新、离线 503（provider_offline/key_revoked
      含别名）
- [ ] 4.5 `run/ports/status/forget` 命令 + 单测：端口冲突矩阵、离线快速失败、
      多提供方并存（双 provider + 单 consumer 集成）、恢复续用

## 5. 集成与端到端

- [ ] 5.1 integration（node --test，进程内双 Fabric + hono mock 上游含 SSE 限速流）：
      AUTH 全矩阵、端到端流式/非流式、4xx 透传、限额、ABORT→上游断开、撤钥隔离、
      多提供方并存
- [ ] 5.2 e2e（CLI 多进程 + server-binary relay，gatewayBind 注意点已记录）：
      serve→service→group→key→share→import --run→curl 流式；提供方重启→自动恢复；
      revoke→离线；撤钥→key_revoked 可见
- [ ] 5.3 `pnpm -r test` + typecheck 全绿 + spec Scenario 逐条覆盖自查标注

## 6. 收尾

- [ ] 6.1 remix 子代理复核意见消化与复验（内部验收通过）
- [ ] 6.2 Codex 复核（Owner 确认后启动）与迭代
- [ ] 6.3 openspec archive + commit + push
