# app/ui Delta

## MODIFIED Requirements

### Requirement: 提供方分享向导（3 步）

向导 SHALL 三步完成：①选服务来源（预设卡片：图标（models.dev logos，失败回退
首字母 tile）+ 搜索框（按 label/id/baseUrl 过滤）+ ollama/LM Studio/自定义 URL；
预设自动填 upstream 与 defaultPort）→ ②命名与分组（服务名、分组名可新建、密钥
选择器、连通测试；「default consumer port」标签明示为使用方本地端口建议值可由
使用方修改；并发/日限额收进默认折叠的 advanced options）→ ③生成分享（显示
aifly1. 链接 + 复制按钮 + "链接即凭证"提示 + TTL 选择）。每步 SHALL 可回退；提交
走 RPC 契约（引擎校验错误就地渲染）。向导完成 SHALL 在 Dashboard 反映并保持提供方
运行。

#### Scenario: 预设三步分享

- **WHEN** 用户选 ollama 预设（本机 11434 已运行）→ 命名 "my-ollama" 入组 "friends" → 生成
- **THEN** 第三步展示可复制链接与密钥提示；Dashboard 出现该服务与 friends 组

#### Scenario: 限额默认不可见

- **WHEN** 用户进入第 ② 步未展开 advanced options
- **THEN** 页面只呈现服务名/分组/端口/密钥与测试；限额字段不可见，展开后才可填写

## ADDED Requirements

### Requirement: 窗口安全区与拖拽带

应用壳 SHALL 在挂载时探测 `navigator.opentrayWindow?.overlay`：存在且 visible 时
读 `getTitlebarAreaRect()` 订阅 `geometrychange`，把避让内边距（至少顶部 inset，
macOS 另计左侧控件起点）写入根元素 CSS 变量，导航与内容区据此下移，不与原生
控件重叠；overlay 不存在或不可见（Windows 原生边框、纯浏览器 dev）时 inset 归
零。壳顶部 SHALL 提供拖拽带：pointerdown 触发 `startAppRegionDrag()`，带内交互
元素须阻止冒泡；overlay 不可见时拖拽带隐藏。

#### Scenario: 红绿灯不再压住内容

- **WHEN** macOS overlay 窗口打开且原生控件位于左上
- **THEN** 导航品牌区与内容从控件下方开始，改变窗口宽度（geometrychange）后避让量即时更新；拖拽带可移动窗口

### Requirement: 密钥面板与密钥选择器

提供方侧 SHALL 提供密钥面板（列表仅名称 + 新增/编辑/删除 key-value 表单，值输入
用 password 型控件、提交后不回显）。向导第 ② 步与高级服务表单的凭据字段 SHALL
为密钥选择器（列出密钥库 + "manage secrets…" 入口可就地打开面板增删后回选）；
选中后服务 rewrite 写入 `$secret:<name>`。`$env:` 语法不出现在任何 UI 呈现中。

#### Scenario: 向导内就地补密钥

- **WHEN** 用户在第 ② 步打开选择器发现没有密钥，点 manage secrets 添加 openai 并选中
- **THEN** 选择器关闭回显 openai；生成服务的 rewrite 为 `authorization: $secret:openai`；面板全程不回显值

### Requirement: 连通测试入口

向导第 ② 步（已选密钥、upstream 有效时）与高级页服务行 SHALL 提供 test 按钮：
默认以最便宜 chat 模型发起（模型下拉可改选，清单按价格升序、含价格展示）；
结果就地呈现 ok/耗时/模型或错误；进行中防重复点击。测试失败 SHALL 引导检查密钥
与网络，不得中断向导流程。

#### Scenario: 向导内一键测试

- **WHEN** 用户选好预设与密钥后点击 test
- **THEN** 按钮进入 loading，返回后内联显示 `ok · 812ms · glm-4-flash` 或失败原因；不产生任何已保存服务或流量计费之外的副作用提示
