# Proposal: 生命周期双模式（预设/自定义）+ rust-fetch 出站接管器 + js-backend-fetch 命名冻结

## Why

Owner 2026-09-15 三条裁决：

1. **③ 缺省命名模糊**：「原生 fetch」不是技术标准——deno/bun 下全局 fetch 的
   实现与语义和 Node undici 不同。命名 SHALL 明确指向「当前 JS 运行时后端的
   fetch 实现」，冻结为 **js-backend-fetch**（技术词汇不进 locale）。行为零变化。
2. **整段 hook 绑定被误删，应回归**：v1 的顶层 `hooks: "<script>"` 在 v2 退役
   时一并消失了。Owner 裁决恢复为 **预设模式**——生命周期配置分两种模式：
   **自定义模式**（逐槽挑选脚本或直接配置——只配 auth 头的场景用这种）与
   **预设模式**（选中一个 hook-js，其导出的阶段函数构成一整套生命周期）。
   codex 预设即走预设模式：`codex` 脚本提供完整的 `onRequestHeaders` 与
   `onRequest`（③ 出站交给 Rust sidecar）。
3. **Rust fetch 器缺位**：本系列最初目标（2026-09-14 提议）是把出站 HTTPS 交给
   Rust 程序发起（rustls 客户端栈，不同于 JS 运行时后端），经 hooks 生命周期
   挂接。契约已在、器不在——本变更补上，并作为 codex 预设模式的 ③ 缺省执行器。

## What Changes

### A. 生命周期双模式（数据模型冻结）

- `service.hooks = { script: <name>, args?: Record<string, string> }`（**预设
  模式**，v1 字段名回归、对象化）与逐槽 `auth`/`headers`/`request`/`response`
  （**自定义模式**）**互斥**——同现一律校验拒绝（store INVALID / CLI 退出码 2 /
  UI 模式切换清空另一侧），杜绝「整段脚本 + 逐槽覆盖」的优先级歧义。
- 预设模式解析：按 stages 矩阵逐阶段取该脚本的导出——①缺导出即无 auth 注入；
  ③无 `onRequest` 导出时回退 js-backend-fetch（含连接期探测）；脚本未导出任何
  阶段函数 → 保存时校验拒绝（绑定无意义）。
- detail/目录披露：`hooks` 槽位呈现 `●`（与既有脚本注入位同掩码规则），消费侧
  keyring 过滤与 wire 契约同步放行该字段。store `version` 维持 2（可选字段，
  对既有 v2 文件向后兼容）。

### B. codex 脚本与预设（预设模式首个消费者）

- `hooks/codex.cjs` 扩为全生命周期脚本（只读语义不变）：
  `onRequestBearerAuthentication`（auth.json 裸 token，既有）；新增
  `onRequestHeaders` → `{set: {chatgpt-account-id, originator: codex_cli_rs,
  openai-beta: responses=experimental, user-agent: codex_cli_rs/<ver> …}}`（与
  codex CLI 同款头集，镜像 `codex.js`）；新增 `onRequest` → 委托 rust-fetch。
- codex 预设（`presets/providers.json`）：`auth` 字段退役，改 `hooks:
  {script: "codex"}`；向导预选预设模式。

### C. rust-fetch 出站接管器

- **sidecars/rust-fetch/**（新目录）：Rust 源码（reqwest blocking + rustls +
  http2；代理沿用 reqwest env 默认）。**stdio 协议（冻结）**：stdin = JSON
  元信息行 `{url, method, headers}` + `\n` + 原始请求体（EOF 止）；stdout =
  JSON 元信息行 `{status, headers}`（小写化、同名逗号连接）+ `\n` + 响应体
  （stdout 即流、逐块 flush、EOF = 体结束）；失败走 stderr、exit≠0。仓库不含
  构建产物——`cargo build --release` 交付（README 指引）。
- **内建脚本 hooks/rust-fetch.cjs**：导出 `onRequest`，每请求 spawn sidecar；
  二进制发现 `AIFLY_RUST_FETCH_BIN` > `~/.aifly/sidecars/rust-fetch/rust-fetch`
  > PATH；ctx.signal（引擎 ctrl.signal）触发 SIGKILL；exit≠0 / 元信息行解析
  失败 → 抛错（引擎归 `hook_failed` 固定脱敏文案）。自定义模式 ③ 选择器同样
  可单独绑定。
- **可达性验收（Owner 指令）**：真实 chatgpt.com 端到端——沙盒 HOME 以符号链
  接直读 `~/.ai-fly/.ai-fly/.codex/auth.json`（只读，绝不复制/提交），codex
  预设模式全链路（①token ②账号头 ③rust-fetch）POST `/codex/responses` 最小
  请求；A/B 对照 js-backend-fetch（含 GET /rate_limits——js-backend 历史
  0/13 全拦的指纹观测点）。

## Non-goals

- 常驻 sidecar / 连接池 / 会话复用（v1 每请求一进程；升级路径记录）。
- 二进制随 npm 发版分发（先构建交付）。
- TLS 指纹伪装（rustls 输出真实 rustls 指纹；目标是**不同于** JS 运行时后端）。
- WS 升级路径接管（沿用冻结边界）。
- 顶层键 strict / 资源上限等既有 ③ 契约不变（本变更仅新增绑定模式）。

## Impact

- 新增：`sidecars/rust-fetch/`、`hooks/rust-fetch.cjs`、预设模式与 rust-fetch
  测试族。
- 修改：`src/provider/{lifecycle,store,hook,rewrite,upstream,detail,engine}.ts`、
  `src/wire/frames.ts`、`src/consumer/store.ts`、`src/shared/rpc-contract.ts`、
  `src/app/rpc-router.ts`、`src/cli/commands/provider/service.ts`（--hooks 恢复）、
  `hooks/codex.cjs`、`presets/providers.json`、webui（lifecycle 模型 / ServiceForm
  模式切换 / locale）、README、living specs ×4 能力。
- 零行为项：js-backend-fetch 纯命名替换（locale/注释/spec）。
