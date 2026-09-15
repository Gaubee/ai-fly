# app/shell Specification

## Purpose

定义桌面壳与 UI 服务层的行为契约：opentray 托盘/窗口生命周期、单进程引擎嵌入、daemon 的 UI 服务（静态托管 + orpc + ws 通知 + token 门禁）。M1 引擎行为不变，壳只是新宿主。

## Requirements

### Requirement: 托盘与主窗口生命周期

桌面入口 SHALL 以 `createTray` 常驻托盘（菜单：打开主窗口 / 提供方开关 / 使用方开关 / 退出），经 `@opentray/ext-webview` 打开 app-mode 主窗口（`style.appMode: true`）加载 `http://127.0.0.1:<port>/`；窗口 close 隐藏不销毁，退出菜单执行优雅关闭（引擎 shutdown 幂等复用 M1 语义）。托盘进程 SHALL 即 UI 服务进程（单进程架构：直接 import M1 引擎模块，提供方 daemon 与使用方网关按数据目录现状启动）。引擎角色开关状态 SHALL 反映到托盘（图标文本或菜单勾选）。

#### Scenario: 冷启直达

- **WHEN** 桌面入口启动且 `~/.aifly` 存在既有配置
- **THEN** UI 服务就绪、托盘出现、主窗口自动打开并完成 token 握手，Dashboard 显示双角色真实状态

#### Scenario: 退出优雅关闭

- **WHEN** 用户点托盘"退出"
- **THEN** 引擎 shutdown（在途请求按 M1 语义收敛）、窗口与托盘销毁、进程退出码 0

### Requirement: UI 服务与 token 门禁

daemon SHALL 在 127.0.0.1 随机端口（可固定）提供：`/`（webui 静态产物 + SPA 回退）、`/ws/rpc`（orpc over ws）、`/ws/notify`（JSON 通知）。webview 加载 SHALL 经短时 token（URL 一次性注入，同 skill-creator-v2 模式）；token 校验失败断开且不重放。本机浏览器直连（无 token）SHALL 仅得到指引页（说明这是桌面应用附带的 UI）。ws 服务 SHALL 以 guardRpcSocket 模式隔离畸形帧（单连接断开，不打穿进程）。

#### Scenario: webview token 握手

- **WHEN** 主窗口加载带 token 的入口 URL
- **THEN** orpc client 与 notify 通道建立成功，token 用后即焚（重复使用被拒）

#### Scenario: 畸形 ws 帧隔离

- **WHEN** 恶意客户端向 /ws/rpc 发送非法帧
- **THEN** 仅该连接断开，进程与其它连接不受影响

### Requirement: RPC 契约面（orpc，zod 共享契约）

SHALL 以 orpc 契约（`src/shared/rpc-contract.ts`，前后端共享类型）暴露 M1 引擎能力的读写面：提供方（services/groups/keys/share/status/serve 控制，**服务形状为生命周期双模式 v2**（自定义四槽 `auth`/`headers`/`request`/`response` 或预设 `hooks` 整段绑定——互斥））、使用方（import/join/key add/ports/status/forget/run 控制）、预设（list/detail/apply）、写手（preview/apply）、系统（主题偏好/设置）。`hooks.list` SHALL 返回各脚本的**可用阶段矩阵**（`stages` 为四阶段枚举数组，正式 schema）；提供方 status/store 面 SHALL 暴露 `legacy: { serviceNames: string[] } | null`，legacy 态下 `services.list` 返回最小失效壳（`{name, legacy: true}`——判别标记位，无其它字段，供移除列表渲染与联合类型运行时分拣），`services.remove` 按名可用。全部变更操作 SHALL 走引擎同款校验（复用 M1 模块，不另写逻辑）。错误 SHALL 经统一边界映射（DomainError→ORPCError），消息英文 ASCII。

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
### Requirement: 通知通道（push → pull）

引擎/目录/连接状态变化（peer 事件、目录 refresh、限额触发、端口变化、导入完成等）SHALL 经 `/ws/notify` 推送轻量事件（type + 关键 id）；前端收到后以 orpc 拉取详情。通知 SHALL 仅作触发器（可丢——前端拉取的快照是唯一事实源；断线重连后全量拉取对账）。

#### Scenario: 提供方上线即时反映

- **WHEN** 使用方引擎检测到提供者 direct 连接
- **THEN** 前端收到 provider-state 通知，拉取 status 后 Dashboard 状态卡更新

#### Scenario: 通知丢失可自愈

- **WHEN** 通知通道断开期间发生目录变更
- **THEN** 重连后前端全量拉取，视图与引擎一致（通知不承担可靠性）

### Requirement: 品牌图标资产

应用图标 SHALL 以仓库内 `resources/icon.svg` 为唯一 canon（1024 全出血矢量，hue 95
琥珀家族），`resources/tray-icon.svg` 为其纯黑透明单色版；两者经 `pnpm app:icons`
（generateOpenTrayAppIcon + sharp template 渲染）产出 `resources/app-icons/` 全平台
资产。canon 变更 SHALL 满足：16px 缩略下主体剪影仍可辨、与生成器安全区 tile 兼容
（主体占画布 62%~78% 高度）。图标方向的选型 SHOULD 经多方案评审留痕（竞赛稿与
评选记录存档于 change 目录）。

#### Scenario: 重生成一致

- **WHEN** canon SVG 更新后执行 `pnpm app:icons`
- **THEN** icns/ico/linux png/app-icon.json 全部随新 canon 再生，托盘 template 图与 app 图标为同一符号语言
