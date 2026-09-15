# Tasks: hooks-lifecycle

> 实现顺序（Codex 评审 2026-09-15 R1 收敛）：v2 类型 → wire/detail → legacy/store →
> hook 契约 → rewrite/upstream → RPC → CLI/preset → UI → 测试。引擎任务不得先于
> 0.x 类型冻结开工。

## 0. canonical v2 领域类型（单源冻结）

- [x] 0.1 新建 lifecycle 领域类型模块：四槽（auth/headers/request/response）TS 类型 + zod schema + STAGE_FN_NAMES 四阶段常量 + 归一出站形 `{status, headers, body: AsyncIterable<Uint8Array>}`（headers.set 值仅字面量 string——动态值走 `$env:`/`$secret:` 间接引用或 ② 整段脚本）；frames/store/rpc-contract 一律 import 消费（传输/存储/契约面投影，禁止手写镜像）（单测：schema 往返 / 非法形状拒绝）

## 1. wire / detail 投影（v2 形状）

- [x] 1.1 `src/wire/frames.ts`：SERVICE_DETAIL_SCHEMA / SERVICE_ENTRY_SCHEMA 切四槽 v2（脚本/密钥注入位掩码 `●` 语义保持）；RESP_META 白名单不动；新增 ERROR_CODE `hook_failed`（单测：投影往返 / 掩码）
- [x] 1.2 `src/provider/detail.ts`：AUTH_OK/分享链接脱敏投影按 v2 槽位生成（单测：各槽掩码 / 非 Vue 形状拒绝）
- [x] 1.3 `src/provider/link.ts` + `src/consumer/join.ts`：分享 payload 携带 v2 条目；旧链接解码失败 → 报「分享链接格式已过期，请让提供方重新生成」（单测：旧 payload 报错文案）
- [x] 1.4 `src/consumer/store.ts`：keyring 按提供者记录逐条过滤——services 数组内不合当前 SERVICE_ENTRY 的条目丢弃（提供者记录与密钥保留）、发生丢弃即原子写回（写回失败仅日志不阻断内存视图）；文件级 JSON 非法维持既有语义。`src/wire/mux.ts` + `src/consumer/providers.ts`：AUTH_OK 帧**二阶段解析**——帧级 schema 先行（失败维持既有 schemaDropped 路径），载荷内 detail 投影宽松二阶段解析失败走 `onCatalogError(providerId, message)`（providerId 取自该 WireSession 的对端身份；会话保持 authed；**不触发普通帧丢弃路径**）；lastError 经通知通道呈现；保留旧视图期间继续接受后续 AUTH_OK，任一次成功同步覆盖视图并清错（单测：陈旧条目丢弃 + 写回 / 部分坏·全坏·写回失败矩阵 / detail 失败不经 schemaDropped 且会话 authed 且旧目录与映射保留 / 成功 AUTH_OK 清错 / 其它帧 schema 失败仍丢弃计数 / 下轮同步重建）

## 2. store schema v2 + legacy 模式

- [x] 2.1 `src/provider/store.ts`：STORE_FILE_SCHEMA 增 `version: 2`；服务槽位换 v2；normalize（headerRemove 去重小写等）按新槽重写（单测：v2 合法形状 / normalize）
- [x] 2.2 legacy 门禁：open 先裸读 JSON 判版本，≠2 → legacy 模式 store 对象（services/groups/keys 空视图 + `legacy: {serviceNames}` 元数据，不抛错）；**store 单点写入门禁**——除 legacy remove 外一切 services.json 域写方法（服务/分组/keys.issue/revoke/alias/meta）以 `legacy_readonly` 拒绝（StoreError code 扩展 + `src/app/errors.ts` 映射 INVALID_STATE + CLI 文案；RPC 与 CLI 调用面自然继承）；serve 启动 alias 写入在 legacy 态跳过不影响启动；`service remove <name>` 按原始文件条目过滤原子写回（**revision+1** 保 daemon watcher 判变、同名全删、meta/alias 字段语义保留——JSON 对象级透传，不保证字节布局/键序）；原始 services 清空 → 重建干净 v2 空库退出 legacy；非法 JSON / services 非数组维持 corrupt 报错（单测：legacy 进入 / 按名移除且名册刷新 / 清空重建 / 写入保护矩阵——服务·分组·keys·alias 经 RPC 与 CLI 双路 / 非法 JSON 仍 corrupt / alias 不丢）
- [x] 2.3 `src/provider/serve.ts` + `src/app/engine-host.ts` + `src/app/rpc-router.ts`：legacy 态 NOTICE 日志 + status 暴露 + services.list 返回最小失效壳（仅 name）；rpc-router 的 services/groups/keys 写操作经 store 单点门禁自然拒绝（RPC 呈现 INVALID_STATE，secrets 域独立不 gate）；CLI legacy 态呈现落 provider 域 `service list` 与全局 `status --verbose`（单测：RPC legacy 面 + services·groups·keys 拒绝与 secrets 放行 / CLI 输出）

## 3. hook 契约（阶段化）

- [x] 3.1 hook.ts 阶段化加载器：按 STAGE_FN_NAMES 发现（`discoverHooks` 输出 stages 矩阵）；①② ctx 增 `{method, path, headers}`；**① 三态契约**（string/Promise/AsyncIterable 订阅）平移；**② 对象返回** `{set?, remove?}`（`{}`=no-op）；绑定缺席/形状非法 → hook_failed（②③④）或 secret_missing 族（①）（单测：阶段矩阵 / 三态与对象两契约 / 缺席抛错分族）
- [x] 3.2 ③/④ 契约实现：onRequest ctx `{url, method, headers, body, signal}`、onResponse ctx `{status, headers, body, signal}`；返回形状校验（非法 → hook_failed）。形状冻结：② `set` 值必须 string、`remove` 必须 string[]，头数量/名称/值长度沿用 wire 帧资源上限（≤32 头/键 ≤1KiB/值 ≤8KiB），非法一律 hook_failed；④ `body` 接受 `ReadableStream | AsyncIterable`（归一层统一取消语义）（单测：形状校验 / 上限 / hook_failed 映射 / 消息脱敏）

