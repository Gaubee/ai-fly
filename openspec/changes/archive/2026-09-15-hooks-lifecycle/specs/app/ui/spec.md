# app/ui Delta

## ADDED Requirements

### Requirement: 生命周期管线编辑器

服务表单（分享向导 ② 与高级设置共用组件）SHALL 以「Request lifecycle」管线区
呈现四阶段纵向管线（编号 + 连接线，执行顺序 auth → headers → request →
response）：

- **auth 阶段**（默认展开）：none / secret（密钥库选择 + 管理入口）/ script
  （按阶段矩阵过滤的脚本选择 + bearer 前缀开关）/ literal（手填值）四族单选。
- **headers 阶段**（默认展开）：通用 K-V 编辑器（set 行编辑 + remove 列表）。
- **request / response 阶段**（折叠收纳）：脚本绑定选择器（按阶段矩阵过滤）+
  用途说明文案；request 未绑定时明示「原生 fetch 直连」。
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

## MODIFIED Requirements

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

### Requirement: 密钥面板与密钥选择器

提供方侧 SHALL 提供密钥面板（列表仅名称 + 新增/编辑/删除 key-value 表单，值输入
用 password 型控件、提交后不回显）。向导第 ② 步与高级服务表单的凭据字段 SHALL
为密钥选择器（列出密钥库 + "manage secrets…" 入口可就地打开面板增删后回选）；
选中后写入生命周期 auth 槽的 `{secret: name}` 绑定（不再经 rewrite 头协议）。
`$env:` 语法不出现在任何 UI 呈现中。

#### Scenario: 向导内就地补密钥

- **WHEN** 用户在第 ② 步打开选择器发现没有密钥，点 manage secrets 添加 openai 并选中
- **THEN** 选择器关闭回显 openai；生成服务的 auth 槽为 secret 绑定 openai；面板全程不回显值

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
