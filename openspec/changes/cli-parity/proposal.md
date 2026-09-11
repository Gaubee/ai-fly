# CLI Parity — GUI 能力的命令行全集（r2：自查补全后）

## Why

GUI 能做的大部分操作，CLI 应当同样可达（无 GUI 环境/脚本化/远端运维）。
现状缺口：daemon 无生命周期管理（serve 仅前台）；secret / relay / settings /
service test / group limits / presets / 路由参数 全部缺席；裸 `ai-fly` 是
usage 而非启动。

## 命令树（终态；帮助按 ● 分组呈现，命令本身保持平铺）

```
Daemon
  ai-fly                       ≡ daemon start（前台）
  ai-fly daemon start [--detach] [--data <dir>] [--relay <url>]...
  ai-fly daemon stop  [--force]
  ai-fly daemon restart [--detach]
  ai-fly daemon info
  ai-fly daemon log [--lines n]
  ai-fly serve                 兼容别名 = daemon start

Provider
  ai-fly service add <name> --upstream <url> [--preset <id>]
        [--route <local>=<up>[@forms]]... [--route-pattern <match>=<template>]...
        [--secret <name>] [--port <n>] [--match ...]... [--host/--strip/--append/--header-*]
  ai-fly service list|get|remove|test <name> [--form] [--content] [--local-prefix] [--model]
  ai-fly group  add|list|remove|set-services|set-limits（--max-concurrency/--daily-requests/--unlimited）
  ai-fly key    issue|list|revoke
  ai-fly secret set|list|remove（值永不出库——无 get）
  ai-fly share  --group <name> [--ttl <dur>]
  ai-fly revoke <endpointId>
  ai-fly presets [搜索词]          预设清单（featured + models.dev 长尾）

Consumer
  ai-fly join|import [--run]|run|ports|forget|status
  ai-fly key add <sk-…> --provider <id>
  ai-fly test  [--data <dir>] [--service <name>] [--form …] [--content …]
        经本机网关走完整 wire 链路的单轮请求（connect ③ 的 CLI 面）

Config
  ai-fly settings list
  ai-fly settings set theme dark|light|system
  ai-fly settings set models-dev on|off
  ai-fly settings set relay <url>... | --default     ← GUI RelayPickerDialog 同源
  ai-fly relay list|set …                             兼容别名 → settings set relay

Info
  ai-fly status [provider|consumer] [--verbose]
```

## r2 自查补全（相对初稿）

1. **service add 路由参数**（实机 e2e 亲历：当时只能直写 store）：
   `--route <local>=<up>` 前缀规则（forms 自动：前缀含 anthropic → [anthropic]，
   否则 [openai-chat, openai-responses]；`@forms` 后缀显式覆盖）+
   `--route-pattern <match>=<template>` 模式规则；`--secret <name>` 是
   `--header-set authorization=$secret:<name>` 的糖。
2. **presets**：GUI 首屏预设清单的 CLI 面（featured + models.dev 长尾，
   搜索过滤；`service add --preset <id>` 预填 upstream/match/routes）。
3. **顶层 test**：消费侧经本地网关的单轮 AI 请求（GUI connect ③ 平价；
   provider 侧已有 service test）。
4. **relay 归并 settings**：GUI 写的是 settings.relayUrls，CLI 初稿写的
   config.json——两层同概念不同源是历史疣。统一：`settings set relay` 写
   settings.json；CLI 解析链改 flag > link > env > settings.json >
   config.json(legacy) > n0。`relay` 保留为兼容别名。
5. **daemon log**：--detach 后台日志的查看面（tail daemon.log）。
6. **帮助分组**：平铺命令 + 按上述六组呈现（Daemon/Provider/Consumer/
   Config/Info），裸 --help 即全景。

## daemon 生命周期语义

- 前台默认；`--detach` = detached child + `~/.aifly/daemon/`（pid /
  last-start.json / daemon.log），复活入口 process.argv[1]（tsx 源与
  dist 产物两形态皆可）。
- stop：SIGTERM → ≤5s 轮询确认 → `--force` 硬杀；Windows 无跨进程优雅
  信号 → taskkill（v1 接受硬停，帮助文档明示）。
- info：活性/uptime/上次参数/store 摘要；restart 按 last-start（新参覆盖
  并记忆）。

## alpha 发布通道

- release.mjs 接受 prerelease semver（如 0.3.0-alpha.1）并推导 dist-tag
  （alpha/beta/rc → 同名，否则 latest）；release.yml 按 tag 名推导
  DIST_TAG → `npm publish --tag $DIST_TAG`，GitHub Release 标 --prerelease。
- 三机矩阵全绿后 Owner 拍板升 latest。

## Verification

- 单测：daemon-state / settings·relay·secret 命令（tmp 目录）/ service add
  路由参数解析 / presets 过滤。
- 集成：daemon start --detach → info → log → stop 回路；consumer test 经
  本地网关。
- 实机矩阵（herdr）：本机 macOS / ssh macmini / ssh gaubeehonor（Windows）
  —— 全命令集走查 + 双机分享链路（Windows provider ↔ macOS consumer）。
