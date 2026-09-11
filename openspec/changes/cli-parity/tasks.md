# CLI Parity Tasks

## A. daemon 命令集

- [ ] 1. src/cli/daemon-state.ts：`~/.aifly/daemon/`（pid / last-start.json /
      daemon.log）读写 + 活性检查 + 跨平台终止（posix SIGTERM/SIGKILL，
      win32 taskkill）；复活入口 = process.argv[1]
- [ ] 2. daemon start：前台默认（现 serve 逻辑迁移）；`--detach` 后台化
      （detached spawn + stdio 落 log + pidfile + last-start 记忆）；
      `serve` 保留为兼容别名
- [ ] 3. daemon stop（SIGTERM → ≤5s 轮询确认 → --force 硬杀）/ info
      （活性/uptime/参数/store 摘要）/ restart（按 last-start 或新参）
- [ ] 4. bin.ts：裸 `ai-fly` ≡ daemon start；USAGE 全量重写

## B. resource 命令集

- [ ] 5. service get + service test（provider route-test 引擎复用：
      --form/--content/--local-prefix/--model，正文摘录打印）
- [ ] 6. group set-limits（--max-concurrency/--daily-requests/--unlimited）
- [ ] 7. secret set（--value/--stdin/隐藏交互；--no-bearer）+ list + remove；
      无 get（值永不出库）
- [ ] 8. relay list/set（file 层 config.json；--default 回 SDK 默认）
- [ ] 9. settings list/set（theme / models-dev；~/.aifly/settings.json 同源）

## C. 质量与发布

- [ ] 10. 单测：daemon-state / relay / settings / secret（tmp 目录）；
       集成：daemon start --detach → info → stop 回路
- [ ] 11. alpha 通道：release.mjs prerelease semver + dist-tag 推导；
       release.yml 按 tag 推 DIST_TAG + gh release --prerelease
- [ ] 12. 发 0.3.0-alpha.1 → 三机矩阵（本机 / ssh macmini / ssh gaubeehonor）
       全命令集 + 双机分享链路；全绿后 Owner 拍板 latest
