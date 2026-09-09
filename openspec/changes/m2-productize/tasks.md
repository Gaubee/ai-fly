# Tasks: m2-productize

> 车道：A=后端（workspace/契约/服务/预设/写手）先行；B=webui 前端、C=opentray 壳
> 在 A 交付契约后并行。共享文件（根 package.json / pnpm-workspace / components.json）
> 由编排者统一落盘。

## 1. A：workspace 与共享契约

- [x] 1.1 pnpm-workspace（根 + webui）；根 scripts 增 app 构建链；webui 脚手架
      （Vite+Svelte5+TW4，参照 jixoai-labs/ui demo/pty-terminal）+ `jixoai-ui init
      --hue 95` + components.json（alias 根 $lib）+ add 组件清单（design A4）
- [x] 1.2 `src/shared/rpc-contract.ts`：zod+oc 契约全量（提供方/使用方/预设/写手/
      系统，spec shell「RPC 契约面」为清单）+ DomainError 约定
- [x] 1.3 `src/app/rpc-router.ts`：implement 契约，全部转发 M1 引擎模块（不复制
      逻辑）+ 统一错误边界
- [x] 1.4 `src/app/web-server.ts`：五件套（静态+SPA 回退 / orpc ws / notify ws /
      token 门禁 / guardRpcSocket）+ `src/app/engine-host.ts`（单进程引擎装配与
      开关）+ 单测（token 消费/畸形帧隔离/静态回退/契约类型编译）

## 2. A：预设与写手

- [x] 2.1 `presets/providers.json`（精选抄录带出处，presets spec 清单）+
      `presets/models-dev.ts`（拉取/缓存 TTL 7d/可禁用/断网回退）+ 单测
- [x] 2.2 `src/app/writers/`（codex/claude-code/cursor/cline/continue：preview→
      统一 diff、apply→原子写保其余字段）+ 快照单测（新建/更新/不破坏既有）

## 3. B：webui（契约就绪后）

- [x] 3.1 rpc-client（token→RPCLink）+ hash 路由 + 主题（jixoai-theme/theme-toggle）
      + 布局骨架（Dashboard/向导/高级设置三区）
- [x] 3.2 提供方向导 3 步（预设卡片→命名分组限额→链接+复制+TTL）+ 使用方向导
      3 步（粘贴预览→端口确认（冲突标注）→Agent diff 写入）——错误就地渲染、
      长操作加载态
- [x] 3.3 Dashboard（双角色状态卡/端口表/会话数）+ 高级设置（服务列表+detail 展开
      `●`、分组/密钥管理、relay、限额）+ notify 驱动拉取与断线对账 + toast/alert
- [x] 3.4 webui 构建产物校验（vite build 通过 + daemon 托管冒烟）+ 组件 lock 自检
      （grep `src/lib` 残留）

## 4. C：opentray 壳

- [x] 4.1 `src/app/main.ts`：createTray 菜单/开关 + ext-webview app-mode 主窗口
      （一次性 token URL）+ 优雅退出；resources/icon.svg（品牌 SVG）+ 图标生成
- [x] 4.2 打包链（@opentray/vite-plugin 或 tsdown-plugin + manifest 三段契约）+
      `pnpm app:build` 全链产物验证

## 5. 集成与收尾

- [x] 5.1 集成测试（node --test）：daemon+contract 端到端（ws orpc 调用/notify
      推送/token 门禁/静态托管）；向导核心 RPC 全链（预设→服务→share→导入→端口）
- [x] 5.2 手工回归清单入 README（托盘/窗口/主题/两向导/撤钥/重启恢复）；
      `pnpm -r test` + typecheck 全绿
- [x] 5.3 remix 子代理复核消化 + 收尾（archive/commit/push；jixoai-ui 阻塞问题
      发 gh issue）
