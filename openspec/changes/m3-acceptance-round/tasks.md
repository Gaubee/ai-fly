# Tasks: m3-acceptance-round

## 1. 图标竞赛（Lane ICONS）

- [x] 1.1 三方向设计稿（.icon-contest/{A,B,C}/：icon.svg + tray-icon.svg + 512/64/32/16 预览 + design-notes）
- [x] 1.2 编排者评选（16px 可读性、品牌一致、平台 tile 兼容），胜者与评选记录落 `icon-contest-verdict.md`
- [x] 1.3 胜者接线 resources/{icon,tray-icon}.svg → `pnpm app:icons` 再生 → 产物视觉复核

## 2. 窗口安全区与拖拽（Lane SHELL）

- [x] 2.1 webui：overlay 探测模块（getTitlebarAreaRect + geometrychange → CSS 变量；不可见归零）
- [x] 2.2 App 壳：顶部拖拽带（startAppRegionDrag，overlay 不可见时隐藏），导航/内容避让
- [x] 2.3 单测（bridge 缺席/存在两态）+ 浏览器 dev 形态回归（无安全区假象）

## 3. 预设体验（Lane PRESETS-UI）

- [x] 3.1 Preset 契约扩展：iconId（精选覆写，默认 id）+ logoUrl 派生；providers.json 变体条目补 iconId
- [x] 3.2 SOURCE 步：预设卡图标（失败回退首字母 tile）+ 搜索框过滤
- [x] 3.3 第②步：PORT → default consumer port 标签 + 说明；限额收进默认折叠 advanced options
- [x] 3.4 单测（iconId 派生/回退、过滤逻辑）+ 契约测试更新

## 4. 密钥库与解析（Lane SECRETS）

- [x] 4.1 src/provider/secrets.ts：store（0600/原子写）+ list/set/remove + 单测
- [x] 4.2 rewrite 解析扩展 `$secret:`（请求期、secret_missing 错误码）+ detail ● 投影覆盖 + 单测
- [x] 4.3 RPC provider.secrets.{list,set,remove}（list 只名称）+ 契约 + app 集成测试

## 5. 模型清单与测试（Lane MODELS-TEST）

- [x] 5.1 models-dev.ts：models{id,cost} 解析进缓存 + chat 启发式 + 价格排序 + 单测
- [x] 5.2 RPC presets.models({presetId})（缓存刷新/回退）+ services.test（三 apiForm 最小请求、默认最便宜、密钥库注入）+ 单测（fetch 注入）
- [x] 5.3 app 集成：草稿形状测试往返（fake upstream）

## 6. 密钥面板与测试 UI（Lane UI-PANEL）

- [x] 6.1 密钥面板组件（列表/新增/编辑/删除，值不回显）+ Advanced secrets 区入口
- [x] 6.2 向导②/高级表单：ENV VARIABLE NAME → 密钥选择器 + manage secrets 就地开合；rewrite 写 $secret:
- [x] 6.3 test 按钮 + 模型下拉（价格排序）+ 结果内联呈现（向导② + 高级服务行）
- [x] 6.4 webui 构建 + svelte-check 无新增错误

## 7. 收尾

- [x] 7.1 全量电池（vitest/integration/e2e/typecheck/build）绿
- [x] 7.2 视觉验收：daemon 实机四路由 + 安全区/拖拽 + 面板/测试截图复核
- [x] 7.3 README 手工回归清单增补（安全区/密钥面板/测试）；tasks 全勾；归档

## 8. Owner 第二轮验收（2026-09-10）

- [x] 8.1 密钥值语义：默认裸 key 自动拼 "Bearer "（bearerPrefix 开关，per-secret；旧文件兼容 true）
- [x] 8.2 group 管理对齐 keys：列表行卡片 + edit（服务/限额）+ remove（有未撤销密钥 CONFLICT）+ CLI group remove/set-services
- [x] 8.3 向导②advanced options 换标准 accordion（vendor）；default consumer port 与 match domains 移入；custom match 默认 use host（留空派生）
- [x] 8.4 连通测试：custom 上游探测 {upstream}/models（便宜档启发式）回退；结果带 request 详情与上游正文摘录（modelSource 三源）
- [x] 8.5 Dashboard 空态入口卡改标准 Card + CardFooter（整卡 <a> 违例）
- [x] 8.6 dev 形态双坑：vite 显式绑 127.0.0.1（v8 默认仅 ::1）+ token 门禁 vite 中间件代赎
- [x] 8.7 安全区消费面重构：inset-left/right 只属标题带矩形（header 承接，整列摊派违例）
