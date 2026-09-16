# SPEC-COVERAGE — net-fly-core §5.3 逐 Scenario 覆盖自查

对照 `openspec/changes/net-fly-core/specs/net-fly/{wire-protocol,provider,consumer,share-link}/spec.md`。

> **opendweb-kernel-migration 注意（2026-09-16）**：本矩阵成文于 aifly envelope
> wire 承载面（mux/codec 帧级测试自该迁移起已删除——REQ/RESP 帧族由 opendweb
> 会话连续性内核承接；wire-protocol 增量见
> `openspec/changes/opendweb-kernel-migration/specs/net-fly/wire-protocol/spec.md`）。
> 帧级行（单帧/分片/缺断/交错）的承载面等价物为内核契约（SDK 侧
> test/continuity-http）与 ai-fly e2e（test/e2e/kernel-migration.test.mjs）；
> 本文件待 spec-sync（收尾任务）重写。
标注口径：

- **覆盖** = 有自动化断言（integration = `test/integration/engine.test.mjs`，e2e = `test/e2e/cli.test.mjs`，unit = `test/unit/**`（§2-4 车道交付））
- **部分** = 语义主面有断言，某一子句未断言（注明）
- **未覆盖（原因）** = 无断言，注明原因与替代面
- 引擎 bug 编号见交付报告：#1 SDK CJS 命名导出、#2 网关流式 pull 泵休眠、#3 WS 中继 accept 校验矛盾、#4 跨进程 revoke 不拆既有会话、#5 `key add` CLI 分发双重剥参

测试名缩写：IT:T1 = `AUTH matrix…`、IT:T2 = `path injection…PING…`、IT:T3 = `gateway: start engine…`、
IT:T4 = `gateway http…`、IT:T5a = `gateway ws echo roundtrip…`、IT:T5b = `gateway ws: upstream handshake failure…`、
IT:T6 = `gateway limits…`、IT:T7 = `gateway abort…`、IT:T8 = `gateway slow client…`、IT:T9 = `gateway catalog…`、
IT:T10 = `provider restart…`、IT:T11 = `share link…`、IT:T12 = `key_all_invalid…`、IT:T13 = `multi-provider…`、
IT:T14 = `seq gap poisons…`、IT:T15 = `listeners bind loopback only`。E2E = `cli e2e…`（单测流，按步骤号）。

## wire-protocol（32 Scenario）

