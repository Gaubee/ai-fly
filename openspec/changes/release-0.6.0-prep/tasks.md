# Tasks: release-0.6.0-prep

## 1. 依赖升级

- [x] 1.1 安全层：hono/tsx/vitest/svelte/shadcn/tailwind-merge + webui ts 7 对齐 + vite 8.3
- [x] 1.2 同步层：@orpc/* 1.15.2（root deps+dev + webui）
- [x] 1.3 谨慎层（jixoai-ui 0.5.1 不随升：dev 工具链 + 组件为 vendored 副本，留专项同步任务）：@opentray/* 0.33.2（app:build/app:verify/无头冒烟门）+ server-binary ^0.5.0 + jixoai-ui 0.5.1（核对令牌漂移）
- [x] 1.4 workspace minimumReleaseAgeExclude 同步
- [x] 1.5 全门禁（unit 1 例为 8790 端口与用户 dev 实例环境冲突，终门禁复跑；其余全绿）：vitest/integration/tsc(root+webui)/webui build

## 2. webui 打磨（vision 遗留）

- [ ] 2.1 分享向导分组 + 已配置置顶（P1-4）
- [ ] 2.2 标题行层级（P1-5：副标题下移）
- [ ] 2.3 徽章体系统一（P1-6）
- [ ] 2.4 P2 批：tab 说明降级 / 中继 0 / SSE 解析视图 / 对比度下限 / 卡片选中态
- [ ] 2.5 补拍 dashboard（黑帧欠账）+ 全四页新截图过黑帧门
- [ ] 2.6 vision 终评（≥8/10 或无 P0/P1）

## 3. 发布

- [ ] 3.1 version 0.6.0 + README/CHANGELOG 如适用
- [ ] 3.2 全门禁复跑（vitest 全量 + integration + e2e + strict）
- [ ] 3.3 codex 终审（发布 diff）→ GO
- [ ] 3.4 tag v0.6.0 → push → CI → npm latest 验证
- [ ] 3.5 归档 change
