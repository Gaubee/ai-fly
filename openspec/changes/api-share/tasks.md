# Tasks: api-share

> 依赖安装、共享文件（package.json / tsconfig / vitest 配置）由 ZCode 统一落盘；
> 帧编解码（§2）是两侧网关的共同地基，先行完成并锁定测试后再并行开发 §3/§4。
> 本仓库 SDK 依赖 darwin-arm64 / win32-x64；开发机 darwin-arm64 直接可用。

## 1. 仓库脚手架

- [x] 1.1 package.json（bin `ai-fly`、engines node≥20、type module、private）+
      .gitignore + tsconfig strict（禁 any/@ts-nocheck）+ vitest 配置 + tsdown 配置
- [x] 1.2 pnpm 安装依赖：@jixo/opendweb-client-sdk、hono、@hono/node-server、
      zod、ts-pattern；dev：vitest、tsdown、tsx、@types/node、
      @jixo/opendweb-server-binary（e2e 用）
- [x] 1.3 `src/cli/args.ts` 通用解析器（`--opt value`/`--opt=value` 等价、`~` 展开、
      布尔 flag、未知选项退出码 2、英文 ASCII 帮助）+ 单测
- [x] 1.4 `src/cli/config.ts`（~/.aifly/config.json，0600，flag > env > file > default）
      + README 骨架 + 初始 commit

## 2. 帧子协议（wire/）

- [ ] 2.1 `frames.ts`：zod strict schema（REQ/REQ_BODY/RESP_META/RESP_CHUNK/
      RESP_END/ERROR/ABORT/CATALOG）+ 错误码常量与类型；凭据类/未知字段拒绝
- [ ] 2.2 `codec.ts`：`aifly1` magic + type + u16BE jsonLen + json + body 的
      编解码；整帧 ≤1MiB 断言、正文分片 ≤512KiB、结构上限（path≤2KiB、头≤16KiB）
- [ ] 2.3 `mux.ts`：request-id 生成、Map<id,Ctx> 多路复用、seq 校验、8MiB 重组上限、
      终结后丢帧、300s 空闲超时、peer-disconnected 全量终结
- [ ] 2.4 单测：codec 往返/畸形帧/超限、schema 拒绝矩阵、mux 并发交错与乱序、
      非 aifly1 envelope 静默忽略、未知 type 前向兼容

## 3. 提供侧网关（provider/ + serve）

- [ ] 3.1 `serve` 命令骨架：Fabric createRoot/open 复入、启动自检（上游 /v1/models
      探测降级 WARNING）、启动横幅（EndpointId/fabric-id/上游/模型/限额）、
      `--invite-ttl` 启动即签发打印
- [ ] 3.2 `upstream.ts`：白名单（4 路径 × GET/POST）+ 方法/路径/凭据字段三重拒绝、
      fetch 转发（Authorization 仅来自 --api-key-env）、RESP_META/CHUNK/END 编排、
      SSE 逐块转发 + 64 帧队列背压、ABORT→AbortController
- [ ] 3.3 `rewrite.ts`：--model-map 顶层 model 字段重写（命中才改写序列化，
      未命中/非 JSON/无字段原样）
- [ ] 3.4 `quotas.ts`：并发/rpm/日请求三层（超限先于上游拨号）、quota-day.json
      原子持久化 + UTC 日界重置、--log-usage JSONL（仅元数据）
- [ ] 3.5 `catalog.ts`：peer-connected 触发 CATALOG（alias/models/--models 优先）；
      `invite`（复用 TTL 值域 + --allow-relayless）、`revoke`、`status` 命令
- [ ] 3.6 单测：白名单表驱动、限额矩阵、rewrite 三态、凭据隔离（上游收到的
      Authorization 断言）、日志无正文

## 4. 消费侧网关（consumer/ + use）

- [ ] 4.1 `use` 命令：joinWithToken 兑换 / 既有身份 open 复入（跳过兑换）、
      members 全量 connect、接入卡打印（base URL/sk-aifly-key/提供者/模型）
- [ ] 4.2 `auth.ts`：本地 key 生成（32B → sk-aifly-z32，0600 落盘）、
      timingSafeEqual 校验、401 OpenAI 风格 JSON；`key rotate`
- [ ] 4.3 `gateway.ts`（hono）：仅绑 127.0.0.1、默认 8788（占用报错/--port 0 分配）、
      白名单 404、provider_offline 503 快速失败、错误码→HTTP 映射（D8）、
      SSE 逐块 flush 还原、非流式整体返回、客户端断开→ABORT
- [ ] 4.4 `providers.ts`：CATALOG 归集（role=provider 才认）、在线状态机
      （linkStatus + peer 事件）、`status` 命令（在线/路径类型/计数）
- [ ] 4.5 单测：auth 矩阵、错误映射表驱动、离线快速失败、CATALOG 忽略非 provider

## 5. Agent 配置写手（setup/）

- [ ] 5.1 `diff.ts` 统一 diff 渲染 + 原子写（tmp+rename）+ `--yes`/交互/`--print` 三态
- [ ] 5.2 `codex.ts`（~/.codex/config.toml provider 段，env_key 间接）、
      `cursor.ts`、`cline.ts`、`continue.ts`（各家配置定位与更新而非追加）
- [ ] 5.3 单测：快照测试每写手（新建/更新/存在同名不重复）、--print 零磁盘变更

## 6. 集成与端到端

- [ ] 6.1 integration（进程内双 Fabric + hono mock 上游流式 SSE）：端到端流式/非流式、
      上游 4xx 透传、并发第三请求 429、客户端中断→上游收 ABORT、
      revoke 在途失败+新请求 503、provider shutdown→503
- [ ] 6.2 e2e（CLI 多进程 + server-binary relay）：serve 起横幅 → invite → use →
      curl 流式对话全链路； EXAMPLE 式手工回归清单写 入 README
- [ ] 6.3 `pnpm test` 全绿 + tsc 零错误 + 对 spec Scenario 逐条自查标注覆盖

## 7. 收尾

- [ ] 7.1 Codex 复核意见消化与复验（评分 ≥8 且无阻塞项）
- [ ] 7.2 openspec archive api-share + git commit + push（首个发布版式待 Owner 决策）