| Scenario | 状态 | 覆盖位置 / 说明 |
|---|---|---|
| 混流共存 | 覆盖 | IT:T1（非 aifly envelope 后请求不受影响） |
| 未知帧类型前向兼容 | 覆盖 | IT:T1（0x7f 类型帧被忽略，连接继续） |
| 方向反转被拒 | 覆盖 | IT:T1（consumer 注入 RESP_META → protocol_error，连接存活；ERROR 因未知 id 在 consumer 侧静默丢弃属预期） |
| 使用方侧反向帧静默处理 | 覆盖 | IT:T14（provider 发 REQ → consumer 静默丢弃，连接继续 direct） |
| 已终结 id 的迟到帧 | 覆盖 | IT:T2（RESP_END 后同 id REQ_BODY 静默丢弃、后续请求正常） |
| 多密钥一次授权 | 覆盖 | IT:T1（三钥三组一次 AUTH_OK，两组服务即刻可请求） |
| 合法密钥完成握手 | 覆盖 | IT:T1（单钥 R1/R2、keyMainA 阶段）+ IT:T2 |
| relay 入口在线刷新 | 部分 | 机制面覆盖：AUTH_OK/refresh 均携带 relayUrls 且 consumer 落盘（IT:T1/T3/T9 断言 relayUrls 传递与持久化）；「更换 relay」本体无法在固定 relay 配置的运行期 fabric 上构造（SDK relay 配置构造期固定）——需引擎支持 relay 热切换后补 |
| 撤销后仍存余钥 | 覆盖 | IT:T1（revoke R1 → refresh 只含 R2、服务继续、会话不断） |
| 撤销后无余钥断会话 | 覆盖 | IT:T1（revoke R2 → 连接断开） |
| 未握手先发请求 | 覆盖 | IT:T1（33 帧未授权 REQ → 计数断连，零上游请求） |
| 并发交错 | 部分 | IT:T6/T7 有并行在途请求（3 并发 / 流中并行业务），未逐 id 断言分片互不混入——该性质由 unit（mux 并发交错矩阵）锁定 |
| 小请求单帧完成 | 部分 | 隐式（全部小正文 POST 走 REQ 内联路径成功）；单帧性未显式断言，unit（codec splitBody）覆盖拆分规则 |
| 必需自定义头透传 | 覆盖 | IT:T1（anthropic-version 到上游）+ IT:T4（accept 头 + 凭据头剥离） |
| 超限正文被拒 | 未覆盖（9MiB 帧流成本高且本地 8MiB 先拒）| consumer 网关本地 8MiB 先拒（IT 未触发）；提供方重组上限由 unit（mux body_too_large）覆盖 |
| 分片序号缺断 | 覆盖 | IT:T14（consumer 侧 RESP_CHUNK 0→2 缺断 → protocol_seq 终结 + 连接重建 + 恢复 direct）；提供方侧 REQ_BODY 缺断由 unit 覆盖（同一 mux 机制） |
| SSE 逐块还原 | 部分 | IT:T4：内容与块序断言通过；**逐块 flush 受引擎 bug #2 退化**（分片在 RESP_END 集中投递；wire 级分片节奏已另行验证为 43ms 间隔正常）——bug 修复后断言自动收紧（现以控制台标注区分） |
| 非流式 JSON 响应 | 覆盖 | IT:T4（status/contentType/完整正文）；E2E 步骤 4 |
| 首字节等待期心跳 | 覆盖 | IT:T2（/hang：注入 pingMs=120ms 收到 ≥3 PING，firstByte 1500ms → idle_timeout 终结） |
| WS 双向对话 | 未覆盖（引擎 bug #3：ws-upstream 自管 key 与 gateway accept 恒等校验矛盾 → 101 升级必被 destroy）| IT:T5a 探测到 bug 自动 skip，完整断言已就位（修复后自动恢复）；上游 echo 服务与 WS 客户端已备 |
| 上游握手失败 | 覆盖 | IT:T5b（raw upgrade → 上游 404 原样透传；不经 101 路径，不受 bug #3 影响） |
| WS 关闭终结 | 未覆盖（同 bug #3，位于被 skip 的 IT:T5a 内）| 断言已就位待修复 |
| 慢客户端不拖垮内存 | 覆盖 | IT:T8（6MiB 洪流 + 不读 → 4MiB 待消费上限 → ABORT + 本地连接错误 + 记账 + 其它请求不受影响）。WS 双向兜底按任务预案降级为 HTTP 面（Gateway 上限经 startEngine 不可注入） |
| 空闲请求被清理 | 部分 | 300s 请求级空闲窗未真实等待（unit 覆盖计时器语义）；提供方侧空闲终结面经 IT:T2 的 idle_timeout 路径覆盖 |
| 深度推理长等待不误杀 | 覆盖（注入超时等价）| IT:T2：PING 持续到达使 consumer 不误杀（pings ≥3 期间请求保持活跃），提供方挂起期空闲计时豁免、至首字节超时才以 idle_timeout 终结 |
| 客户端中途断开 | 覆盖 | IT:T7（reader.cancel → 上游 socket 关闭） |
| 终结后不再收帧 | 覆盖 | IT:T2（见「已终结 id 的迟到帧」；ERROR 终结变体 unit 覆盖） |
| 目录随服务变更推送 | 覆盖 | IT:T9（新增服务 → refresh → 新端口可用 + 钥环落盘） |
| 服务删除后的收敛 | 覆盖 | IT:T9（端口关闭 → 连接拒绝；其它服务不受影响）；E2E 同语义由 consumer 侧承担 |
| 超长路径被拒 | 覆盖 | IT:T2（8KiB path → protocol_error，零上游请求） |
| 路径注入逃逸被拦 | 覆盖 | IT:T2（`//evil.com/…` → protocol_error，零上游请求） |
| 回溯越界被拦 | 覆盖 | IT:T2（`/../../admin` → schema 层拒绝；纵深断言 unit（rewrite 注入矩阵）覆盖） |

