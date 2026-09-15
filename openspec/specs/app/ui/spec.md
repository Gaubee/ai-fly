# app/ui Specification

## Purpose

定义 Web UI 的信息架构与关键行为：ai-fly 默认视图（3 步向导 ×2）、Dashboard、net-fly 高级设置收纳、detail 展开、主题。目标是"默认隐藏细节、3 步完成配置"（Owner 产品定义）。

## Requirements

### Requirement: 信息架构与角色默认视图

UI SHALL 以三区组织：**Dashboard**（首页：双角色状态卡——提供方运行态/服务数/在线会话，使用方各提供者状态/端口表）、**向导**（提供方分享 / 使用方接入）、**高级设置**（net-fly 细节：服务/分组/密钥/relay/限额完整管理）。默认视图 SHALL 只呈现 ai-fly 相关操作；net-fly 通用概念（match 集、重写规则、relay 配置）仅出现在高级设置。组件库 SHALL 为 jixoai-ui（hue 95），主题支持 light/dark/system（theme-toggle）。

#### Scenario: 首屏三步可达

- **WHEN** 新用户（~/.aifly 为空）首次打开主窗口
- **THEN** 首屏直接给出两条 3 步向导入口（分享我的服务 / 接入朋友的链接），无高级设置干扰

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

### Requirement: 使用方接入向导（3 步）

向导 SHALL 三步完成：①粘贴 aifly1. 链接（--preview 同款离线解析：显示提供者别名/分组/服务列表）→ ②端口确认（默认端口表 + 冲突自动错开的显著标注 + 可改）→ ③Agent 配置（选择 codex/claude code/cursor/cline/continue 或"跳过"，展示将写入的配置 diff，确认写入）。导入与网关启动 SHALL 在第②步确认后自动进行（无需另点 run）。

#### Scenario: 链接导入到 Agent 就绪

- **WHEN** 用户粘贴有效链接且提供方在线
- **THEN** 三步完成后：端口就绪可请求、所选 Agent 的 base-url 配置已按 diff 确认写入、Dashboard 显示该提供者与服务

#### Scenario: 端口冲突透明

- **WHEN** 默认端口 11434 被本机占用
- **THEN** 第②步显著标注冲突与自动错开后的实际端口，用户可改

### Requirement: 高级设置与 detail 展开

高级设置 SHALL 提供：服务列表（默认只显示名称与端口；**展开显示 detail**——
upstream/match 全集/生命周期四槽（auth/headers/request/response），脚本与密钥
注入位显示 `●`，与 M1 AUTH_OK 披露同源）、分组与密钥管理（issue/revoke 即时
生效）、relay 配置（含稳定入口指引文案）、限额编辑。全部操作走 RPC；变更经
通知通道即时反映到在线视图。

#### Scenario: 展开看完整规则

- **WHEN** 用户在高级设置展开一个带 secret 认证与 header 注入的服务
- **THEN** 显示 upstream、match 全集与生命周期四槽配置，凭据值位置为 `●`，无变量名与脚本返回值

#### Scenario: 撤钥即时生效可见

- **WHEN** 用户撤销一枚密钥且该密钥会话在线
- **THEN** 列表状态即刻更新，在线会话数变化经通知反映到 Dashboard
### Requirement: 状态即时性与错误呈现

UI SHALL 订阅 /ws/notify：状态卡、端口表、在线会话数在事件后一个拉取周期内更新；断线重连后全量对账。引擎/RPC 错误 SHALL 以 jixoai-ui 的 toast/alert 呈现（英文 ASCII 消息 + code），表单错误就地内联。长时操作（导入、兑换）SHALL 有加载态与终态反馈。

#### Scenario: 断连对账

- **WHEN** 通知通道闪断 10 秒后恢复
- **THEN** 前端全量拉取，视图与引擎最终一致，无需手动刷新

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
选中后写入生命周期 auth 槽的 `{secret: name}` 绑定（不再经 rewrite 头协议）。
`$env:` 语法不出现在任何 UI 呈现中。

#### Scenario: 向导内就地补密钥

- **WHEN** 用户在第 ② 步打开选择器发现没有密钥，点 manage secrets 添加 openai 并选中
- **THEN** 选择器关闭回显 openai；生成服务的 auth 槽为 secret 绑定 openai；面板全程不回显值
### Requirement: 连通测试入口

向导第 ② 步（已选密钥、upstream 有效时）与高级页服务行 SHALL 提供 test 按钮：
默认以最便宜 chat 模型发起（模型下拉可改选，清单按价格升序、含价格展示）；
结果就地呈现 ok/耗时/模型或错误；进行中防重复点击。测试失败 SHALL 引导检查密钥
与网络，不得中断向导流程。

#### Scenario: 向导内一键测试

- **WHEN** 用户选好预设与密钥后点击 test
- **THEN** 按钮进入 loading，返回后内联显示 `ok · 812ms · glm-4-flash` 或失败原因；不产生任何已保存服务或流量计费之外的副作用提示

### Requirement: 呈现规范增补（2026-09-10 第二轮）

