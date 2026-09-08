# Proposal: api-share

## Why

OpenDWeb fabric 已具备身份、邀请制成员控制、QUIC 直连 + relay 回退与撤销即断，但只承载
不透明 envelope 的"裸消息"。朋友间共享本地推理算力（ollama / vllm / LM Studio，或任意
OpenAI 兼容上游）是最直接的 killer app：Agent 生态已有"把 base URL 指向 localhost"的
肌肉记忆，缺的只是一条从 `127.0.0.1` 到朋友机器上推理服务的、受成员门控保护的通路。
ai-fly 作为独立产品仓库承载这一能力，OpenDWeb 仓库保持纯组网底座（MVP 零内核改动）。

## What Changes

- **新建 ai-fly 产品首版**：TypeScript CLI（bin `ai-fly`），单包双角色——
  提供侧网关（`serve`）与消费侧网关（`use`），全部构建在 `@jixo/opendweb-client-sdk`
  之上。
- **消费侧网关**：在 `127.0.0.1:<port>`（默认 8788）暴露 OpenAI 兼容面
  （`/v1/models`、`/v1/chat/completions`、`/v1/completions`、`/v1/embeddings`），
  以本地 API key（`sk-aifly-...`）鉴权，把请求经 fabric envelope 转发给提供者，
  并把流式响应还原为标准 SSE。
- **提供侧网关**：声明上游（任意 OpenAI 兼容 URL），仅转发白名单路径；对消费者完全
  隐藏上游凭据，对上游不透传消费者凭据；施加并发/频率/日请求限额与可选用量记录。
- **帧子协议（aifly1）**：在不透明 envelope 之上定义请求多路复用、请求/响应分片、
  SSE 块保序、中止与错误语义、目录帧；全部受既有 1 MiB 帧上限约束。
- **成员即权限**：谁能调用 = fabric 名册投影；Revoke 后既有连接被会话层断开
  （复用，零新增门控逻辑）。
- **Agent 配置写手**：`setup codex|cursor|cline|continue` 一键写入各 Agent 的
  base URL 与 key 配置并打印 diff。

## Capabilities

### New Capabilities

- `api-share/wire-protocol` — envelope 之上的请求/流式帧子协议：命名空间、关联、分片、保序、中止、错误语义与资源上限。
- `api-share/provider-gateway` — 提供侧网关：上游声明、路径白名单、凭据隔离、限额、模型目录。
- `api-share/consumer-gateway` — 消费侧网关：localhost OpenAI 端点、本地 key 鉴权、SSE 还原、离线语义、Agent 配置写手。

### Modified Capabilities

（无——本仓库为新建产品仓库，无既有 capability。）

## Impact

- 新仓库 `/Users/kzf/Dev/GitHub/ai-fly`：CLI、网关实现、openspec 文档、vitest 测试。
- 依赖 `@jixo/opendweb-client-sdk`（npm registry 既有版本；darwin-arm64 / win32-x64）。
- OpenDWeb 仓库零改动（如实现中撞到 SDK 缺口，回该仓库另立小 change）。

## Non-goals

- 计费/结算/支付（小圈子信任模型；仅本地 best-effort 用量记录）
- 匿名开放市场、双向信誉系统
- Anthropic 协议翻译（Claude Code 的 `/v1/messages` 面；后续另立 change）
- 根证书 / MITM 拦截（Owner 决策 2026-09-09：客观走 localhost 端口 + 用户显式改
  base URL，换取零系统侵入与零信任库污染）
- 跨提供者自动 failover、请求级路由策略（v1 单提供者直连）
- 推理内容的端到端加密（提供者必须读明文才能推理，信任边界 = 名册成员）
- 浏览器端 Agent 的 CORS 支持（v1 面向服务端/扩展宿主发请求的 Agent）

## Decisions

1. **接入方式 = localhost + base URL**（否决根证书全局拦截：信任库污染、EDR 告警、
   pinning 失败、卸载残留；而 OpenAI 生态的 base URL 是一等公民配置位）。
2. **信任模型 = 邀请制小圈子**：P2P ≠ E2E 加密，提供者必然可见明文 prompt；
   fabric 的邀请/撤销语义恰好是该信任模型的正确形状。
3. **产品故事 = 共享本地算力**：上游是任意 OpenAI 兼容 URL，但主打
   "朋友的 4090 / Mac Studio 成为你的推理端点"；"共享 key" 只是退化情形。
4. **独立仓库、纯 SDK 消费者**：ai-fly 不 fork、不修改 fabric；协议是 envelope
   之上的应用层约定。OpenDWeb 侧任何需求（如 Linux 构建）届时另立 change。
5. **协议命名空间 = `aifly1`**：产品自有前缀，与 fabric 上其它应用的 envelope
   流量（如 opendweb-example chat）可安全混流。
