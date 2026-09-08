# Proposal: net-fly-core

## Why

产品的本质是**通用网络桥接**：提供方把自己本地的服务（任意 HTTP 上游：ollama、
内网网关、带 key 的第三方 API）经 fabric 分享给受邀请的使用方，使用方在
`127.0.0.1` 得到端口映射，像访问本地服务一样访问远程。OpenDWeb fabric 已具备
身份/邀请/QUIC+relay/撤销即断，缺的只是桥接层与应用层授权（分组+密钥+分享链接）。
ai-fly（AI 预设层、3 步配置、界面）构建在 net-fly 基座之上，另立 change。

## What Changes

- **net-fly 引擎 v1（headless daemon + CLI，bin `netfly`）**：提供方与使用方两个角色，
  构建在 `@jixo/opendweb-client-sdk` 之上，fabric 内核零改动。
- **服务/分组/密钥模型**：提供方定义**服务**（域名匹配集 + 上游 + 重写规则）、
  将服务编入**分组**、为分组签发**访问密钥**（可多枚、随时撤销）。授权在应用层：
  fabric 管传输信任（谁能连），密钥管服务授权（谁能用哪组）。
- **分享链接**：一键生成，内含 fabric 邀请（`dweb1.`，issuer-online 单次兑换）+
  分组密钥 + 提供方非敏感元数据（别名/EndpointId/relay 入口/服务脱敏视图）。
  使用方导入即得分组使用权。
- **帧子协议 `netfly1`**：envelope 之上的 AUTH 握手、HTTP 请求多路复用、流式分片
  （SSE/chunked 逐块转发）、中止与稳定错误码、资源上限。协议是 HTTP 级通用转发，
  不感知 OpenAI 语义（那是 ai-fly 预设层的事）。
- **使用方端口映射**：每服务一个本地端口（默认沿用服务的默认端口，可改）；
  绑定仅 127.0.0.1。提供方离线快速失败、在线性可见。
- **里程碑地图**：本 change = M1 引擎；M2 本地 Web UI（3 步配置 + 高级设置收纳
  net-fly 细节）；M3 ai-fly 预设层（AI 供应商预设 + Agent 配置写手）；
  M4 代理模式（CONNECT 隧道 + 域名路由，需自建可靠层）。

## Capabilities

### New Capabilities

- `net-fly/wire-protocol` — netfly1 帧子协议：命名空间、AUTH 握手、请求多路复用、流式保序、中止/错误语义、资源上限。
- `net-fly/provider` — 提供方：服务/分组/密钥管理与持久化、AUTH 校验、上游转发与重写、限额、目录下发。
- `net-fly/consumer` — 使用方：链接导入、端口映射与转发、离线语义、状态观测。
- `net-fly/share-link` — 分享链接契约：构成、编码、兑换与两级撤销语义。

### Modified Capabilities

（无——本仓库既有 capability（api-share 已撤下）不保留；引擎脚手架仅工程底座。）

## Impact

- 仓库重构为 pnpm workspace：`packages/net-fly`（引擎）+ `packages/app`（UI，M2 立）。
  现有脚手架（args/config/errors/工具链）迁入 `packages/net-fly`。
- 依赖 `@jixo/opendweb-client-sdk`（npm 0.3.2；darwin-arm64 / win32-x64；
  同进程多实例已由 SDK 测试实证，支持"使用方多提供方并存"）。
- OpenDWeb 仓库零改动；实现中如撞 SDK 缺口回该仓库另立小 change。

## Non-goals

- 代理服务器模式 / CONNECT 隧道（M4：fabric 只有尽力投递，需自建 ACK/窗口/心跳）
- 出口型规则（提供方作为任意命中域名的出口网关；v1 规则是入站匹配型）
- ai-fly 预设库与 Agent 配置写手（M3 另立 change）
- 本地 Web UI / 桌面壳（M2 另立 change）
- 计费/结算、匿名市场、双向信誉
- 路径级（path）匹配规则（v1 仅域名级；重写只做 host/前缀/头）
- 多提供者自动 failover、请求级路由策略
- 本地端点鉴权（v1 端口仅绑定回环；本地 key 后置）
- 本地 TLS / 根证书 / MITM（Owner 决策 2026-09-09 不变）

## Decisions

1. **规则语义 = 入站匹配型**：服务 = {域名匹配集(exact/suffix/regex), 上游, 重写}。
   匹配集是服务的身份（UI 展示、代理模式 M4 的路由依据、`strict-host` 严格模式的
   校验依据）；v1 端口模式按"端口即路由"宽松转发（本地端口的请求全部经对应服务
   转发，不强制 Host 校验）。→ 待 Owner 确认（决策台账 D1）。
2. **拓扑 = 一提供方一 fabric**：提供方进程一个 fabric 身份；分组/密钥是 net-fly
   应用层授权（AUTH 帧承载密钥）。使用方多提供方并存 = 同进程多 fabric 实例
   （SDK 已实证）。撤销两级：撤密钥（应用层，即刻失去分组访问）vs revoke 成员
   （fabric 级断网）。
3. **分享链接 = dweb1. 令牌 + 密钥 + 元数据 的组合编码**：链接一次一兑
   （dweb1 CAS），密钥随链接传递（QUIC 加密通道内呈现给提供方）。
4. **端口默认沿用服务声明的默认端口**（通常即上游端口），使用方可改；冲突时
   明确报错并指引换端口。
5. **协议 HTTP 级通用、流式优先**：SSE/chunked 逐块转发；OpenAI/Anthropic 语义
   一律下沉到 ai-fly 预设层的重写规则里，引擎不感知。
6. **上游凭据仅环境变量间接引用**（`headerSet` 值形如 `$env:VAR`），绝不内联、
   绝不出现在帧/日志/链接中。

## 待 Owner 确认的决策台账（调研后推荐项，先按此落 spec）

- D1 规则语义：入站匹配型（备选：出口型/两者）。→ Decisions 1
- D2 代理模式：后置 M4（子代理实证 CONNECT 隧道需自建可靠层，工程量独立里程碑级）。
- D3 UI 形态：本地 Web UI + 常驻 daemon（M2）；托盘/桌面壳后续。
- D4 预设来源：点名精选（OpenAI/Claude/Gemini/OpenRouter/DeepSeek/z.ai/Kimi/
  Ollama/LM Studio，连接事实已核实）+ models.dev 目录动态扩展（opencode 同源）。
  **DSH 是哪个项目待 Owner 指路。**
