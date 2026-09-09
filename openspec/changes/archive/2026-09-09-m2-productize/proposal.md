# Proposal: m2-productize

## Why

M1 引擎（net-fly-core）已交付全链路 CLI。产品承诺是"3 步完成配置"的 GUI：opentray
托盘壳 + daemon 托管的本地 Web UI + AI 预设开箱即用（Owner DL-5/6/7/10）。
技术侦察已锁定可复用先例：skill-creator-v2 的 cli+gui(webui+opentray)+orpc+ws
五件套生产代码，与 jixoai-ui 的 shadcn 式组件消费（Tailwind v4 + Svelte 5）。

## What Changes

- **桌面壳（opentray）**：托盘常驻 + app-mode webview 主窗口加载 daemon UI；
  单进程内嵌引擎（提供方 daemon + 使用方网关同进程 import），CLI bin 保持独立。
- **UI 服务层**：daemon 起 127.0.0.1 HTTP 服务——静态托管 webui 产物 + orpc
  （zod 契约、全类型 client）+ ws 通知通道（push 通知 → 前端拉取）+ 短时 token
  门禁。架构照抄 skill-creator-v2（含 guardRpcSocket 生产坑修复）。
- **Web UI（Svelte 5 + jixoai-ui）**：ai-fly 默认视图——提供方向导（选预设 →
  命名/分组 → 分享链接）3 步；使用方向导（粘贴链接 → 端口确认 → Agent 配置）
  3 步；Dashboard 双角色状态；net-fly 细节收进"高级设置"（服务/分组/密钥/relay/
  限额的完整管理，服务 detail 展开）。
- **AI 预设库（DL-5 双源）**：仓库内精选 JSON（点名清单 ∪ pi-ai coding 生态 ∪
  ollama/LM Studio，带出处）双面模板——提供方服务模板（upstream/match/
  defaultPort/$env 头注入）+ 使用方 Agent 配置模板；models.dev api.json 运行时
  拉取缓存做长尾。
- **Agent 配置写手**：codex / claude code / cursor / cline / continue 的 base-url
  + key 写入（diff 预览 → 确认 → 原子写；env 间接优先）。

## Capabilities

### New Capabilities

- `app/shell` — 桌面壳与 UI 服务：托盘/窗口生命周期、单进程引擎嵌入、静态托管、orpc 契约面、ws 通知与 token 门禁。
- `app/ui` — 界面信息架构：3 步向导 ×2、Dashboard、高级设置收纳与 detail 展开、主题。
- `presets` — AI 预设库与 Agent 写手：双面模板数据、models.dev 长尾、写手行为。

### Modified Capabilities

（无——M1 引擎行为不变；壳只是新的宿主与消费面。）

## Impact

- 仓库转 pnpm workspace：`webui/`（Vite+Svelte5 SPA）+ 根包新增 app 入口
  （`src/app/`，opentray 宿主）；依赖 opentray、@opentray/ext-webview、
  @opentray/vite-plugin、orpc 全家桶、svelte 5、tailwind v4、jixoai-ui CLI 产物。
- jixoai-ui 组件经 `npx jixoai-ui init --hue 95`（家族琥珀）+ add 落入
  `webui/src/lib/ui/`；components.json alias 根必须 `$lib`（侦察 A5 已知坑）。
- 打包：webui 走 @opentray/vite-plugin + openTrayAppIconPlugin（单 SVG 生成全平台图标）。

## Non-goals

- Linux 桌面（ext-webview 无 Linux 运行时，侦察 B2；CLI/Linux 服务端不受影响）
- 自动更新/签名/公证分发链路（后续）
- 浏览器远程访问 UI（回环 + token 仅服务本机 webview 与极少数本机浏览器场景）
- M1 CLI 的任何行为变更

## Decisions

1. **单进程架构**：托盘宿主进程直接 import 引擎模块（startProviderDaemon/
   startEngine），CLI 与桌面共享同一数据目录与引擎实现。
2. **orpc + ws 抄 skill-creator-v2**：契约（shared）/路由（implement+错误边界）/
   client（RPCLink）/web-server（token 门禁+guardRpcSocket）/vite dev 代理五件套。
3. **webui = 纯 Vite + Svelte 5 SPA**（jixoai-ui 已验证的消费形态，demo/pty-terminal
   同款），构建产物由 daemon 静态托管，不做 SSR/SvelteKit。
4. **品牌 hue 95**（与 opendweb 家族琥珀一致）。
5. **预设数据仓库内 JSON + models.dev 运行时缓存**（可禁用；断网可用精选集）。