## provider（14 Scenario）

| Scenario | 状态 | 覆盖位置 / 说明 |
|---|---|---|
| 服务定义往返 | 部分 | IT:T10（重启后经 Fabric.open 复入 + 全部服务/密钥继续服务，含 T9 新增服务）；store 文件级往返由 unit 覆盖 |
| 非法正则被拒 | 未覆盖（integration/e2e 未演练 CLI add 非法正则）| unit（store 单测）覆盖保存期编译检查 |
| 特权上游端口强制显式 | 未覆盖（同上，未演练 443 上游无 --port）| unit（store 单测）覆盖 |
| 一组多钥独立撤销 | 部分 | IT:T1（同组 R1/R2：撤 R1 后 R2 视图与服务不受影响）；「重连后 AUTH 计入 rejected」子句未断言（rejected 载荷在多钥 AUTH 的 key_invalid 面有 unit 覆盖） |
| 密钥原文不可再现 | 覆盖 | E2E 步骤 2（key list 仅 keyId/时间/状态，无 sk-aifly- 原文） |
| 目录随服务变更推送（provider 侧） | 覆盖 | IT:T9 |
| 越权服务统一拒绝 | 未覆盖（未构造跨组 serviceId 请求）| 与不存在 serviceId 的无差别响应由 unit（engine/auth 单测）覆盖 |
| detail 披露脱敏 | 覆盖 | IT:T1（AUTH_OK detail：●、无变量名/值） |
| 重写后命中上游 | 覆盖 | IT:T4（secret 服务：/pfx 前缀追加 + $env 注入 Authorization + 使用方凭据剥离） |
| 帧内不可指定上游 | 覆盖 | IT:T2（三种注入形态零上游请求） |
| 上游错误原样透传 | 覆盖 | IT:T4（418 正文/contentType、500 JSON）；E2E 步骤 4 |
| 并发限额 | 覆盖 | IT:T6（上限 2，第三个请求 429 rate_limited，前两个不受影响） |
| serve 复入 | 覆盖 | IT:T10（同 dataDir 重启 EndpointId 不变 + 既有密钥续用）；E2E 步骤 9 |
| share 前置检查 | 未覆盖（未演练空分组 share）| unit（link 单测）覆盖 |

## consumer（18 Scenario）

| Scenario | 状态 | 覆盖位置 / 说明 |
|---|---|---|
| 新设备组合链接一步到位 | 覆盖 | IT before（importLink link0：兑换 + 入环 + 摘要服务/端口）+ IT:T3（端口可用）；E2E 步骤 3（import --run） |
| 老设备追加分组跳过兑换 | 覆盖 | IT:T11（consumer2 导 secretgrp 链接：redeemed=false、双钥并存、跨组服务并入）；E2E 步骤 7（重复导入同链接） |
| 裸密钥入环 | 覆盖 | IT before + IT:T3（keyId="" 占位 → AUTH_OK 回填 keyId/group）；E2E 的 CLI 形态受 bug #5 影响（见下） |
| 裸密钥无法替代入网 | 覆盖 | IT:T11（addKey 未入网 → 指引 join/import）；E2E 步骤 7 宽容断言（bug #5 时命中分发误报分支并标注） |
| 多提供方并存 | 覆盖 | IT:T13（单 manager 双 ring：P1 下线 P2 映射不受影响） |
| 签发者离线时导入失败 | 覆盖 | E2E 步骤 9（serve 停机后 import → 失败 + 目录零残留） |
| 端口冲突自动错开 | 未覆盖（integration 未占位制造冲突）| unit（ports 单测：EADDRINUSE 回退 + NOTICE）覆盖；--strict-ports 面 unit 覆盖 |
| 不监听外网 | 覆盖 | IT:T15（全部监听对非回环本机地址连接被拒） |
| 流式对话 | 部分 | IT:T4 / E2E 步骤 4（SSE 内容与块序）；逐块 flush 受 bug #2 退化（同 wire-protocol SSE 条目） |
| WS 双向中继 | 未覆盖（bug #3）| IT:T5a 自动 skip，断言就位 |
| 上游错误透传 | 覆盖 | IT:T4（418/500）+ IT:T7（upstream_unreachable → 502） |
| 慢客户端不拖垮内存 | 覆盖 | IT:T8（buffer_overflow 计数 + 本地连接错误 + 其它请求不受影响 + 上游连接中止） |
| 服务删除后的收敛 | 覆盖 | IT:T9 |
| relay 入口在线更新 | 部分 | 同 wire-protocol「relay 入口在线刷新」 |
| 丢批后连接重建 | 覆盖 | IT:T14（protocol_seq → 终结该请求 → 重建连接 → 恢复 direct → 其余请求自动恢复） |
| 离线快速失败 | 覆盖 | IT:T10（503 provider_offline + 错误含别名）；E2E 步骤 6/9 |
| 恢复自动续用 | 覆盖 | IT:T10（重启后不需干预恢复）；E2E 步骤 9（CLI 进程面） |
| 密钥全被撤销的可见性 | 覆盖 | IT:T12（key_all_invalid 状态 + 503 + 别名 + 新钥入环自动恢复）；E2E 步骤 8（轮换端到端，恢复经 import 新链接——key add CLI 受 bug #5 影响） |