## 4. rewrite / upstream 管道

- [x] 4.1 rewrite.ts 管道化：头链固定顺序 剥离→auth（三族 + bearer 单源）→headers.remove→headers.set（字面量 `$env:`/`$secret:` 平移）→②脚本增量（脚本胜）→防护头再过滤；host/path/SSRF 断言不动（单测：顺序 / 脚本胜 / $secret 缺失 secret_missing）
- [x] 4.2 upstream.ts 出站归一层：native fetch 与 ③ 脚本结果统一归一 `{status, headers, body: AsyncIterable}`；forwardHttp 消费循环改迭代器；绑定 request 脚本时跳过 probeConnect；`fetchImpl` 测试注入缝保留于原生路径；ws-upstream.ts 注释明示不进 request 阶段（单测：SSE 逐块 / abort cancel 传播 / probeConnect 跳过）
- [x] 4.3 ④ onResponse 插入：fetch 归一后、RESP_META 前调用；status/白名单内头/流式 body 局部覆盖；白名单外头忽略（单测：变换生效 / 白名单外忽略 / 204 无正文）
- [x] 4.4 hook_failed 全链路：engine.ts 异常分类（兜底 internal 之前识别脚本失败类）→ frames ERROR_CODE → `src/consumer/gateway.ts` ERROR_HTTP_MAPPING（穷举 Record）登记 + HTTP 生命周期分流（pending 阶段 → 502 JSON；流式中 → 关闭本地连接）（单测：engine 分类 / gateway 双阶段映射）

## 5. RPC 契约 + secrets 单源化

- [x] 5.1 rpc-contract.ts：SERVICE/REWRITE v2；hooks.list stages 正式 schema；provider status 暴露 legacy（单测：contract-types 全类型推导）
- [x] 5.2 SecretsStore.bearerPrefix 退役：secrets.json 条目语义 + SECRET_ENTRY_SCHEMA + `secrets.set` 输入移除该参；`secrets.list` 输出锁定为 `{secrets: [{name, createdAt?, updatedAt?}], count}`（contract 测试断言精确形状）；RPC `services.test` 输入从 secretName 改为 auth 槽草稿；连通测试（upstream-test）注入改读草稿 auth 槽；`hooks.list` 删除 fns 字段、只留 stages（contract-types / CLI / UI 测试锁定）（单测：注入路径 / test 输入 / list 形状 / stages-only / CLI secret 文案）

## 6. CLI + 内建脚本 + presets

- [x] 6.1 CLI：`service add` 旗标重映射（--secret→auth.secret；--header-set 值只收字面量与 `$env:`/`$secret:` 间接引用，脚本绑定单独 `--headers-script`）；`--hooks` 退役；service get/list humanize 按阶段；hooks list/get/run 按阶段语义（单测：services CLI 断言切 v2）
- [x] 6.2 内建脚本导出改名：codex/env/file/secret → 阶段名（codex 注释明确只读语义）
- [x] 6.3 presets：providers.json authHeader→auth；presetToServiceInput 直吐 v2（单测：preset 装配）

## 7. WebUI

- [x] 7.1 `lifecycle.ts` 概念模型：服务视图 ↔ 四槽互转（authSel/keep 退役；literal 族新增）
- [x] 7.2 ServiceForm「Request lifecycle」区：四阶段管线行（auth/headers 展开，request/response 折叠）；auth 编辑器（none/secret/script/literal + bearer）；HeaderKVEditor；阶段行脚本选择器按 stages 矩阵过滤
- [x] 7.3 detail 投影与徽章：Advanced 行、消费侧展开、摘要投影按阶段语义重写
- [x] 7.4 legacy 横幅：App.svelte + app.svelte.ts（provider status 脏区）+ Advanced 失效服务只读列表（仅移除）；SecretsDialog / secrets store 删除 bearerPrefix 控件与类型；locale（authpicker/hookscript 文案族 → lifecycle 口径）
- [x] 7.5 webui `tsc --noEmit` 通过

## 8. 验证与收尾

- [x] 8.1 全量门禁：vitest（基线 535 → 645/646，唯一红为用户 app:dev 占 8790 的环境红）+ tsc + webui typecheck + build + `openspec validate --strict hooks-lifecycle` 全绿
- [x] 8.2 交付前自走查（沙盒 HOME + agent-browser 真实浏览器）：本地可复现部分——新建本地 mock 上游服务走完四阶段配置与请求；v1 旧格式 services.json 验证失效横幅/移除重建路径（含带 alias 的旧文件，确认 meta 不丢）；旧 hook 脚本（authHeader 导出）被新 stages 矩阵正确排除并提示重写；Dashboard/Advanced/ShareWizard 三入口回归。外部网络部分（chatgpt.com codex 订阅 e2e）单独报告，不计入本地绿色证据
- [x] 8.3 README 服务生命周期章节更新 + openspec change 收口（归档待发布）（README 已含四阶段/legacy/CLI 破坏性清单章节；实现复核 R1-R4 闭环 6.4→6.8→7.4→8.2 零阻塞收口）
