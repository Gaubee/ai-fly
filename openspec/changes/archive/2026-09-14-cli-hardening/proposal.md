# Change: cli-hardening

## Why

cli-parity 归档（2026-09-12，随 v0.3.0）后的两个收尾缺口：

1. **端口错开不回写**（cli-parity 实测发现 g）：网关 requested 端口被占自动错开
   （NOTICE + auto-assign）时，实际端口不落任何持久层；`ai-fly test` 按
   defaultPort 解析会打到占用者（实测 4399 被外来进程占，收到无关服务的 501
   HTML）。用户 pin 是唯一持久手段，但网关自身知道真相却不记录。
2. **正式单测缺口**（cli-parity tasks #11 迁入）：daemon-state/proxy/settings/
   secret/service 路由参数/detach 回路只有实机走查背书，无回归锚点——首轮
   补测当场抓到一个真 bug（见下），佐证必要性。

## What Changes

- **actualPorts 持久层**：Keyring 新增 `actualPorts: Record<serviceId, port>`
  （zod default {} 兼容旧文件）；`setActualPorts` 整体替换 + 修剪死服务；
  applyCatalog/mergeImportView/join 骨架同步携带。
- **引擎回写**：startEngine 物化监听后按 ring 把 listenerInfo 实际端口写入
  keyring（失败 NOTICE 不阻断引擎）——CLI run / import --run / app / status
  四条装配路径共享。
- **消费端口解析**：`ai-fly test` 端口优先级 actualPorts > pin > defaultPort
  （网关真实服务面优先于静态配置）；`ai-fly ports` 展示 LIVE 错开标注。
- **bug 修复（单测首轮抓出）**：`secret set --data <dir>` 被硬编码忽略
  （resolveDataDir(undefined)），set 写默认目录而 list/remove 尊重 --data，
  数据面割裂；改为与 list/remove 同参。
- **单测补齐（#11 迁入）**：daemon-state（kind 隔离/pid/last-start）、proxy
  解析、settings/relay 契约、secret 全子命令、service 路由参数（--route/
  @forms/--route-pattern/--secret/$secret 不出库）、actualPorts 全链
  （store/引擎回写/test 解析）、daemon --detach 进程级回路（不可达 relay 无
  网络依赖：detach→info→早期输出落 log→stop→pid 清理 + 双启拒绝 + noop stop）。

## Impact

- 兼容：旧 keyring.json 无 actualPorts 字段加载得 {}；不改 wire 协议。
- 风险面：runtime.ts 启动路径 +2 个 fs 写（try/catch 包裹）；CLI 展示面
  ports/test 输出行新增标注。
