# Change: service-lifecycle

## Why

用户实测反馈（Owner，2026-09-14）：**服务导入后无法管理**——导入（向导/CLI）只解决了
"接进来"，之后既删不掉单个服务（`forget` 只能整组连 key 一起删）、也停不了单个服务
（`run` 是全量网关，stop/restart 只有进程粒度）。provider 侧同样只有 `service remove`
（删除配置），没有"临时停用"（终止暴露但保留配置）。

最小管理面（用户原话）：**列出、删除、终止、启动**。

技术约束：consumer 的服务列表由 provider 经 AUTH_OK **全量目录同步**（applyCatalog
整体替换 services）——本地"真删除"必然被下次同步复活。因此 consumer 删除语义定为
**移除+可复活**：从列表移除且不物化监听，目录同步仍更新该条目（服务变更不丢）但
不复活监听；组内可随时重新启动。

## What Changes

### consumer 侧（主体）

- **存储**：Keyring 新增 `disabledServices: string[]`（zod default [] 兼容旧文件）；
  applyCatalog 全量替换 services 时**保留** disabled 集合并修剪到存活条目（目录里
  消失的 serviceId 同步移出，防泄漏）；mergeImportView/join 骨架携带。
- **网关热生效**：Gateway 新增公开 `setServiceEnabled(providerId, serviceId, enabled)`
  （复用既有 addService/removeService 私有路径：关端口+终结在途 / 建监听+冲突错开）；
  `syncProviderServices` 的 desired 视图过滤 disabled（目录同步不复活被停服务）；
  startEngine 物化时按 disabled 过滤。
- **daemon 进程间传导**：gateway daemon（run --detach）watch 各 keyring.json 变更
  → 重算物化（对齐 provider serve.ts 的 services.json watcher 既有模式）；app 内嵌
  引擎走内存直改。
- **CLI**：顶层 `ai-fly services [list]`（跨组服务列表：组/serviceId/名称/端口/运行
  态/停用态）+ `ai-fly services stop|start <provider-ref> <serviceId>`（停用/启用，
  daemon 在跑则热生效）+ `ai-fly services rm <provider-ref> <serviceId>`（= stop 的
  移除语义，列表不再显示，除非 --all 含停用项）。命名：provider 单数 `service` /
  consumer 复数 `services` 两域区分（认知负担记录于此，复审可裁决）。
- **RPC + webui**：consumer 域加 `services.list / services.setRunning / services.remove`；
  Dashboard 端口表行内加 启动/终止 操作 + 移除入口（含 loading 态锁）。

### provider 侧

- **存储**：SERVICE_STORE_SCHEMA 加 `enabled: boolean`（optional 缺省 true 兼容
  旧 services.json）。
- **引擎语义**：disabled 服务——请求路径按 unknown_service 拒（404，零上游请求）；
  **目录同步（AUTH_OK 载荷）不包含 disabled 服务**→ consumer 端口自然关停+在途终结
  （Gateway.syncProviderServices 既有"refresh 视图不含即移除"分支直接传导）。
- **CLI**：`ai-fly service stop|start <name>`（扩展现有 service 命令组）。
- **RPC + webui**：services 节点加 setRunning；SERVICE_SCHEMA 视图带 enabled；
  Advanced 服务行加启停开关。

## Non-goals

- 不改 AUTH_OK 同步协议本身（目录仍全量替换；disabled 是 consumer 本地覆盖层）。
- 不做服务级并发/限额调整（groups.setLimits 既有）。
- 不做 provider 远程启停 consumer 监听（管理动作都在本地）。

## Impact

- 代码：consumer/{store,gateway,runtime,ports}.ts、provider/{store,engine,serve 目录
  构建}.ts、wire/frames.ts（目录载荷不变）、cli/commands/consumer/services.ts（新）、
  provider/service.ts（扩展）、shared/rpc-contract.ts、app/rpc-router.ts、webui
  （Dashboard/Advanced）。
- 测试：store 合并语义、gateway 热生效、engine 拒绝路径、CLI/RPC 集成、webui 走查
  （沙盒 HOME + agent-browser，交付前自走查纪律）。
