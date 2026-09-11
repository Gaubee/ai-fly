# CLI Parity Tasks

## A. daemon 命令集

- [x] 1. src/cli/daemon-state.ts：`~/.aifly/daemon/`（pid / last-start.json /
      daemon.log）读写 + 活性检查 + 跨平台终止（posix SIGTERM/SIGKILL，
      win32 taskkill）；复活入口 = process.argv[1]
- [x] 2. daemon start：前台默认（现 serve 逻辑迁移）；`--detach` 后台化
      （detached spawn + stdio 落 log + pidfile + last-start 记忆）；
      `serve` 保留为兼容别名
- [x] 3. daemon stop（SIGTERM → ≤10s 轮询确认 → --force 硬杀；实测 fabric
      拆链 >5s，窗口放宽）/ info（活性/uptime/参数/store 摘要）/ restart
      （按 last-start 或新参）
- [x] 4. bin.ts：裸 `ai-fly` ≡ daemon start；USAGE 全量重写（六组）；
      EPIPE 守护；自 pid 竞态容忍（--detach 复活的子进程看到自己的 pid）

## B. resource 命令集

- [x] 5. service add --preset 预填 + --route/--route-pattern/--secret/
      --form/--content/--model/--local-prefix；service get 全量详情；
      service test（provider route-test 引擎复用 + $secret 解析）
- [x] 6. group set-limits（--max-concurrency/--daily-requests/--unlimited）
- [x] 7. secret set（--value/--stdin/隐藏交互；bearerPrefix）+ list + remove；
      无 get（值永不出库）
- [x] 8. relay 并入 settings set relay（写 ~/.aifly/settings.json，与 GUI 同源；
      `relay` 保留为别名）；解析链插入 settings 层（flag > ring/link > env >
      settings > legacy config > n0）
- [x] 9. settings list/set（theme / models-dev / relay）+ presets 清单
      （curated featured + models.dev 长尾，--json）
- [x] 10. 顶层 `ai-fly test`（消费侧跨 keyring 解析服务，经网关单轮请求，
       ECONNREFUSED 提示先 `ai-fly run`）

## C. 质量与发布

- [ ] 11. 单测：daemon-state / relay / settings / secret（tmp 目录）；
       集成：daemon start --detach → info → stop 回路
       （实机冒烟已过：HOME 沙盒全命令集走查 + 494 vitest + tsc 绿；
       正式单测补充待做）
- [x] 12. alpha 通道：release.mjs prerelease semver + dist-tag 推导；
       release.yml 按 tag 推 DIST_TAG + gh release --prerelease；
       RELEASE.md §3a 文档化
- [ ] 13. 发 0.3.0-alpha.1 → 三机矩阵（本机 / ssh macmini / ssh gaubeehonor）
       全命令集 + 双机分享链路；全绿后 Owner 拍板 latest
