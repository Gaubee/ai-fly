# Change: hooks-lifecycle

## Why

WebUI 的服务配置界面针对性过强、缺少通用性（Owner，2026-09-14）：认证配置整体锚死在
`rewrite.headerSet["authorization"]` 这一个键上——AuthSel 四族模型、keep 透传哨兵、
`fns.includes("authHeader")` 门控（auth-source.ts / AuthSourcePicker / ServiceForm 三处）、
「key injected」徽章，全是围绕单一认证头的特殊面；而 headerRemove、非 authorization 的
headerSet、hostHeader 等改写能力在界面上**只读不编辑**（passthrough 透传）。

hooks 子系统的正确抽象是**生命周期**（Owner 裁决，2026-09-14）：hook.ts 头注释早已把
`onRequest/onResponse` 列为预留锚点，但从未实现；出站 fetch 替换在 upstream.ts 只有
测试注入缝（`fetchImpl`），无配置面。界面不应对「认证头」做专门设计，而应对
「生命周期能做的事情」做设计，心智模型即：

```
onResponse(onRequest(onRequestHeaders(onRequestBearerAuthentication(...))))
```

配套裁决（Owner，2026-09-15）：**不做向下兼容与迁移，一步到位**。版本号管理：旧配置
判失效、提醒用户移除重加，界面绝不因旧/坏配置起不来。

## What Changes

### canonical v2 领域类型先行（实现顺序的第一步）

四槽形状在单一模块冻结（TS 类型 + zod schema 单源）：引擎（hook/rewrite/upstream/
store）、wire 投影（frames/detail）、RPC 契约、CLI、WebUI 全部**从该模块 import
消费**——frames/store/rpc-contract 只做传输面/存储面/契约面投影（复用基础对象，
禁止手写镜像）。后续任务顺序：**v2 类型 → wire/detail 投影 → legacy/store →
hook 契约 → rewrite/upstream 管道 → RPC → CLI/preset → UI → 测试**。

### 生命周期模型（配置 schema v2）

四段管线（路由解析与 wire 入站剥离维持非可配置前置，不属阶段）：

| 阶段 | 配置槽 | 职责 |
|---|---|---|
| ① onRequestBearerAuthentication | `service.auth` | 专管 Authorization 头取值 |
| ② onRequestHeaders | `service.headers` | 通用头 K-V 处理 |
| ③ onRequest | `service.request` | 承接请求体、返回响应体（整体接管出站） |
| ④ onResponse | `service.response` | 响应后处理 |

```
service: {
  ..., upstream, routes, match, defaultPort, enabled,
  auth?:     { secret: name } | { script: name, args? } | { literal: value }（+可选 bearer?: boolean）
  headers?:  { remove?: string[], set?: Record<string, string>, script?: { name, args? } }
  request?:  { script: name, args? }
  response?: { script: name, args? }
  rewrite?:  { host?, pathPrefixStrip?, pathPrefixAppend? }   // 瘦身：头字段全部迁出
}
```

顶层 `hooks: "<script>"` 字段退役：每阶段槽直接绑定脚本。

**bearer 单源化**：`auth.bearer` 是唯一的 Bearer 前缀开关；SecretsStore 条目的
`bearerPrefix` 字段**退役**（`secrets.set` 不再接受；secrets.json 条目语义、
SECRET_ENTRY_SCHEMA、密钥面板控件同步移除）。连通测试（provider-local）注入路径
与 RPC `services.test` 输入改为 auth 槽草稿（secret 引用 / 脚本绑定 / 字面量 +
bearer 开关），不再接受 secretName 单字段。

**字面量间接引用语义平移**：`headers.set` 与 `auth.literal` 的字面量值保留
`$env:<VAR>` / `$secret:<name>` 请求期解析语义（空/未设置 → 该头省略；
`$secret:` 缺失 → `secret_missing`），与既有 headerSet 语义一致。

### onRequestHeaders 顺序冻结

