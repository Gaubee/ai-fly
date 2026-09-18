# SPEC-COVERAGE — net-fly 正式 spec 逐 Scenario 覆盖自查

对照 `openspec/specs/net-fly/{wire-protocol,provider,consumer,share-link}/spec.md`
（opendweb-kernel-migration 归档合并后的正式版本，2026-09-18 重写）。

## 承载面换基说明（先读）

- **envelope 帧族已退役**：magic/REQ/RESP/PING/分片序号等帧级机制随
  opendweb-kernel-migration 退役。请求多路复用、分片保序、断线原序重放、发送侧
  反压、终态后迟到帧幂等，现由 opendweb 会话连续性内核（journal / RESET / 90s
  恢复窗口）承接。ai-fly 侧等价验证面为：
  - 真内核 e2e：`test/e2e/kernel-migration.test.mjs`（T1–T8）
  - SDK 生命周期测试（opendweb 仓库）：`packages/client-sdk/test/http-lifecycle.test.mjs`
  - unit 投影层：`test/unit/**`（fake-fabric / gateway 模拟）
- 旧 envelope 期集成套件 `test/integration/engine.test.mjs`（IT:T1–T15）已随迁移
  删除；本矩阵仅引用现存测试面：
  - **unit** = `test/unit/**`（vitest，按文件名+用例名）
  - **e2e** = `test/e2e/kernel-migration.test.mjs`（T1–T8）/ `test/e2e/cli.test.mjs`（单流分步）
  - **integration** = `test/integration/app.test.mjs`（webui/RPC 面）
  - **soak** = `test/e2e/sse-soak.test.mjs`（`AIFLY_SOAK=1` 门控，默认 skip）
- 已知引擎问题仅剩 **#4**：跨进程 revoke 不拆既有会话（cli e2e 标注；安全语义经
  重连拒绝面覆盖）。旧 #2/#3/#5 已随迁移后代码面消失。

标注口径：

- **覆盖** = 有自动化断言
- **部分** = 语义主面有断言，某一子句未断言（注明）
- **未覆盖（原因）** = 无断言，注明原因与替代面

## wire-protocol（17 Scenario）

| Scenario | 状态 | 覆盖位置 / 说明 |
|---|---|---|
| 混流共存 | 部分 | 会话复用面：ai-fly 控制面（`/_aifly/auth`、catalog-watch）与数据面（forward）在同一内核会话并存——e2e T1（真内核 AUTH+目录+转发同会话）+ unit engine（AUTH/目录与 forward 全链路共用会话）。「与其它应用 envelope 流量共存」本体是内核多流契约，ai-fly 侧不可构造 |
| 未知帧类型前向兼容 | 未覆盖（机制退役）| 帧类型枚举随 envelope 退役；前向兼容由内核会话版本协商承接（opendweb 侧）。ai-fly 控制面对未知路径/方法按 HTTP 语义处理（401/405——gateway unit forbidden_method） |
| 方向反转被拒 | 未覆盖（机制退役）| 帧方向约束随 envelope 退役；等价面 = 控制面仅接受约定方法/路径（gateway unit OPTIONS 405 + engine 未授权 401），无「回敬 ERROR 帧」面 |
| 使用方侧反向帧静默处理 | 未覆盖（机制退役）| 同上；静默丢弃语义由内核流终态幂等承接 |
| 已终结 id 的迟到帧 | 未覆盖（机制退役）| 内核终态后迟到数据零副作用由 opendweb continuity 测试锁定，ai-fly 侧无对应面 |
| 空闲请求被清理 | 部分 | 上游超时族存活：unit upstream「流中途停滞（120s 可配）→ idle_timeout 且中止上游」「连接期超时 → upstream_unreachable 零 fetch」。300s 请求级双端空闲窗与 PING 活度随 envelope 退役，由内核恢复窗口承接 |
| 深度推理长等待不误杀 | 部分 | 挂起不误杀面：e2e T2（恢复窗口内挂起、续传完成）+ unit upstream「上游迟滞后正常完成」；「至首字节超时以 idle_timeout 终结」子句经流中途停滞同码路径覆盖，首字节等待期超时未单独钉 |
| 客户端中途断开 | 覆盖 | e2e T5（本地断开 → per-request cancel 全链 → 上游关闭）+ unit upstream（ABORT → 中止上游）+ gateway unit（流中客户端断开） |
| 终结后不再收帧 | 未覆盖（机制退役）| 同「已终结 id 的迟到帧」；内核终态幂等（opendweb 侧） |
| 脚本失效以 hook_failed 终结 | 覆盖 | unit upstream（③ 构造期失效/流中途失败 → hook_failed 固定脱敏、零 fetch）+ rust-fetch unit + providers unit（消费端双分支） |
| 目录随服务变更推送 | 覆盖 | unit engine「服务变更推送：向组新增服务进入 refresh 视图（全量替换语义）」 |
| 服务删除后的收敛 | 覆盖 | gateway unit「服务删除：关端口 + 终结在途（fetch 拒绝/ABORT）」 |
| 四槽投影脱敏下发 | 覆盖 | detail unit（四槽掩码全矩阵）+ engine unit AUTH_OK 脱敏 + join unit（decode v2 四槽条目往返） |
| 跨版本目录被安全拒绝 | 未覆盖（无断言）| 机制在位（providers.ts 二阶段目录失败回调——保留旧视图、本地错误态、不影响其它提供者），无自动化断言；旧覆盖随 envelope IT 退役未重建——后续补测项 |
| 超长路径被拒 | 覆盖 | gateway unit（path > 4 KiB → 400 protocol_error 零转发；gateway.ts:378 本地拒绝） |
| 路径注入逃逸被拦 | 覆盖 | unit upstream「//evil.com → protocol_error 零上游请求」+ rewrite unit（origin 断言拒绝矩阵） |
| 回溯越界被拦 | 覆盖 | unit upstream「/../../admin → protocol_error」+ rewrite unit（回溯拒绝）；schema 层 `.`/`..` 段拒绝在 gateway 请求构造 |

