# net-fly/provider 增量（service-lifecycle）

## ADDED Requirements

### Requirement: 服务生命周期与启停传导

提供者 SHALL 支持服务级与提供者级（环级）启停：`service stop <name>` 暂停
暴露（目录同步剔除该服务，配置保留）——consumer 侧该服务端口关闭、在途请求
中止、目录表现为 404；`service start` 恢复暴露（consumer 端口复活）。环级
`Keyring.disabled` 开关 SHALL 叠加生效：环停用即该环全部服务停止暴露，环
恢复时**单服务的既有停用态保持**（不因环级恢复而重置）。启停传导经目录同步
（物化/watch 全链过滤停用项），SHALL NOT 删除任何持久化配置。

#### Scenario: 服务停用目录剔除

- **WHEN** 提供者对在线 consumer 停用一个服务
- **THEN** consumer 目录在秒级剔除该服务（本地端口关闭），提供者侧配置与
  密钥不受影响；恢复后无需重新授权即复活

#### Scenario: 环级开关叠加

- **WHEN** 环内服务 A 已单独停用、B 运行中，随后环整体停用再恢复
- **THEN** 恢复后 B 回到运行、A 保持停用（环级操作不重置单服务状态）
