# Proposal: m3-acceptance-round — Owner 验收反馈六项

## Why

Owner 首轮实机验收（2026-09-09）提出 6 项反馈：①应用图标需重新好好设计（多方案
竞赛制）；②窗口启用了 windowControlsOverlay 但未按安全区最佳实践避让原生控件、
无拖拽区；③分享向导 SOURCE 步缺图标与搜索；④name & group 步的 PORT 字段语义
不清（Owner 疑问已裁决：该字段是使用方默认端口建议值，提供方不开 TCP——DL-1
不变，本轮只改 UI 语义呈现），限额应收进高级选项默认折叠；⑤ENV VARIABLE NAME
暴露 $env 概念给普通用户（应用启动后 env 难改）——改为密钥面板（key-value）+
选择器；⑥密钥面板/服务表单应提供连通性测试，模型清单与价格取自 models.dev，
默认用最便宜的 chat 模型测试。

## What Changes

- **图标再设计（资产）**：三个设计方向并行竞赛（几何极简 / 节点链路 / 字标动势），
  编排者按 16px 可读性+品牌一致评选唯一胜者；接线既有 `pnpm app:icons` 生成管线
  （app icon catalog + tray template）。只换 `resources/icon.svg` 与
  `resources/tray-icon.svg`，管线零改动。
- **窗口安全区与拖拽（webui 壳层）**：挂载时经 `navigator.opentrayWindow.overlay`
  读 `getTitlebarAreaRect()` 并订阅 `geometrychange`，把避让内边距写到根元素 CSS
  变量；App 壳顶部渲染拖拽带（pointerdown → `startAppRegionDrag()`）。overlay
  不可见（Windows 原生边框 / 纯浏览器 dev）时 inset=0、拖拽带隐藏。
- **预设图标 + 搜索**：预设派生 `logoUrl = https://models.dev/logos/{iconId}.svg`
  （精选集可逐条覆写 iconId；加载失败回退首字母 tile）；SOURCE 步加搜索框（按
  label/id/baseUrl 过滤）。
- **name & group 呈现修正**：PORT 标签改为「default consumer port」并加说明（朋友
  机器上的本地端口建议值，可自行修改）；限额二字段收进默认折叠的「advanced
  options」。
- **密钥面板（secrets）**：提供方新增密钥库（`~/.aifly/provider/secrets.json`，
  0600 原子写）；rewrite 头值新增 `$secret:<name>` 引用（请求期解析；未知名按
  missing_secret 拒绝该请求）；RPC `provider.secrets.{list,set,remove}`（list 只回
  名称）。向导与高级表单的「ENV VARIABLE NAME」替换为密钥选择器 + 「manage
  secrets」面板（key-value 增删）。`$env:` 语法保留（CLI 高级用法），UI 不再产出。
- **模型清单与连通性测试**：models.dev 解析扩展至 provider.models（id/name/cost），
  RPC `presets.models({presetId})` 返回按价格升序的 chat 模型清单；RPC
  `services.test` 以草稿或已存服务形状发起最小上游请求（openai/anthropic/gemini
  三 apiForm），默认选最便宜 chat 模型，返回 ok/latencyMs/model/error；测试为
  provider-local（不经 fabric、不落盘）。向导第 ② 步与高级页服务行接入测试按钮。

## Capabilities

| Capability | Impact |
|---|---|
| presets | 图标派生 + 模型清单/价格（新增需求） |
| net-fly/provider | 密钥库、$secret: 解析、连通性测试（新增需求） |
| app/ui | 安全区/拖拽、预设选择体验、密钥面板/选择器/测试入口；向导呈现契约修订 |
| app/shell | 品牌图标资产 canon（新增需求） |

## Non-Goals

- 不改 wire 协议、组网与消费方引擎（测试与密钥均为提供方本地）。
- 不做密钥的跨设备同步/导出。
- `$env:` 语法不废弃（CLI 兼容），仅 UI 呈现层退场。
- Windows overlay（原生边框保留）与浏览器 dev 形态不造安全区假象。