## provider（37 Scenario）

| Scenario | 状态 | 覆盖位置 / 说明 |
|---|---|---|
| 服务定义往返 | 覆盖 | store unit「添加后重启进程完整恢复（v2 标记）」+ cli e2e（同 dataDir 重启续用） |
| 非法正则被拒 | 覆盖 | store unit「语法非法正则被拒且既有服务不受影响」「灾难性正则接受（无执行面）」 |
| 特权上游端口强制显式 | 覆盖 | store unit「https 443 未声明 defaultPort → 拒绝 / 显式后接受 / http 80 同 / 高位端口缺省继承」 |
| 旧版本配置判失效 | 覆盖 | store-legacy unit（legacy 模式全矩阵：NOTICE、逐条移除、重建 v2 空库） |
| 一组多钥独立撤销 | 覆盖 | engine unit「双钥在线撤一钥：refresh 视图剔除、会话不断」+ store unit（撤钥幂等、重开保留）+ engine unit「混合钥 AUTH：rejected 携带 key_invalid」 |
| 密钥原文不可再现 | 部分（spec 已漂移）| 现行语义为 Owner 裁决 2026-09-13「key 原文随库可复制」（store unit 钉死），取代旧「仅哈希存储、签发后不可再现」条款；面板/列表面不回显原文仍成立（integration app「分组/密钥管理（issue 原文一次性）」）。spec 文本待后续 spec-sync 修订 |
| 目录随服务变更推送 | 覆盖 | 同 wire-protocol 同名行（engine unit） |
| 越权服务统一拒绝 | 覆盖 | engine unit「未授权/未知 serviceId 统一 unknown_service（防枚举）」 |
| detail 披露脱敏 | 覆盖 | detail unit（auth.secret/script/literal、headers.set 引用、四槽掩码）+ engine unit AUTH_OK（●、无变量名/值） |
| 断线恢复不重 AUTH | 覆盖 | e2e T2（SSE 中途断线续传：授权延续、在途原序完成——sessionId 内核级稳定）+ engine unit（session 级授权缓存） |
| provider 重启 | 覆盖 | e2e T3（REQUEST_STATE_LOST → 在途 504 / 新请求 503 → 重建重 AUTH）+ cli e2e 末步（重启自动恢复） |
| 重写后命中上游 | 覆盖 | unit upstream「GET 200：上游收到重写后 URL 与 Host」「POST：$env 注入 authorization」+ engine unit「授权服务：上游收到重写后请求与 $env 凭据」+ e2e T1 |
| 帧内不可指定上游 | 覆盖 | unit upstream 路径注入双钉（零上游请求）+ rewrite unit origin 断言；HTTP 投影无上游字段，上游 URL 仅来自服务配置 |
| 上游错误原样透传 | 覆盖 | unit upstream「上游 404 原样透传（status+正文+contentType）」+ gateway unit + cli e2e（418 步骤） |
| 转发管线回归 | 覆盖 | hook-stages unit（onRequest 接管/局部覆盖/透传）+ unit upstream（预设模式整段接管族）+ e2e T1 |
| 并发限额 | 覆盖 | limits unit（并发计数/release 回落/分组独立/零成本拒绝）+ engine unit「并发限额 1：第二在途 rate_limited」 |
| serve 复入 | 覆盖 | cli e2e（同 dataDir 重启 EndpointId 不变、既有密钥续用） |
| share 前置检查 | 覆盖 | link unit（分组不存在/空分组/relay 未配置警告） |
| 面板增删密钥 | 覆盖 | integration app「密钥库往返：set/list/remove；值绝不跨 RPC；文件 0600」 |
| 密钥解析与缺失 | 覆盖 | secrets unit + engine unit「$secret 全链：命中注入完整头值；删除后 secret_missing（信息不含名字）」+ unit upstream（命中/未命中零 fetch） |
| 默认最便宜模型测试 | 覆盖 | upstream-test unit「模型缺省：api.json 定位 provider 取 priced chat 最低价 / upstream 主机命中」 |
| custom 上游探测回退 | 覆盖 | upstream-test unit「清单不可用且未指定模型 → 先探测 /models」「自定义上游探测成功 → 首选便宜档」 |
| 裸 key 默认可用 | 覆盖 | store unit「bearerPrefix 退役：值为原样存储」+ upstream-test unit「auth 草稿三族 + bearer 开关」 |
| 有键分组不可删 | 覆盖 | store unit「removeGroup：有未撤销密钥拒绝（conflict），撤销后可删」 |
| 中转站无 models.dev 条目 | 覆盖 | upstream-test unit「upstream 主机命中 api.json（无显式 api 精确匹配时）」「清单不可用 → 探测回退」 |
| 阶段按序组装 | 覆盖 | hook-stages unit「STAGE_FN_NAMES 四阶段常量与管线顺序冻结」+ 槽形状矩阵 |
| 脚本增量胜过声明式 | 覆盖 | hook-stages unit（headers 槽 remove → set → 整段 script 增量组合） |
| onRequest 接管出站并流式回传 | 覆盖 | hook-stages unit + unit upstream「整体接管：跳过 probeConnect、零原生 fetch；ctx{url,method,headers,body,signal}」+ codex-hook unit ③ |
| onResponse 改写响应 | 覆盖 | hook-stages unit（response 槽）+ unit upstream「局部覆盖：status/头/流式 body 变换」「{} 返回 = 透传」 |
| 脚本失效的错误归置 | 覆盖 | unit upstream（③ 构造期失效 → 固定脱敏文案零 probe 零 fetch；流中途失败分族）+ rust-fetch unit（exit≠0/坏 meta/spawn ENOENT 指引/预 abort 宿主存活） |
| 预设模式整段接管 | 覆盖 | preset-mode unit + unit upstream（整段接管/部分覆盖回退 js-backend-fetch）+ codex-hook unit（①②③ 全生命周期，含 CODEX_HOME 隔离） |
| 预设模式与逐槽互斥 | 覆盖 | preset-mode unit「互斥：hooks 与 auth / request 同现一律 invalid」 |
| 顶层键 strict | 覆盖 | hook-stages unit（LIFECYCLE_SLOTS_SCHEMA 未知字段整体拒绝）+ store unit「四槽非法形状拒绝」 |
| 经 rust-fetch 转发流式请求 | 覆盖 | rust-fetch unit「往返：meta + 体 + 流式回传」+ codex-hook unit ③（stub sidecar 全通） |
| 二进制缺失或协议失败 | 覆盖 | rust-fetch unit（spawn ENOENT 安装指引 / exit≠0 / 坏 meta / 顶层 null·数组·标量 / meta 形状越界 / abort SIGKILL） |
| 服务停用目录剔除 | 覆盖 | lifecycle unit + store unit「groupServices 排除停用服务（目录/分享链接视图传导）」+ integration app（setRunning） |
| 环级开关叠加 | 覆盖 | lifecycle unit + integration app「setProviderRunning 环开关（providers[].enabled + 叠加语义）」+ consumer lifecycle-watch unit（环级停用传导全部监听关；恢复时单服务停用保持） |