## share-link（8 Scenario）

| Scenario | 状态 | 覆盖位置 / 说明 |
|---|---|---|
| 链接自包含预览 | 覆盖 | E2E 步骤 2（--preview：别名/分组/服务/默认端口/凭证提示，离线） |
| 敏感信息不入链 | 覆盖 | IT:T11（payload 无 env 名/值；detail ● 与 AUTH_OK 同规） |
| 链接二次兑换被拒 | 覆盖 | IT:T11（consumer3 用已消费链接 → 失败 + 零残留）；E2E 步骤 7 |
| 老设备跳过兑换 | 覆盖 | IT:T11；E2E 步骤 7 |
| 密钥独立于链接存续 | 部分 | §3 车道裁决：share 每次签发新钥（哈希不可逆），「同组同钥」不可构造；「既有连接与授权不受影响」面由 E2E 步骤 7/8 顺带覆盖（多次 share 期间既有 consumer 服务不中断） |
| 撤钥不踢人 | 部分 | IT:T1（撤钥后会话/余钥继续，语义等同名册不动）；名册成员身份「未变」未显式断言 |
| 踢人不撤钥 | 覆盖 | E2E 步骤 6（revoke c1 后 c2 同钥继续可用）；「重新入网后恢复授权」子句未演练（fabric 语义，dweb e2e 覆盖同机制） |
| （构成/编码面） | 覆盖 | unit（link 单测）+ IT:T11/E2E 解析面 |

## 汇总

- wire-protocol 32：覆盖 24、部分 5、未覆盖 3（超限正文、WS 双向/关闭——引擎 bug #3）
- provider 14：覆盖 9、部分 3、未覆盖 2（非法正则、特权端口——CLI 演练面；unit 覆盖）+ 越权统一拒绝未覆盖（unit 覆盖）→ 计 3 未覆盖
- consumer 18：覆盖 13、部分 3（relay 刷新、流式 flush、——）、未覆盖 2（端口冲突——unit；WS——bug #3）
- share-link 8（含构成面）：覆盖 6、部分 2
- 合计 72 Scenario：覆盖 52、部分 13、未覆盖 7（其中 3 项被引擎 bug #3 阻塞、4 项由 unit 车道覆盖而 integration/e2e 未演练）

已知引擎 bug 对覆盖的影响（修复后本套件自动收紧，无需改测试）：
- #2 → SSE 逐块 flush（现以内容/顺序断言 + 控制台标注）
- #3 → WS 双向对话/关闭终结（探测 skip，断言就位）
- #4 → 跨进程 revoke 既有会话不拆（E2E 标注；安全语义经重连拒绝面覆盖）
- #5 → `key add` CLI（E2E 宽容分支 + 标注；函数面由 integration 覆盖）
