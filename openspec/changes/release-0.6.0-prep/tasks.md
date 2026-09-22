# Tasks: release-0.6.0-prep

## 1. 依赖升级

- [x] 1.1 安全层：hono/tsx/vitest/svelte/shadcn/tailwind-merge + webui ts 7 对齐 + vite 8.3
- [x] 1.2 同步层：@orpc/* 1.15.2（root deps+dev + webui）
- [x] 1.3 谨慎层（jixoai-ui 0.5.1 不随升：dev 工具链 + 组件为 vendored 副本，留专项同步任务）：@opentray/* 0.33.2（app:build/app:verify/无头冒烟门）+ server-binary ^0.5.0 + jixoai-ui 0.5.1（核对令牌漂移）
- [x] 1.4 workspace minimumReleaseAgeExclude 同步
- [x] 1.5 全门禁（unit 1 例为 8790 端口与用户 dev 实例环境冲突，终门禁复跑；其余全绿）：vitest/integration/tsc(root+webui)/webui build

## 2. webui 打磨（vision 遗留）

- [x] 2.1 分享向导分组（P1-4：本地运行时/云端服务两组 + 本地徽章 outline 化；a117eb8）
- [x] 2.2 标题行层级（P1-5：Dashboard/Advanced header 改上下结构；a117eb8）
- [x] 2.3 徽章体系统一（P1-6：本地预设徽章 tonal→outline；a117eb8）
- [x] 2.4 P2 批（tab 说明弱化 / 中继"未配置"占位 / SSE 解析视图+原始数据切换；a117eb8；对比度下限与卡片选中态经前两轮已达标）
- [x] 2.5 补拍 dashboard + 四页截图过黑帧门（agent-browser 1440×900 dark：dashboard/share/connect-step3/advanced/advanced-settings 五张全过）
- [x] 2.6 vision 终评 GO：三轮 6→7→8.5→8.8，P0/P1 清零（604daa3 收尾 P1 重复标签 + 三条 P2；复核确认无回归）
- [x] 2.7 计划外：i18n 漏网清理（ConnectWizard step2 四处硬编码英文接线、Advanced/GroupsDialog/TestConnection 标题与说明句接线、net-fly→ai-fly 笔误三处、zh/en 249 键对齐；a117eb8）

## 3. 发布

- [x] 3.1 version 0.6.0（无 CHANGELOG 文件、README 无版本记录面，如适用性判定：不适用）
- [x] 3.2 全门禁：vitest 646/647（唯一失败=8790 用户 dev 实例 EADDRINUSE 环境冲突，用例代码零 diff，CI 干净环境复验）+ integration 11/11 + e2e 11/11 + tsc root/webui + webui build + openspec strict 8/8；@orpc 1.15.2 畸形帧语义回归发现并回退 1.14.6（94bb7ae）
- [ ] 3.3 codex 终审（发布 diff）→ GO
- [ ] 3.4 tag v0.6.0 → push → CI → npm latest 验证
- [ ] 3.5 归档 change