头处理固定顺序：`入站剥离（DEFENSIVE_STRIP）→ auth 值注入 → headers.remove（声明）
→ headers.set（声明）→ ② 脚本增量（脚本 remove 后 set，**脚本胜**）→ 防护头再过滤`
（host/hop-by-hop/content-length 规则重放；contentType 折叠规则沿用）。同名头
last-wins（字典语义）。**② 脚本返回契约**：`{set?, remove?}` 对象（同步或
Promise，`set` 值必须 string、`remove` 必须 string[]，头数量/名称/值长度沿用
wire 帧资源上限——≤32 头/键 ≤1KiB/值 ≤8KiB，非法一律 `hook_failed`），`{}` 为
合法 no-op。**① 仅有的三态契约**（string | Promise | AsyncIterable 订阅）保留于
auth 阶段。

### ③/④ 运行时契约冻结

- **ctx 超集**：所有阶段 ctx 含既有 `{ homedir, args, secrets, env }`；①② 附
  `{ method, path, headers }`；③ 为 `{ url, method, headers, body: Uint8Array,
  signal }`；④ 为 `{ status, headers, body: AsyncIterable<Uint8Array>, signal }`。
- **③ onRequest 返回**：`{ status: number(200–599), headers: Record<string,string>,
  body?: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> }`（status 限
  200–599——1xx 非最终响应，越界即形状非法 → `hook_failed`；Node Response 同域）；
  body 缺省 = 空流（204/304 等无正文状态合法）。
- **出站归一层**：原生 fetch 结果与脚本结果统一归一为
  `{ status, headers, body: AsyncIterable<Uint8Array> }`，forwardHttp 消费循环只认
  归一形（不再"包装 fetchImpl"；`fetchImpl` 测试注入缝在原生路径保留）。绑定
  request 脚本时**跳过 probeConnect 连接期探测**（连接语义归脚本）。
- **④ onResponse 返回**：`{ status?, headers?, body? }` 局部覆盖（body 接受
  `ReadableStream | AsyncIterable`——归一层统一取消语义）；头键小写化、
  last-wins，可写范围限 RESP_META 白名单三头 + `content-type`（引擎投影至
  RESP_META 的独立 contentType 字段；status 204/304 时 contentType 归一为空）；
  ③ 返回 headers 中的 `content-type` 同样投影。
- **abort 传播**：引擎中止 → 归一迭代器 cancel（ReadableStream 走 cancel，
  AsyncIterable 调 return()），脚本流被取消。
- **错误映射**：新增 wire 错误码 `hook_failed`——②③④ 脚本缺席（绑定声明但导出
  缺失）、抛错、返回形状非法、流中途失败均归此码（消息脱敏，不含脚本路径与返回值）。
  ① 脚本失效与任何阶段的 `$secret:` 字面量间接引用缺失沿用 `secret_missing` 族。
  **全链路**：engine 异常分类不吞（兜底 `internal` 之前先识别脚本失败类）→ wire
  ERROR 帧新错误码 → 消费侧 gateway 映射（穷举 Record 登记，wire enum 保证消费
  侧不会收到未知码）→ 本地 HTTP 生命周期拆分：**RESP_META 尚未下发时**失败 →
  502 + 脱敏 JSON；**已进入流式后**失败 → 关闭本地连接终结（无法回退状态码，
  观感与上游流中断一致）。三处 + 测试同轮落地。

### 版本门禁与 legacy 模型（无迁移）

store 文件加 `version: 2`。`ProviderStore.open` 改为**先裸读 JSON 判版本**：
version 缺失或 ≠2 → 进入 **legacy 模式**（不抛错、非 corrupt 路径）：

- legacy store 对象：`services/groups/keys` 视图为空 + `legacy: { serviceNames: string[] }`
  元数据；watch 语义保留；daemon 正常启动、日志 NOTICE；RPC status 暴露 legacy 态。
- **写入安全边界（store 单点门禁）**：legacy 门禁落在 **ProviderStore 写方法层**
  ——除 legacy `service remove` 外，一切 services.json 域写操作（服务 add/save、
  分组、**分享密钥 keys.issue/revoke**、alias/meta）统一以 `legacy_readonly`
  拒绝（StoreError code 扩展 + RPC 映射 INVALID_STATE + CLI 用户文案），RPC 与
  CLI 调用面自然继承、无旁路；serve 启动期的 alias 写入在 legacy 态跳过（日志
  提示，不影响启动）；**secrets.json 为独立文件、不受 legacy 门禁**（密钥面板
  照常读写——注意区分：secrets = 上游凭据库，keys = 面向使用方的分享密钥，
  后者存 services.json、受门禁）。
