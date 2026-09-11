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
       （替代验证已完成：tsx 沙盒 + 三机发布产物实机走查全绿；正式 vitest
       单测仍待补。附带加固：upstream SSE 分块断言改事件序判据，消除
       满载时序抖动）
- [x] 12. alpha 通道：release.mjs prerelease semver + dist-tag 推导；
       release.yml 按 tag 推 DIST_TAG + gh release --prerelease；
       RELEASE.md §3a 文档化
- [x] 13. 发 0.3.0-alpha.1 → 三机矩阵（本机 / macmini / gaubeehonor）
       全命令集 + 双机分享链路

       实测（2026-09-11，npm dist-tags: alpha=0.3.0-alpha.1, latest=0.1.1）：
       - 本机：发布产物全命令集 + daemon 生命周期（start --detach/info/log/
         restart/stop）+ 裸命令前台默认 ✓
       - macmini（macOS）：安装/资源集/生命周期全绿 ✓；发现 relay 不可达时
         fabric 启动挂起 >30s 且零输出（见下方改进项）
       - gaubeehonor（Windows 11 26200）：经 ssh -R CONNECT 隧道完成安装与
         全命令集 ✓；stop 走 taskkill /F /T forced 路径且明示原因 ✓；
         restart/log ✓；该机 TUN 代理出网全断（n0 relay/registry 均
         CODE=000），relay 会合链路被环境阻断（非产品缺陷）
       - 分享链路：本机 provider(euc1 relay) ↔ macmini consumer：share →
         import（链接内嵌 relay 优先 ✓）→ run 网关 → test 单轮 → DeepSeek
         真实 401（伪 key 掩码回显 ****ummy）端到端 1055ms 往返 ✓

       改进项（后续 change）：
       a. daemon 启动期在 relay 连接确认前零输出、banner 要等 fabric boot
          完成——relay 不可达时像挂死；应早期打印 connecting 状态或异步 boot
       b. fabric 原生层缺代理支持（HTTP_PROXY/SOCKS）——受限网络（本例
          Windows TUN 死节点、macmini→aps1 QUIC 阻断）下 relay 不可用；
          iroh 侧支持 proxy_url 的话透出 --proxy 全局选项
       c. euc1 对两地均可达而 aps1 仅本机可达——share 链接只内嵌 provider
          当前 relay 单点，可考虑多 relay 冗余嵌入
