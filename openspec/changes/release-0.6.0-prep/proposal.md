# Proposal: 0.6.0 正式发布准备（依赖升级 + webui 打磨）

## Why

0.6.0-alpha.1 已发布（GO 9.1/10，npm alpha）。正式版前的两块收口：
（1）依赖落后——@opentray/* 停在 0.23.0（latest 0.33.2）、@orpc/* 1.14.6、
webui 侧 vite/jixoai-ui 等均有升级；（2）vision 走查两轮（6→7/10）后仍有
遗留打磨项（分享页分组、标题层级、徽章体系、对比度、SSE 解析视图等），
且 dashboard 黑帧欠一轮像素级视觉验收。

## What Changes

- 依赖升级（分层）：
  - 安全层：hono/tsx/vitest/svelte/shadcn/tailwind-merge patch；webui
    typescript 5.9→7（对齐根包）；vite 8.2→8.3
  - 同步层：@orpc/{client,contract,server} 1.14.6→1.15.2（root+webui 四处同步）
  - 谨慎层：@opentray/* 0.23.0→0.33.2（app 壳，10 个 minor；app:build +
    app:verify + 无头启动冒烟为门）；@jixo/opendweb-server-binary ^0.3.2→^0.5.0
    （dev relay）；webui jixoai-ui 0.4.0→0.5.1（设计语言库——本地
    jixoai.css/jx-pure.css 为 vendored 副本，升级后核对是否有令牌漂移）
  - pnpm-workspace minimumReleaseAgeExclude 清单同步到新版本
  - 不升级：无（typescript 根包已在 7）
- webui 打磨（vision 两轮遗留清单）：
  - P1-4 分享向导来源分组（本地/OpenAI 兼容/其它）+ 已配置置顶
  - P1-5 页面标题行层级（副标题移到主标题下方，不再同行右置）
  - P1-6 状态徽章体系统一（语义/分类/配置态三套语汇）
  - P2-3 Advanced tab 行说明降级；P2-4 中继 "-" 统一 0；P2-5 测试面板 SSE
    原始/解析双视图；P2-6 文字对比度下限；P2-7 分享卡片选中态
  - 补拍 dashboard 黑帧欠账截图（显示唤醒窗口）+ vision 终评
- 发布：version 0.6.0-alpha.1→0.6.0，全门禁，tag v0.6.0 → CI → npm latest

## Non-Goals

- access-policy 相关（Owner WIP，不碰）
- 新功能面；后端行为变更

## Success Criteria

- 全门禁绿：vitest 全量 / integration / e2e / tsc（root+webui）/ openspec strict
- app:build + app:verify 过；无头启动冒烟（隔离 HOME）
- vision 终评对四页新截图给 ≥8/10 或确认无 P0/P1 残留
- npm dist-tags.latest = 0.6.0（CI 发布，不经本地凭据）
