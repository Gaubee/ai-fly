# app/ui Specification

## Purpose

定义 Web UI 的信息架构与关键行为：ai-fly 默认视图（3 步向导 ×2）、Dashboard、net-fly 高级设置收纳、detail 展开、主题。目标是"默认隐藏细节、3 步完成配置"（Owner 产品定义）。

## ADDED Requirements

### Requirement: 信息架构与角色默认视图

UI SHALL 以三区组织：**Dashboard**（首页：双角色状态卡——提供方运行态/服务数/在线会话，使用方各提供者状态/端口表）、**向导**（提供方分享 / 使用方接入）、**高级设置**（net-fly 细节：服务/分组/密钥/relay/限额完整管理）。默认视图 SHALL 只呈现 ai-fly 相关操作；net-fly 通用概念（match 集、重写规则、relay 配置）仅出现在高级设置。组件库 SHALL 为 jixoai-ui（hue 95），主题支持 light/dark/system（theme-toggle）。

#### Scenario: 首屏三步可达

- **WHEN** 新用户（~/.aifly 为空）首次打开主窗口
- **THEN** 首屏直接给出两条 3 步向导入口（分享我的服务 / 接入朋友的链接），无高级设置干扰

### Requirement: 提供方分享向导（3 步）

向导 SHALL 三步完成：①选服务来源（预设卡片：ollama/LM Studio/自定义 URL；预设自动填 upstream 与 defaultPort）→ ②命名与分组（服务名、分组名可新建、可选限额）→ ③生成分享（显示 aifly1. 链接 + 复制按钮 + "链接即凭证"提示 + TTL 选择）。每步 SHALL 可回退；提交走 RPC 契约（引擎校验错误就地渲染）。向导完成 SHALL 在 Dashboard 反映并保持提供方运行。

#### Scenario: 预设三步分享

- **WHEN** 用户选 ollama 预设（本机 11434 已运行）→ 命名 "my-ollama" 入组 "friends" → 生成
- **THEN** 第三步展示可复制链接与密钥提示；Dashboard 出现该服务与 friends 组

### Requirement: 使用方接入向导（3 步）

向导 SHALL 三步完成：①粘贴 aifly1. 链接（--preview 同款离线解析：显示提供者别名/分组/服务列表）→ ②端口确认（默认端口表 + 冲突自动错开的显著标注 + 可改）→ ③Agent 配置（选择 codex/claude code/cursor/cline/continue 或"跳过"，展示将写入的配置 diff，确认写入）。导入与网关启动 SHALL 在第②步确认后自动进行（无需另点 run）。

#### Scenario: 链接导入到 Agent 就绪

- **WHEN** 用户粘贴有效链接且提供方在线
- **THEN** 三步完成后：端口就绪可请求、所选 Agent 的 base-url 配置已按 diff 确认写入、Dashboard 显示该提供者与服务

#### Scenario: 端口冲突透明

- **WHEN** 默认端口 11434 被本机占用
- **THEN** 第②步显著标注冲突与自动错开后的实际端口，用户可改

### Requirement: 高级设置与 detail 展开

高级设置 SHALL 提供：服务列表（默认只显示名称与端口；**展开显示 detail**——upstream/match 全集/rewrite 规则，`$env` 注入头显示 `●`，与 M1 AUTH_OK 披露同源）、分组与密钥管理（issue/revoke 即时生效）、relay 配置（含稳定入口指引文案）、限额编辑。全部操作走 RPC；变更经通知通道即时反映到在线视图。

#### Scenario: 展开看完整规则

- **WHEN** 用户在高级设置展开一个带 $env 头注入的服务
- **THEN** 显示 upstream、match 全集与 rewrite 规则，凭据值位置为 `●`，无变量名

#### Scenario: 撤钥即时生效可见

- **WHEN** 用户撤销一枚密钥且该密钥会话在线
- **THEN** 列表状态即刻更新，在线会话数变化经通知反映到 Dashboard

### Requirement: 状态即时性与错误呈现

UI SHALL 订阅 /ws/notify：状态卡、端口表、在线会话数在事件后一个拉取周期内更新；断线重连后全量对账。引擎/RPC 错误 SHALL 以 jixoai-ui 的 toast/alert 呈现（英文 ASCII 消息 + code），表单错误就地内联。长时操作（导入、兑换）SHALL 有加载态与终态反馈。

#### Scenario: 断连对账

- **WHEN** 通知通道闪断 10 秒后恢复
- **THEN** 前端全量拉取，视图与引擎最终一致，无需手动刷新
