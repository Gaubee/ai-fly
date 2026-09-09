# Design: m2-productize

## Context（侦察实证 2026-09-09）

- **skill-creator-v2**（/Users/kzf/Dev/GitHub/jixoai-labs/skill-creator-v2）= 完整先例：
  `src/shared/rpc-contract.ts`（zod+oc 契约）/ `src/daemon/rpc-router.ts`（implement+
  DomainError→ORPCError 边界）/ `src/daemon/web-server.ts`（127.0.0.1 + 双 WSS noServer
  + token 门禁 + guardRpcSocket 畸形帧隔离[1.14.6 生产坑已修]）/ `webui/src/lib/rpc-client.ts`
  （URL hash token→sessionStorage→RPCLink）/ `webui/config/daemon-dev.ts`（vite 代理
  /api+/ws → daemon）。
- **jixoai-ui**：shadcn 式 CLI 拷贝（`npx jixoai-ui init --hue 95` + add），Tailwind v4 +
  Svelte 5，items 落 `src/lib/ui/<name>/`，组件零 npm 运行时依赖；**alias 根必须 `$lib`**
  （components.json aliases.lib=$lib，否则 .ts 文件被破坏性重写）；shadcn 钉 4.19.0。
- **opentray**：createTray + @opentray/ext-webview；webview 一等支持 `url`（http://
  127.0.0.1:port 直连 daemon）；app-mode 主窗口（close 隐藏不杀）；打包三段契约
  （@opentray/vite-plugin + openTrayAppIconPlugin 单 SVG 生成全平台图标）；
  **无 Linux 运行时**。

## Decisions

### A1 仓库结构（workspace）

```
ai-fly/
  package.json            # 根：workspace 协调 + 引擎（src/ 不动）+ app 装配脚本
  webui/                  # Vite + Svelte 5 SPA（jixoai-ui 消费项目）
    src/lib/ui/           # jixoai-ui add 落点（alias 根 $lib）
    src/lib/rpc-client.ts # 抄 skill-creator-v2
  src/shared/             # orpc 契约（前后端共享；引擎车道零侵入）
  src/app/                # opentray 宿主 + UI daemon（装配 M1 引擎模块）
  presets/                # providers.json（精选，带出处）+ models-dev.ts
```

### A2 单进程壳

`src/app/main.ts`：createTray（菜单：主窗口/提供方开关/使用方开关/退出）→ 启动 UI
daemon（先起服务再开窗，避免白屏）→ 按数据目录现状装配引擎（提供方 daemon=
startProviderDaemon；使用方=consumer startEngine；两者可并存）。引擎 lifecycle 完全
复用 M1 模块；托盘开关只控制启动/停用，不改数据。

### A3 UI 服务（五件套照抄 + 差异）

与 skill-creator-v2 差异：无 `/api/*` REST（orpc over ws 全承担）；静态托管改为
`webui/dist`（SPA 回退到 index.html）；token：宿主进程直接把一次性 token 注入 webview
URL（无 CLI 打印环节）；notify 通道复用同 guard 模式。

### A4 webui 技术栈

Vite 8 + Svelte 5 + Tailwind v4（@tailwindcss/vite）+ jixoai-ui（hue 95）；路由用
简单自制 hash 路由（三视图 + 向导分步，无需 router 库）；状态：$state runes + 通知
驱动的拉取。jixoai-ui add 清单：press-button、card、dialog、input、select、tabs、
toggle、badge、alert、toast、tooltip、skeleton、separator、theme-toggle、jixoai-theme
（含 utils 闭包）。

### A5 预设与写手

`presets/providers.json`（约 18 条精选，字段见 presets spec，`source` 字段记出处）；
`presets/models-dev.ts`（api.json 拉取/缓存 TTL 7 天/可禁用）；写手
`src/app/writers/{codex,claude-code,cursor,cline,continue}.ts`（preview→diff、
apply→原子写；TOML 用已有能力或轻量手写序列化，避免重依赖）。

### A6 打包

webui：vite build（产物 webui/dist）；宿主：tsdown bundle `src/app/main.ts` →
`dist/app/`；图标：openTrayAppIconPlugin({sourcePath: resources/icon.svg})；
manifest：@opentray/packaging 三段契约。发布形态后置（DL-8）。

## Risks / Trade-offs

- [alias 重写坑] → components.json aliases.lib=$lib；安装后 grep `src/lib` 自检。
- [shadcn 版本漂移] → 锁 4.19.0（jixoai-ui CLI 已处理 lock；CI 校验）。
- [tray 不可自动化测试] → 壳层薄化：可测逻辑全在 UI daemon/契约层；托盘仅手工回归
  （清单入 README dev 段）。
- [单进程资源] → 引擎与 UI 同进程：node 原生模块 + webview 宿主同生命周期；内存
  观察列入手工回归。
- [notify 丢消息] → 通知仅为触发器，重连全量对账（spec 已定）。

## Migration Plan

新增层不触 M1 行为；CLI 与桌面并存共享数据目录。回滚 = 不启动 app 入口。

## Open Questions

- 桌面分发（dmg/installer）与自动更新——发布阶段另立 change（DL-8 trustpublish 后）。