- `service remove <name>` 在 legacy 模式下按**原始文件条目**过滤写回（原子写；
  **revision+1**——daemon watcher 以 revision 判变，不变则内存 legacy 名册不刷新；
  同名条目全部删除；`services` 字段非数组 → 按损坏处理；meta/alias 等其余字段
  **语义保留**——JSON 对象级透传（未知/未来字段原样携带），不承诺字节级布局与
  键序）。
- 原始 services 数组清空后 → 文件重建为干净 v2 空库（`{version:2, revision+1,
  services:[], groups:[], keys:[]}`），legacy 态退出。**groups/keys 不保留**（破坏性：
  密钥需重发、分享链接需重生成，见破坏性清单）。
- 真·损坏（非法 JSON / services 非数组）维持既有 corrupt 报错路径。

### wire / 消费侧波及（同版本约束）

- `src/wire/frames.ts` 的 `SERVICE_DETAIL_SCHEMA` / `SERVICE_ENTRY_SCHEMA` 与
  `src/provider/detail.ts` 脱敏投影切换为四槽 v2 形状（脚本/密钥注入位照旧掩码
  `●`）。
- **provider/consumer 同版本约束**（开发期 trunk 约定）：目录投影形状变更后，两端
  运行不同版本会出现解码失败——不做双形状兼容，文档明示两端同步升级；使用方对
  detail 投影解析失败视为**该提供者目录同步失败**（保留旧视图与映射、本地错误
  提示，不影响其它提供者）。
- 消费侧 keyring：**逐提供者记录**过滤——services 数组内不合当前 SERVICE_ENTRY
  解析的陈旧条目丢弃（提供者记录与密钥保留）；发生丢弃即原子写回；文件级 JSON
  非法维持既有告警/损坏语义。自愈：下轮 AUTH_OK 目录同步全量重建该提供者服务
  视图。配套：mux/consumer 侧对 detail 解析失败新增**目录同步错误回调**（保留
  旧视图 + 本地错误态呈现，不再静默丢弃 schemaDropped）。
- 旧 `aifly1.` 分享链接：payload 解码失败 → 明确报错「分享链接格式已过期，请让
  提供方重新生成」（不迁移）。

### 契约 + RPC

- `SERVICE/REWRITE` schema v2 四槽；`hooks` 字段移除。
- `hooks.list` 返回**阶段矩阵**（`stages: ("onRequestBearerAuthentication" |
  "onRequestHeaders" | "onRequest" | "onResponse")[]`，正式 schema），UI 按阶段过滤。
- provider status/store 面暴露 `legacy: { serviceNames: string[] } | null`；
  legacy 态下 `services.list` 返回最小失效壳（仅 name，供移除列表渲染）。
- 消费侧 detail 投影同步新形状，脚本对象照旧掩码 `●`。

### CLI + 内建脚本 + presets

- `service add` 旗标重映射：`--secret` 糖 → `auth.secret`；`--header-set/
  --header-remove` → `headers.set/remove`（值只收字面量与 `$env:`/`$secret:`
  间接引用——逐头脚本对象协议已删除；脚本绑定单独落在 `headers.script`）；
  `--hooks` 退役；`service get/list` humanize 按阶段输出；`hooks list/get/run`
  输出与参数按阶段语义调整；legacy 态呈现落在 provider 域 `service list` 与全局
  `status --verbose`（失效服务名 + 移除路径提示，不新增命令）。README 更新时
  明示：**旧 hook 脚本需按新运行时契约重写**——不只是改导出名，ctx 扩展为请求
  级、③/④ 返回对象形状与流取消语义均为新面。
- 内建 codex/env/file/secret 四脚本导出名改造（codex 保持只读 auth.json——
  2026-09-14 会话裁决：ai-fly 永不写凭据文件）。
- preset.authHeader → preset.auth（包内随发数据直接改，无存量）；
  `presetToServiceInput` 直吐 v2 槽位。

### WebUI（ServiceForm 双入口架构不变，页面层零改动）

- 新「Request lifecycle」管线区：四阶段纵向管线行（编号 + 连接线）；auth/headers
  默认展开（二八高频），request/response 折叠收纳。
- AuthSourcePicker 演进为 auth 阶段编辑器：none | secret | script | literal
  （新增手填，keep 哨兵退役）；「选择器 + 管理弹窗」模式复用；密钥选择器改写
  `auth.secret`（不再写 `$secret:` 进 rewrite）。
