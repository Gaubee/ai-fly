# Proposal: net-fly-core

## Why

产品的本质是**通用网络桥接**：提供方把自己本地的服务（任意 HTTP/WS 上游：ollama、
内网网关、带 key 的第三方 API）经 fabric 分享给受邀请的使用方，使用方在
`127.0.0.1` 得到端口映射，像访问本地服务一样访问远程。OpenDWeb fabric 已具备
身份/邀请/QUIC+relay/撤销即断，缺的只是桥接层与应用层授权（分组+密钥+分享链接）。
ai-fly（AI 预设层、3 步配置、界面）构建在这个基座之上，另立 change。
**net-fly 是内部分层/阶段标签（工作分解用），唯一产品名是 ai-fly**（Owner 决策
2026-09-09 grilling DL-10：bin/npm/UI 品牌统一 ai-fly，net-fly 不发布不露名）。

## What Changes

- **ai-fly 引擎 v1（headless daemon + CLI，bin `ai-fly`）**：提供方与使用方两个
  角色，构建在 `@jixo/opendweb-client-sdk` 之上，fabric 内核零改动。
- **服务/分组/密钥模型**：提供方定义**服务**（域名展示集 + 上游 + 重写规则，
  可属多分组）、将服务编入**分组**、为分组签发**访问密钥**（`sk-aifly-` 前缀，
  可多枚、随时撤销、与设备解耦）。授权两级：fabric 令牌管设备准入，应用层密钥
  管分组授权（DL-3）。
- **三入口凭据模型**：`join <dweb1令牌>`（设备入网）/ `key add <密钥>`（裸密钥
  入环，需已入网）/ `import <aifly1.组合链接>`（首访信封：1 令牌 + 1 密钥；
  老设备跳过兑换直接入环）。
- **分享链接 `aifly1.`**：自包含 payload（invite + key + 提供方元数据 + 服务
  `detail` 脱敏披露——完整规则可见，凭据值永远 `●`，DL-4）。
- **帧子协议 `aifly1`**：envelope 之上的多密钥 AUTH 握手（AUTH_OK 携带 relayUrls
  在线刷新，DL-12）、HTTP 请求多路复用（含受控请求头透传）、**WebSocket 升级
  通道**（DL-2：101 后 `DATA_UP`/`DATA_DOWN` 双向原始字节中继 + `CLOSE`）、流式
  分片、接收侧缓冲兜底、空闲超时与首字节心跳、目录全量同步、稳定错误码、资源
  上限。协议是 HTTP/WS 级通用转发，不感知 OpenAI 语义（那是 ai-fly 预设层的事）。
- **使用方端口映射**：每服务一个本地端口（默认沿用服务的默认端口，占用时自动
  错开并显著标注，可显式指定）；绑定仅 127.0.0.1。提供者离线快速失败、在线性
  可见、恢复自动续用。
- **里程碑地图（两段式，DL-7/DL-9）**：本 change = **M1 引擎**；M2 = 产品化
  （opentray 壳：tray + `@opentray/ext-webview` 承载 daemon 的 Web UI
  （Svelte 5 + shadcn-svelte）+ 全量 AI 预设（DL-5 双源：精选内置抄录 ∪ pi-ai
  coding 生态 ∪ ollama/LM Studio + models.dev `api.json` 长尾）+ Agent 配置
  写手）。**代理模式已取消**（DL-9：CONNECT 哑管道无凭据注入价值、MITM 违背
  根证书红线）——端口映射是唯一接入形态。

## Capabilities

### New Capabilities

- `net-fly/wire-protocol` — aifly1 帧子协议：命名空间、多密钥 AUTH、请求多路复用、WS 升级通道、流式保序、接收侧背压兜底、超时/中止/错误语义、目录同步、资源上限。
- `net-fly/provider` — 提供方：服务/分组/密钥管理与持久化、AUTH 校验、上游转发与重写（含 WS）、限额、目录同步、链接签发。
- `net-fly/consumer` — 使用方：三入口凭据/钥环、端口映射与转发、离线语义、目录同步处理、状态观测。
- `net-fly/share-link` — 分享链接契约：构成、编码、兑换与两级撤销语义。

