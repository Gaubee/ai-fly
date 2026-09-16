# net-fly/consumer 增量（service-lifecycle）

## ADDED Requirements

### Requirement: 消费侧服务启停与可复活语义

`ai-fly services` SHALL 列出跨分组服务（状态 + 端口 + 环级停用标注）；
`services stop <provider>`（单参）停用该提供者**全部**服务，`services stop
<provider> <service>` 停用单服务（本地监听关闭，秒级生效）；`services start`
恢复（单服务停用态跨环级停用保持）。`services rm <provider>` SHALL 为
forget 语义（keyring + fabric 身份移除，真删）。consumer 侧停用条目在
provider 目录移除该服务时 SHALL 被修剪（防泄漏），provider 重新暴露后服务
自动复活（可复活语义：跨 provider 目录变化不持久化停用态）。

#### Scenario: 停用-恢复往返

- **WHEN** 消费者停用一个运行中的服务再启动
- **THEN** 端口秒级关闭后恢复同端口；期间 `ai-fly services` 列出
  `(off)`/`disabled` 标注

#### Scenario: forget 真删

- **WHEN** 消费者执行 `services rm <provider>`
- **THEN** 该提供者 keyring 与 fabric 身份被移除，服务列表不再出现
  （与停用的可复活语义不同）