## consumer（27 Scenario）

| Scenario | 状态 | 覆盖位置 / 说明 |
|---|---|---|
| 新设备组合链接一步到位 | 覆盖 | join unit（兑换 + 入环 + 服务种子）+ cli e2e 步骤 3（import --run：摘要 + 端口可用） |
| 老设备追加分组跳过兑换 | 覆盖 | join unit「老设备：零兑换、密钥直接入环（多钥并存）」+ cli e2e 步骤 7 |
| 裸密钥入环 | 覆盖 | join unit addKey「已入网：入环生效（幂等），keyId/group 留待 AUTH_OK 回填」+ cli e2e 步骤 8（key add 恢复） |
| 裸密钥无法替代入网 | 覆盖 | join unit addKey「未入网：报错并指引」+ cli e2e 步骤 7（c3 对 bogus provider key add 报错） |
| 多提供方并存 | 覆盖 | providers unit「ProviderManager：P1 离线不影响 P2 路由」 |
| 签发者离线时导入失败 | 覆盖 | join unit「兑换失败：整体回收不留半初始化」+ cli e2e 步骤 7（已消费链接 → 失败 + 零残留） |
| 旧格式链接明确报过期 | 覆盖 | link unit + join unit（v1 形状 → 「分享链接格式已过期」）+ cli e2e（坏链接 exit 1） |
| 钥环陈旧条目自愈 | 覆盖 | consumer/store unit「陈旧服务条目逐条过滤：部分坏丢弃、其余/密钥/记录保留、原子写回 + applyCatalog 全量重建」 |
| 端口冲突自动错开 | 覆盖 | ports unit（listenWithFallback 冲突矩阵）+ gateway unit「端口被占自动错开：NOTICE 标注」+ actual-ports unit（监听回写/修剪） |
| 不监听外网 | 覆盖 | ports unit + gateway unit「仅绑定 127.0.0.1：非回环接口连接被拒」 |
| 流式对话 | 覆盖 | gateway unit「SSE 逐块顺序还原（含 data: [DONE]）」+ e2e T1（真内核流式）+ cli e2e 步骤 4 |
| WS 双向中继 | 覆盖 | gateway unit（101 双向 echo CLOSE / 握手失败 404 透传 / accept 自管 key）+ e2e T4/T6（真内核 keepOpen 字节隧道） |
| 上游错误透传 | 覆盖 | gateway unit「status/正文/contentType 原样透传」+ unit upstream 404 + cli e2e（418） |
| 慢客户端不拖垮内存 | 部分 | gateway unit 接收侧兜底（本地待消费缓冲达限 → ABORT + 记账 + 连接错误关闭；限额内不误伤）——本地兜底钉死；「内核 journal 反压暂停上游」本体是 opendweb 内核契约（SDK 侧测试），ai-fly 侧不可注入观测 |
| 脚本失效的本地观感 | 覆盖 | providers unit「hook_failed HTTP 生命周期双分支（pending → 502 脱敏 JSON；流式中 → 本地连接错误终结）」 |
| SSE 中途断线原序续传 | 覆盖 | e2e T2（真内核：已交付不重复、原序到达、上游不重发——副作用恰好一次）+ sse-soak（门控浸润） |
| WS 三态 | 覆盖 | e2e T4（keepOpen 隧道三态）+ gateway unit（closeByPeer / abort 分支） |
| 服务删除后的收敛 | 覆盖 | gateway unit「服务删除：关端口 + 终结在途」 |
| relay 入口在线更新 | 部分 | relayUrls 传递与落盘：providers unit（createFabricSessionFactory relay 透传）+ gateway unit（AUTH_OK 落盘）；「更换 relay 后重连使用新入口」本体无法在运行期固定 relay 配置上构造（SDK relay 构造期固定）——引擎支持 relay 热切换后补 |
| 丢批后连接重建 | 部分（机制退役）| 分片序号缺断检测随 envelope 退役（protocol_seq 仅存错误码映射表）；等价语义「流/会话不可信 → 重建连接、其余服务自动恢复」经 e2e T3（REQUEST_STATE_LOST → 重建 → 恢复）+ providers unit（dead → 会话重建重 AUTH）承载 |
| 离线快速失败 | 覆盖 | gateway unit「503 provider_offline 错误体含别名」+ providers unit + cli e2e 步骤 6 |
| 恢复自动续用 | 覆盖 | e2e T3 + cli e2e 末步（重启后不需干预自动恢复） |
| 密钥全被撤销的可见性 | 覆盖 | providers unit（AUTH 403 → key_all_invalid 状态）+ engine unit「仅剩钥也被撤：授权失效 + 断传输」+ cli e2e 步骤 8（轮换端到端 + key add 自动恢复） |
| 恢复窗口内瞬断不直达 | 覆盖 | providers unit「recovering：状态 offline 但 forward 不快速失败（挂起）」+ e2e T2 |
| 恢复窗口耗尽 | 覆盖 | providers unit「dead：状态 offline + forward 快速失败 + 会话重建重 AUTH」 |
| 停用-恢复往返 | 覆盖 | lifecycle-watch unit（外部停用/启用经 watch 传导；停止后不再响应）+ gateway unit「setServiceEnabled 热启停：stop 关端口幂等、start 按端口偏好恢复」+ integration app（setRunning/remove + 停用可复活） |
| forget 真删 | 未覆盖（无断言）| CLI 面在位（`services rm <provider>` = forget：keyring + fabric 身份移除，src/cli/commands/consumer/services.ts）；无自动化断言——integration 覆盖的是单服务 remove（修剪/可复活），provider 级真删未演练——后续补测项 |

