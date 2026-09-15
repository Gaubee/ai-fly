# Tasks: rust-fetch-sidecar

> 顺序：文档 → 命名替换（零行为）→ 预设模式引擎面 → codex 脚本/预设 →
> rust-fetch → RPC/CLI/UI → 测试 → 构建/冒烟 → 可达性 e2e → 复核收口。

## 0. Change 文档

- [x] 0.1 proposal（三裁决）+ specs 增量（provider/ui/shell/presets）+ tasks

## 1. 命名冻结（js-backend-fetch，零行为变化）

- [x] 1.1 locale：`f.lifecycle.request.unbound` / `f.lifecycle.request.hint`（en/zh）；ServiceForm.svelte / service-form.svelte.ts 注释
- [x] 1.2 src/provider/{lifecycle,upstream}.ts 注释 + README

## 2. 预设模式（service.hooks 整段绑定）

- [x] 2.1 lifecycle.ts：`HOOKS_SLOT_SCHEMA = {script, args?}`；有效阶段解析helper（stages 矩阵逐阶段取导出；③缺导出回退 js-backend-fetch + 探测）
- [x] 2.2 store.ts：SERVICE_STORE_SCHEMA 增可选 `hooks` 槽；与 auth/headers/request/response **互斥**校验（INVALID，含 CLI/RPC 双路）；脚本未导出任何阶段函数 → 拒绝；version 维持 2
- [x] 2.3 hook.ts + rewrite.ts + upstream.ts + engine.ts：预设模式解析接线（①②③④按脚本导出分发；③ 无 onRequest 导出走原生路径含探测）；detail.ts 掩码（hooks 位 ●）
- [x] 2.4 frames.ts SERVICE_DETAIL/ENTRY 增 hooks 位（掩码语义）+ consumer/store.ts keyring 过滤放行 + 二阶段解析兼容
- [x] 2.5 rpc-contract.ts：SERVICE_SCHEMA / SERVICE_INPUT_SCHEMA 增 `hooks`（互斥由 store 层统一裁决）；presetToServiceInput / PRESET_SCHEMA 增 hooks

## 3. codex 脚本与预设

- [x] 3.1 hooks/codex.cjs 扩导出：onRequestHeaders（chatgpt-account-id / originator=codex_cli_rs / openai-beta=responses=experimental / user-agent 同款——镜像 codex.js 头集，值经 auth.json account_id）+ onRequest（委托 rust-fetch.cjs）
- [x] 3.2 presets/providers.json：codex 条目 auth → `hooks: {script: "codex"}`；预设装配与测试同步

## 4. rust-fetch 出站接管器

- [x] 4.1 sidecars/rust-fetch：Cargo 工程（reqwest blocking + rustls + http2，default-features off；.gitignore 排除 target/）；stdio 协议实现（元信息行 + 流式体 + exit 码）
- [x] 4.2 hooks/rust-fetch.cjs：onRequest（spawn；发现 AIFLY_RUST_FETCH_BIN > ~/.aifly/sidecars/rust-fetch/rust-fetch > PATH；abort SIGKILL；exit≠0/坏元信息行抛错）
- [x] 4.3 cargo build --release 成功 + 本地 http 冒烟（经引擎 ③ 真实转发流式一轮）

## 5. RPC / CLI / UI

- [x] 5.1 CLI：`--hooks <name>` 恢复（与 --secret/--headers-script/--request-script/--response-script 互斥 → 退出码 2）；service get/list humanize 呈现预设模式
- [x] 5.2 webui lifecycle.ts：双模式概念模型（custom/preset ↔ 表单互转 + 往返）；ServiceForm 模式切换（预设模式=脚本选择器 + 覆盖阶段徽章，自定义=现状四槽）；codex 预设预选预设模式；locale
- [x] 5.3 hooks.list 联动：预设模式选择器按「至少导出一个阶段函数」过滤；rust-fetch 自动入列

## 6. 测试与门禁

- [x] 6.1 预设模式矩阵：store 互斥/无阶段导出拒绝/往返；引擎四阶段分发（①②生效/③回退探测/④）；detail 掩码；consumer 过滤；contract-types；CLI 互斥与 humanize；UI 往返
- [x] 6.2 rust-fetch stub 矩阵：往返（体/头透传）/多块流式/abort 杀进程/exit≠0/坏元信息行/env 发现顺序
- [x] 6.3 全量门禁：vitest + tsc 双树 + webui build + strict validate

## 7. 可达性 e2e（Owner 指令；凭据只读、不进仓库）

- [x] 7.1 沙盒 HOME：`.codex/auth.json` 符号链接 → `~/.ai-fly/.ai-fly/.codex/auth.json`（只读直读，绝不复制）
- [x] 7.2 codex 预设模式全链路：upstream chatgpt.com + `/codex`→`/backend-api/codex` 路由，consumer gateway 本地端口 POST /responses 最小请求（max_output_tokens 压底）——①token ②账号头 ③rust-fetch；A/B 对照 js-backend-fetch（③ 未绑定）
- [x] 7.3 指纹观测：GET /rate_limits A/B 同机同分钟同凭据——js-backend-fetch 403×3（CF 全拦，历史累计 0/16 过）；rust-fetch 复核轮实测 [404,404,403]（过 CF 概率显著更高但非稳定全过；403/404/200 均如实记录）。POST /codex/responses 主链：rust-fetch 200+SSE 至 completed（两次独立运行）；A2 对照块为「关闭 hooks 的 401 无凭证对照」（非第二次 rust 成功证据）

## 8. 收口

- [x] 8.1 Codex 复核 → 迭代收敛 → README（构建/安装/绑定/双模式说明）→ archive + commit/push + 资源回收
  （复核五轮：R1 5.5 → R2 6.8 → R3 7.4 → R4 5.8（新发现 P0 宿主存活 + P1 UI 装载）→ R5 8.8 无阻塞可归档；
  全部 P0/P1 均实证闭环：exit≠0 流语义、store 门禁下沉、null meta 守卫、home 全链贯穿、serve 入口、
  预 abort 杀宿主修复、ServiceForm 挂载自载 hooks）
