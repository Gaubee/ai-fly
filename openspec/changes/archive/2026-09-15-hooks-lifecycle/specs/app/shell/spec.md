# app/shell Delta

## MODIFIED Requirements

### Requirement: RPC 契约面（orpc，zod 共享契约）

SHALL 以 orpc 契约（`src/shared/rpc-contract.ts`，前后端共享类型）暴露 M1 引擎能力的读写面：提供方（services/groups/keys/share/status/serve 控制，**服务形状为生命周期四槽 v2**）、使用方（import/join/key add/ports/status/forget/run 控制）、预设（list/detail/apply）、写手（preview/apply）、系统（主题偏好/设置）。`hooks.list` SHALL 返回各脚本的**可用阶段矩阵**（`stages` 为四阶段枚举数组，正式 schema）；提供方 status/store 面 SHALL 暴露 `legacy: { serviceNames: string[] } | null`，legacy 态下 `services.list` 返回最小失效壳（`{name, legacy: true}`——判别标记位，无其它字段，供移除列表渲染与联合类型运行时分拣），`services.remove` 按名可用。全部变更操作 SHALL 走引擎同款校验（复用 M1 模块，不另写逻辑）。错误 SHALL 经统一边界映射（DomainError→ORPCError），消息英文 ASCII。

#### Scenario: 契约驱动全类型

- **WHEN** webui 以 `createORPCClient(RPCLink)` 消费契约
- **THEN** 输入输出均为契约推导类型（无 any），拼写错误的过程名在编译期暴露

#### Scenario: 变更走引擎校验

- **WHEN** UI 提交一个含特权 defaultPort 缺省的服务表单
- **THEN** 与 CLI 同样的校验错误被返回并渲染（不绕过 store 规则）

#### Scenario: 阶段矩阵驱动选择器

- **WHEN** webui 请求 `hooks.list` 得到 `[{name:"codex", stages:["onRequestBearerAuthentication"]}]`
- **THEN** auth 阶段选择器列出 codex 脚本，request/response 阶段选择器不列出

#### Scenario: legacy 态经 RPC 呈现

- **WHEN** 提供方 store 处于 legacy 模式，UI 请求 provider status 与 services.list
- **THEN** status 返回 `legacy: {serviceNames: [3 个旧名]}`，services.list 返回 3 个 `{name, legacy: true}` 失效壳；对其中之一调用 services.remove 成功后列表剩 2
