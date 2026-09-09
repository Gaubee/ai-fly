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