## share-link（7 Scenario）

| Scenario | 状态 | 覆盖位置 / 说明 |
|---|---|---|
| 链接自包含预览 | 覆盖 | link unit（preview 摘要，零网络）+ cli e2e 步骤 2（--preview）+ integration app（坏链接 → INVALID_INPUT 离线 preview） |
| 敏感信息不入链 | 覆盖 | link unit「敏感信息不入链：无 env 变量名、无其它分组引用」 |
| 链接二次兑换被拒 | 覆盖 | cli e2e 步骤 7（consumer3 新设备用已消费链接 → 失败 + 零残留）；fabric 令牌一次性由内核承接 |
| 老设备跳过兑换 | 覆盖 | join unit + cli e2e 步骤 7（重复导入：零兑换、双钥并存） |
| 密钥独立于链接存续 | 部分 | link unit「每次 share 签发新钥（原文不可再现；旧钥不受影响）」；「同组同钥」不可构造（签发语义）；既有连接不受多次 share 影响由 cli e2e 步骤 7/8 顺带覆盖 |
| 撤钥不踢人 | 部分 | engine unit「双钥在线撤一钥：会话不断、余钥视图继续」（语义等同名册不动）；名册成员身份「未变」未显式断言（fabric 层语义） |
| 踢人不撤钥 | 部分 | cli e2e 步骤 6（revoke 成员 c1 → 重启后 503 provider_offline）；同钥 c2 不受影响经步骤 8 在线状态隐式体现（无显式断言）；「重新入网后恢复授权」未演练（fabric 语义）；已知 #4：跨进程 revoke 不拆既有会话（e2e 标注） |

