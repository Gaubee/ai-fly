# Proposal: net-fly-core

## Why

产品的本质是**通用网络桥接**：提供方把自己本地的服务（任意 HTTP 上游：ollama、
内网网关、带 key 的第三方 API）经 fabric 分享给受邀请的使用方，使用方在
`127.0.0.1` 得到端口映射，像访问本地服务一样访问远程。OpenDWeb fabric 已具备
身份/邀请/QUIC+relay/撤销即断，缺的只是桥接层与应用层授权（分组+密钥+分享链接）。
ai-fly（AI 预设层、3 步配置、界面）构建在 net-fly 基座之上，另立 change。

## What Changes

- **net-fly 引擎 v1（headless daemon + CLI，bin `netfly`）**：提供方与使用方两个
  角色，构建在 `@jixo/opendweb-client-sdk` 之上，fabric 内核零改动。
- **服务/分组/密钥模型**：提供方定义**服务**（域名匹配集 + 上游 + 重写规则，
  可属多分组）、将服务编入**分组**、为分组签发**访问密钥**（可多枚、随时撤销）。
  授权在应用层：fabric 管传输信任（谁能连），密钥管服务授权（谁能用哪组）。
- **分享链接**：一键生成，内含 fabric 邀请（`dweb1.`，issuer-online 单次兑换）+
  分组密钥 + 提供方非敏感元数据（别名/EndpointId/relay 入口/服务脱敏视图）。
  使用方导入即得分组使用权；同一提供方可持多枚密钥并存（钥环）。
- **帧子协议 `netfly1`**：envelope 之上的多密钥 AUTH 握手、HTTP 请求多路复用
  （含受控请求头透传）、流式分片（SSE/chunked 逐块转发）、接收侧缓冲兜底、
  空闲超时与首字节心跳、目录全量同步、稳定错误码、资源上限。协议是 HTTP 级
  通用转发，不感知 OpenAI 语义（那是 ai-fly 预设层的事）。
- **使用方端口映射**：每服务一个本地端口（默认沿用服务的默认端口，占用时自动
  错开并显著标注，可显式指定）；绑定仅 127.0.0.1。提供者离线快速失败、在线性
  可见、恢复自动续用。
- **里程碑地图**：本 change = M1 引擎；M2 本地 Web UI（3 步配置 + 高级设置收纳
  net-fly 细节）；M3 ai-fly 预设层（AI 供应商预设 + Agent 配置写手）；
  M4 代理模式（CONNECT 隧道 + 域名路由 + 运行时正则防护，需自建可靠层）。

## Capabilities

### New Capabilities

- `net-fly/wire-protocol` — netfly1 帧子协议：命名空间、多密钥 AUTH、请求多路复用、流式保序、接收侧背压兜底、超时/中止/错误语义、目录同步、资源上限。
- `net-fly/provider` — 提供方：服务/分组/密钥管理与持久化、AUTH 校验、上游转发与重写、限额、目录同步、链接签发。
- `net-fly/consumer` — 使用方：链接导入与钥环、端口映射与转发、离线语义、目录同步处理、状态观测。
- `net-fly/share-link` — 分享链接契约：构成、编码、兑换与两级撤销语义。

### Modified Capabilities

（无——本仓库既有 capability（api-share 已撤下）不保留；引擎脚手架仅工程底座。）

## Impact

- 仓库重构为 pnpm workspace：`packages/net-fly`（引擎）+ `packages/app`（UI，M2 立）。
  现有脚手架（args/config/errors/工具链）迁入 `packages/net-fly`。
- 依赖 `@jixo/opendweb-client-sdk`（npm 0.3.2；原生二进制仅 darwin-arm64 /
  win32-x64，**无 Linux**——CI 须跑 macOS runner，提供方部署 NAS/服务器场景 v1
  不可行，记录在案）；同进程多实例已由 SDK 测试实证，支持"使用方多提供方并存"。
- OpenDWeb 仓库零改动；实现中如撞 SDK 缺口回该仓库另立小 change。