- 新通用 HeaderKVEditor（set 行编辑 + remove 列表），模板取自 PATH ROUTES 行编辑器。
- 「key injected」徽章、humanizeValue、locale 文案同步落地。
- **legacy 横幅**：App.svelte 布局层 + app.svelte.ts（provider status 脏区）+
  Advanced 服务列表联动——顶部横幅 + 失效服务只读列表（仅移除按钮）。

## Non-goals

- 任何形式的配置迁移 / normalize（Owner 裁决 2026-09-15）。
- provider/consumer 跨版本目录兼容（同版本约束，见上）。
- WS 升级路径的 onRequest 接管（①②阶段对 WS 生效，出站仍原生 WebSocket）。
- RESP_META 白名单扩宽（onResponse 增发头 = 未来 wire 变更）。
- 脚本热重载 / VM 隔离（require 缓存语义保留，改脚本需重启）。
- ① 订阅流的强制终止：disposeHookSubscriptions 以 return() + 300ms 竞速回收；
  挂起在内部 await 的非合作迭代器可能继续运行（脚本为任意用户代码，沙箱外
  无法保证协作式中止——与热重载同类的已知边界）。

## Impact

- 代码面：`src/provider/lifecycle v2 类型单源（新）、{hook,rewrite,upstream,
  store,ws-upstream,secrets,detail,serve}.ts`、`src/wire/frames.ts`、
  `src/consumer/{join,store}.ts`、`src/shared/rpc-contract.ts`、
  `src/app/rpc-router.ts` + `engine-host.ts`、`src/cli/commands/provider/*`、
  `hooks/*.cjs`、`presets/providers.json`、`webui/src/{App.svelte,components,stores,
  lib}`、locale。
- 测试面：新增（v2 类型 / 管道顺序 / legacy 门禁与移除重建 / 掩码脱敏 / 出站
  归一层流式与取消传播 / probeConnect 跳过 / hook_failed 映射 / keyring 陈旧条目
  丢弃）；改写（rewrite / store / upstream / route-test / upstream-test /
  contract-types / services CLI / detail 既有断言全面切 v2 形状）。
- 破坏性变更（显式接受，完整清单）：
  1. 用户 hooks 脚本导出名（authHeader → 四阶段名）；
  2. v1 services.json → legacy 失效态（services/groups/keys 全部不保留，移除重加）；
  3. AUTH_OK wire detail / SERVICE_ENTRY_SCHEMA 形状（跨版本目录不兼容，同版本约束）；
  4. 旧 consumer keyring 内嵌服务条目（加载丢弃，目录同步自愈）；
  5. 已生成的 aifly1. 分享链接（解码报过期）；
  6. provider.services.* RPC 输入输出形状；
  7. CLI：`--hooks` 退役、`--header-set` 值语法（仅字面量/`$env:`/`$secret:`，
     逐头脚本对象删除）、`--secret` 组装
     目标、service get/list 文本、hooks list/get/run 输出与参数；
  8. SecretsStore.bearerPrefix 退役（secrets.json 条目语义、SECRET_ENTRY_SCHEMA、
     `secrets.set` 输入、密钥面板控件与 list 输出）；
  9. preset.authHeader → preset.auth；
  10. 所有 rewrite.headerSet/headerRemove 的 TS API 消费方（三份 schema 镜像 +
      webui auth-source 模型）；
  11. 用户 hooks 脚本**运行时契约**（不止导出名）：ctx 扩展为请求级超集、③/④
      返回对象形状、AsyncIterable 流与取消语义；
  12. wire ERROR 码集合与消费侧 HTTP 映射：`hook_failed` 改变 ErrorCodeValue、
      错误帧 schema、消费侧本地错误响应（穷举映射表）；
  13. provider-local 连通测试契约：`services.test` 输入从 secretName 单字段改为
      auth 槽草稿（RPC/API 行为变化）；
  14. AUTH_OK 目录 detail 与旧 consumer 的组合失败面（同版本约束，见上）。
- 验证基线：全量 vitest（2026-09-15 实跑基线 535/535）+ tsc + webui typecheck +
  build + `openspec validate --strict hooks-lifecycle`；外部网络依赖的 codex 订阅
  e2e 走查单独报告，不作为唯一绿色证据。