## 条款级补充覆盖（requirement 文本子句，无独立 Scenario 行）

| 条款 | 状态 | 覆盖位置 |
|---|---|---|
| 鉴权按 session_id 缓存；同 peer 异 session 不继承授权 | 覆盖 | engine unit（同 peer 新 session AUTH 前 forward/watch 均 401；自行 AUTH 后独立生效；B 全无效只失效 B；watch 失效/LRU 逐出即刻唤醒）+ e2e T7 |
| 对端取消 → provider 秒停上游（含预中止） | 覆盖 | engine unit（/stall abort <3s；预中止零上游触达含 TCP 连接计数 + 有界收口）+ e2e T8（gated 上游无头形态）+ consumer providers（abortKey/abortFetch 接线）+ SDK http-lifecycle（opendweb 侧 writer 三态/head 等待期 abort） |
| 错误码集合稳定（ERROR_CODE 枚举 + HTTP 映射穷举） | 覆盖 | providers unit「错误码 → HTTP 映射」+ src/shared/http-errors.ts Record 穷举（typecheck 锁定） |
| 发送侧 bufferOverflows 退役（观测面改内核 journalBytes） | 覆盖 | 迁移设计条款；本地兜底面见 consumer「慢客户端」行 |

## 汇总

- wire-protocol 17：覆盖 8、部分 3、未覆盖 6（其中 5 项为帧族机制随内核迁移退役——等价保证由 opendweb 内核契约承接；1 项跨版本目录为机制在位无断言）
- provider 37：覆盖 36、部分 1（密钥原文条款 spec 已漂移——现行可复制语义为 Owner 裁决）
- consumer 27：覆盖 23、部分 3（慢客户端内核反压面、relay 热切换不可构造、丢批机制退役）、未覆盖 1（forget 真删——CLI 在位无断言）
- share-link 7：覆盖 4、部分 3
- 合计 88 Scenario：覆盖 71、部分 10、未覆盖 7

后续补测项（非发布阻塞）：

1. 跨版本目录安全拒绝（providers.ts 二阶段失败回调）补确定性单测
2. `services rm <provider>`（forget 真删）补 e2e/unit 断言
3. 踢人不撤钥的「c2 同钥继续可用」显式断言（现隐式）
4. spec 文本与实现的已漂移条款，下期 spec-sync 修订：密钥原文可复制裁决、wire-protocol 帧族条款重写为内核承载口径