## Non-goals

- 代理服务器模式 / CONNECT 隧道（M4：fabric 只有尽力投递，需自建 ACK/窗口/心跳）
- 出口型规则（提供方作为任意命中域名的出口网关；v1 规则是入站匹配型）
- ai-fly 预设库与 Agent 配置写手（M3 另立 change）
- 本地 Web UI / 桌面壳（M2 另立 change）
- 计费/结算、匿名市场、双向信誉
- 路径级（path）匹配规则（v1 仅域名级；重写只做 host/前缀/头）
- PAUSE/RESUME 端到端流控帧（v2；v1 以接收侧缓冲上限 + 中止兜底）
- 多提供者自动 failover、请求级路由策略
- 本地端点鉴权（v1 端口仅绑定回环；本地 key 后置）
- 本地 TLS / 根证书 / MITM（Owner 决策 2026-09-09 不变）
- 正则规则的运行时防护（v1 仅保存期静态检查；运行时限时随 M4 引入）

## Decisions

1. **规则语义 = 入站匹配型**：服务 = {域名匹配集(exact/suffix/regex), 上游, 重写}。
   匹配集是服务的身份（UI 展示、代理模式 M4 的路由依据、`strict-host` 严格模式的
   校验依据）；v1 端口模式按"端口即路由"宽松转发。→ 台账 D1。
2. **拓扑 = 一提供方一 fabric**：提供方进程一个 fabric 身份；分组/密钥是 net-fly
   应用层授权（AUTH 帧承载密钥集合）。撤销两级：撤密钥（应用层，即刻剔除授权）
   vs revoke 成员（fabric 级断网）。
3. **背压 = 接收侧兜底而非对端暂停**：fabric 数据面无应用层背压（对端 Rust 循环
   永续读取、TSFN 无界排队，实证），对端慢的唯一可控动作是中止——每请求接收缓冲
   上限（4 MiB）达限即 ABORT；PAUSE/RESUME 帧预留 v2。
4. **端口默认沿用服务声明的默认端口**；占用/冲突时自动分配空闲端口并显著标注
   （`--strict-ports` 可改为报错）。
5. **协议 HTTP 级通用、流式优先**：受控请求头透传（凭据类双向剥离/拒绝），
   SSE/chunked 逐块转发；OpenAI/Anthropic 语义一律下沉到 ai-fly 预设层。
6. **上游凭据仅环境变量间接引用**（`$env:VAR`，空串=未设置=省略 + 启动警告），
   绝不内联、绝不出现在帧/日志/链接中。

## 待 Owner 确认的决策台账（调研与 remix 复核后推荐项，先按此落 spec）

- D1 规则语义：入站匹配型（备选：出口型/两者）。
- D2 代理模式：后置 M4（实证：CONNECT 隧道需自建可靠层，独立里程碑体量）。
- D3 UI 形态：本地 Web UI + 常驻 daemon（M2）；托盘/桌面壳后续。
- D4 预设来源：点名精选 + models.dev 目录动态扩展。**DSH 是哪个项目待指路。**
- D5 端口所有权转译：Owner 原话"提供方在本地启动一个端口"在 fabric 拓扑下落为
  **使用方本地端口映射 + 提供方 fabric 端点**（提供方不监听 TCP 端口；"重写后
  转发上游"职责完整保留在提供方引擎）——心智模型迁移点，请确认。
- D6 密钥入口形态：Owner 原话"输入使用密钥"在 v1 落为**导入分享链接**（裸密钥
  不足以完成 fabric 组网邀请兑换，链接 = 邀请 + 密钥一体）——请确认可接受。
- D7 披露模型：使用方**永久**只见服务脱敏视图（name/match/defaultPort），上游
  地址与重写细节任何层级不离开提供方（"展开详情"= M2 UI 展开脱敏视图）——请确认。
- D8 凭据类头零过桥：`authorization` / `proxy-authorization` / `cookie` 双向
  剥离（使用方侧剥离、提供方侧拒绝）——本地代理鉴权需求后置。
