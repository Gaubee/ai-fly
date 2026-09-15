# app/ui Delta

## MODIFIED Requirements

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
