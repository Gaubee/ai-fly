# Tasks: service-lifecycle

## 1. consumer 侧：存储与网关热生效

- [x] 1.1 Keyring.disabledServices（schema default []；applyCatalog 保留+修剪到
      存活；mergeImportView/join 骨架携带）+ store 单测（同步不复活语义：disabled
      条目经 applyCatalog 后仍在 disabled、目录消失的从 disabled 移除）
- [x] 1.2 Gateway.setServiceEnabled 公开方法（stop=removeService 关端口+终结在途；
      start=addService 建监听+冲突错开+NOTICE）+ syncProviderServices desired 过滤
      disabled + startEngine 物化过滤；gateway 单测（热停/热起/目录同步不复活）
- [x] 1.3 daemon 进程间传导：run --detach 的引擎 watch consumers 根下 keyring.json
      变更 → 重算 disabled 差分（对齐 provider serve.ts 的 services.json watcher
      模式）；集成测试（外部改文件 → 监听关/开）

## 2. consumer 侧：CLI / RPC / webui

- [x] 2.1 `ai-fly services [list|stop|start|rm]`（跨组列表含运行态——daemon 在跑
      读 pid+actualPorts 推断；stop/start 写 keyring+daemon 热生效；rm=stop 且列表
      默认隐藏，--all 显示停用项）+ CLI 集成测试
- [x] 2.2 RPC：consumer.services.{list,setRunning,remove}（rpc-contract +
      rpc-router）+ 契约测试
- [x] 2.3 webui Dashboard 端口表行内 启动/终止/移除 操作（loading 态锁、
      i18n zh/en、notify 反馈）+ Advanced 服务列表同步展示运行态

## 3. provider 侧：停用开关与传导

- [x] 3.1 SERVICE_STORE_SCHEMA.enabled（optional 缺省 true）+ store 读写路径 +
      SERVICE_SCHEMA 视图带 enabled + RPC services.setRunning
- [x] 3.2 engine 拒绝路径（disabled 服务请求 → unknown_service 404 零上游请求）+
      AUTH_OK 目录载荷排除 disabled（consumer 端口关停传导）+ 单测
- [x] 3.3 `ai-fly service stop|start <name>` CLI + 集成测试；webui Advanced 服务行
      启停开关（ServiceForm 编辑不变）

## 4. 验证与收尾

- [x] 4.1 全量门禁：vitest 全绿 + tsc 0 错 + webui build 绿（对照基线 519）
- [x] 4.2 交付前自走查（webui 子代理真实浏览器全链 + DOM 断言：终止/启动/移除
      两步确认/provider 开关/EN locale；keyring 与 services.json 落盘态同步验证；
      摩擦点 5 衍生修复：编辑重建保留停用态）
      ——2026-09-14 MainAgent 端到端复核（沙盒 HOME + 本机 relay + upstream
      echo + 双端真实 fabric 会话）：CLI 热启停（stop 1.5s 内端口拒绝/启动
      恢复透传）、provider 目录传导（stop 3s 内 consumer 服务消失端口关/
      start 恢复）、rm 停用态、webui 干净环境终止 t=0 端口关 + 启动恢复；
      语义边界记录：consumer 停用记录在 provider 目录移除该服务时被修剪
      （applyCatalog 防泄漏），provider 重新暴露后服务自动复活——"可复活"
      的深层路径，跨 provider 目录变化不持久
- [ ] 4.3 README（EN+zh）services 命令章节 + openspec 归档

## 5. 提供方级管理（Owner 走查反馈，2026-09-14 追加）

- [x] 5.1 Keyring.disabled 环级开关（schema default false；applyCatalog 保留）+
      setProviderEnabled 写路径 + 叠加语义单测（环停用全覆盖；环恢复时单服务停用保持）
- [x] 5.2 物化/目录同步/watch 传导环级过滤；Gateway 无需新方法（调用方按环循环
      setServiceEnabled）
- [x] 5.3 CLI 参数定粒度：`services stop|start <provider>`（单参=整环）、
      `services rm <provider>`（单参=forget 真删，usage 写明双语义）；list 环级标注
- [x] 5.4 RPC：services.list providers[].enabled + setProviderRunning；
      webui Dashboard provider 行 终止/启动（forget 已有）+ i18n
- [x] 5.5 走查（CLI 整环热启停 + provider 行 UI + 恢复叠加语义）+ 门禁
      ——2026-09-14 实测：CLI `services stop <prov>` 1.5s 双端口全关 + list
      `(off)` 标注；`start` 恢复且单服务停用保持叠加（r1 回 r2 留）；`rm <prov>`
      keyring+fabric 真删；webui provider 行 终止/启动提供方 + 已停用徽标，
      双端口同步开关；门禁 vitest 535 + tsc 0 + webui build + svelte-check 基线