- 空数据首屏入口卡 SHALL 为标准 Card + CardFooter 按钮（整卡 `<a>` 跳转违例）。
- 向导 advanced options SHALL 使用标准手风琴组件（details/summary 基座）；内含
  限额、default consumer port 与（custom 模式）match domains——后者留空即
  "use host"（提交时按 upstream host 派生单条 exact 规则）。
- 密钥面板值输入为裸密钥语义；Bearer 前缀开关**不在密钥面板**（密钥条目不再
  携带前缀语义——开关位于各服务的 auth 阶段编辑器，见生命周期管线编辑器条款）。
- 连通测试结果 SHALL 展示请求详情行（POST url）与错误全文（含上游正文摘录）；
  custom 上游的模型下拉来自实时探测，探测失败转手填。
- groups 标签页 SHALL 提供行级管理（编辑服务/限额、删除带二次确认）。

#### Scenario: 手风琴收纳

- **WHEN** 进入向导第 ② 步
- **THEN** 主区仅服务名/分组/密钥/测试；advanced options 以手风琴（默认收起）承载限额/端口/match
### Requirement: 生命周期管线编辑器

服务表单（分享向导 ② 与高级设置共用组件）SHALL 以「Request lifecycle」管线区
呈现四阶段纵向管线（编号 + 连接线，执行顺序 auth → headers → request →
response）：

- **auth 阶段**（默认展开）：none / secret（密钥库选择 + 管理入口）/ script
  （按阶段矩阵过滤的脚本选择 + bearer 前缀开关）/ literal（手填值）四族单选。
- **headers 阶段**（默认展开）：通用 K-V 编辑器（set 行编辑 + remove 列表）。
- **模式切换**（Owner 2026-09-15 双模式裁决）：「自定义」与「预设」互斥切换——
  预设模式 = 整段脚本选择器（仅列**至少导出一个阶段函数**的脚本）+ 该脚本
  覆盖阶段的徽章呈现（①②③④，未覆盖阶段显示缺省语义）；自定义模式 = 下列
  逐槽编辑器。切换清空另一侧；两模式同现不可能（提交层互斥，见 provider 条款）。
- **request / response 阶段**（折叠收纳）：脚本绑定选择器（按阶段矩阵过滤）+
  用途说明文案；request 未绑定时明示「js-backend-fetch 直连」。
- keep 透传哨兵 SHALL 退役：管线编辑器理解全部可产生形态。
- 脚本资源管理真源仍在 hooks 页签；「选择器 + 管理弹窗」模式沿用。

#### Scenario: 管线化配置服务

- **WHEN** 用户在服务表单选择 secret 认证、添加一条 header set、展开折叠区绑定 request 脚本并保存
- **THEN** 落库服务含 auth/headers/request 三槽，编辑回显与所选一致

#### Scenario: 按阶段过滤脚本

- **WHEN** 某脚本仅导出 `onRequest`
- **THEN** auth/response 阶段选择器不列出该脚本，request 阶段选择器列出

#### Scenario: literal 手填

- **WHEN** 用户在 auth 阶段选 literal 并填入 `sk-…`
- **THEN** 保存后 detail 投影中该值显示 `●`，不回显原文

#### Scenario: 预设模式整段绑定

- **WHEN** 用户在管线区切到预设模式并选择 codex 脚本（其 stages 含 ①②③）
- **THEN** 保存后服务为 `hooks: {script: "codex"}`；编辑回显仍为预设模式且阶段徽章与 stages 矩阵一致

#### Scenario: 模式切换互斥清空

- **WHEN** 用户在自定义模式配好 auth 后切到预设模式
- **THEN** 逐槽配置被清空（提交不含逐槽字段）；切回自定义模式时预设脚本绑定同样被清空

### Requirement: 旧配置失效横幅

提供方 store 为 legacy 态（version 门禁判定）时，WebUI SHALL 在顶部呈现失效
横幅（「旧版配置已失效，请移除后重新添加」），旧服务以只读失效态列出（仅提供
移除操作）。**「界面可用」语义冻结**：页面正常加载、全部入口可见——服务/分组/
分享密钥（keys.issue/revoke，存 services.json）的**提交统一返回失效错误提示**
（INVALID_STATE 渲染为横幅级引导，不崩表单）；密钥面板读写 secrets.json 独立
文件，**不受 legacy 门禁**、照常可用。横幅在全部旧条目移除后消失，全部功能
恢复。联动面：App.svelte 布局层 + provider status 脏区 + Advanced 服务列表。

#### Scenario: 旧配置不阻断界面

- **WHEN** 提供方数据目录含 v1 services.json 且用户打开 WebUI
- **THEN** 界面正常加载，顶部显示失效横幅与旧服务只读列表；提交服务/分组/分享密钥变更得到失效引导提示；密钥面板增删密钥照常成功

#### Scenario: 移除后恢复

- **WHEN** 用户经横幅列表移除最后一个旧服务条目
- **THEN** 横幅消失，store 恢复 v2 正常态，服务/分组提交恢复可用