### Modified Capabilities

（无——本仓库无既有 capability；引擎脚手架仅工程底座。）

## Impact

- 单包仓库（M1 不拆 workspace）：根 package `ai-fly`（bin `ai-fly`），源码按
  `src/{cli,wire,provider,consumer}` 分层；M2 再立 UI 包。现有脚手架
  （args/config/errors/工具链）原地复用。
- 依赖 `@jixo/opendweb-client-sdk`（npm 0.3.2；原生二进制仅 darwin-arm64 /
  win32-x64，**无 Linux**——CI 须跑 macOS runner，服务器/NAS 部署场景 v1 不可行，
  记录在案）；同进程多实例已由 SDK 测试实证，支持"使用方多提供方并存"。
- 发布：**暂不发布**（DL-8）；`ai-fly` npm 名 Owner 已预留，后续配 trustpublish
  由 ZCode 发布。LICENSE = **MIT OR Apache-2.0**（DL-11）。
- OpenDWeb 仓库零改动；实现中如撞 SDK 缺口回该仓库另立小 change。

## Non-goals

- **代理服务器模式 / CONNECT 隧道 / MITM**（DL-9 永久取消：哑管道无凭据注入
  价值，根证书红线不动）
- ai-fly 预设库与 Agent 配置写手（M2 产品化里程碑交付，另立 change）
- opentray 壳与 Web UI（M2）
- 计费/结算、匿名市场、双向信誉
- 路径级（path）匹配规则（v1 仅域名展示集；重写只做 host/前缀/头）
- PAUSE/RESUME 端到端流控帧（v2；v1 以接收侧缓冲上限 + 中止兜底）
- 多提供者自动 failover、请求级路由策略
- 本地端点鉴权（v1 端口仅绑定回环；本地 key 后置）
- 本地 TLS / 根证书 / MITM（Owner 决策 2026-09-09 不变）

## Decisions（Owner grilling 2026-09-09，DL-1~12 全部裁决）

1. **DL-1 端口所有权 = 使用方侧映射**：提供方不监听 TCP；同名服务靠密钥→分组→
   serviceId 区分；域名匹配集仅展示元数据。
2. **DL-2 WebSocket = M1 帧协议内置升级通道**（DATA_UP/DATA_DOWN/CLOSE 原始
   字节中继；Responses API WS 是主场景）。
3. **DL-3 凭据两层分离**：令牌（fabric/设备准入）≠ 密钥（应用层/分组授权）；
   join/key add/import 三入口；share 链接 = 首访信封。
4. **DL-4 披露 = 展开即完整规则**（detail），凭据值永远 `●`。
5. **DL-5 预设双源**：精选内置抄录（点名 ∪ pi-ai coding 生态 ∪ 本地运行时）+
   models.dev api.json 长尾（M2）。
6. **DL-6 壳 = opentray**（tray + ext-webview；Svelte 5 + shadcn-svelte）（M2）。
7. **DL-7 两段里程碑**：M1 引擎 → M2 产品化（壳 + UI + 全量预设）。
8. **DL-8 暂不发布**：ai-fly npm 名 Owner 预留；trustpublish 后置。
9. **DL-9 代理模式取消**（TLS 端到端使凭据注入不可行；MITM 违红线）。
10. **DL-10 唯一产品 ai-fly**：net-fly 仅内部标签，bin/包/UI 统一 ai-fly。
11. **DL-11 LICENSE = MIT OR Apache-2.0**。
12. **DL-12 relay 三层组合**：稳定入口部署指引（治本）+ AUTH_OK 携带 relayUrls
    （在线刷新）+ 断联一键重新导入兜底（M2）。
