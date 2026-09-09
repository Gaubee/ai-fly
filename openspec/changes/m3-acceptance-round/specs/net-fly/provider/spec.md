# net-fly/provider Delta

## ADDED Requirements

### Requirement: 提供方密钥库

提供方 SHALL 持有本地密钥库 `~/.aifly/provider/secrets.json`（0600、原子写、与
services.json 同目录约定）：`name → value`（value 为完整头值，如
`Bearer sk-…`）。RPC 面：`list` SHALL 只返回名称与条目数（值绝不序列化）、`set`
（新增/覆写，名非空、值非空）、`remove`（不存在时 NOT_FOUND）。密钥值 MUST NOT
离开提供方机器（不入 wire 目录、不入分享链接、不入任何 status/detail 载荷；名称
同受消费侧 ● 投影保护——消费方目录只见 `●`）。

#### Scenario: 面板增删密钥

- **WHEN** 用户在密钥面板添加 `openai = Bearer sk-xxx` 后删除之
- **THEN** list 先返回 `[{"name":"openai"}]` 再返回空；文件内容与 0600 权限保持；任何 RPC 响应不含 `sk-xxx`

### Requirement: 密钥引用解析（$secret:）

rewrite `headerSet` 头值 SHALL 支持 `$secret:<name>`：请求期从密钥库解析替换后
发往上游；`$env:<VAR>` 语义保持不变；两者可并存于不同头。引用不存在的密钥时该
请求 SHALL 以错误码 `secret_missing` 拒绝（不回退空值、不带引用名出网）。提供方
侧 detail 投影中 `$secret:` 与 `$env:` 同样显示为 `●`。

#### Scenario: 密钥解析与缺失

- **WHEN** 服务 rewrite 为 `authorization: $secret:openai` 且密钥库含 openai
- **THEN** 上游收到替换后的完整头值；删除 openai 后同请求返回 `secret_missing`，错误信息不含密钥名

### Requirement: 上游连通性测试

提供方 SHALL 支持对「草稿或已存服务形状」（upstream、apiForm、secretName、
model?）执行一次最小连通测试：按 apiForm 构造单轮请求（openai-completions →
`POST {upstream}/chat/completions`；anthropic-messages → `POST {upstream}/v1/messages`
并带 `anthropic-version` 头；gemini-native → `POST {upstream}/v1beta/models/{model}:generateContent`
且密钥经 `x-goog-api-key` 注入），`max_tokens`/`maxOutputTokens` 压到最小；密钥
经密钥库解析注入（与转发同路径）。未指定 model 时 SHALL 取该 provider 价格已知
的最低价 chat 模型（模型清单来自 models.dev 缓存；清单不可用时要求显式指定）。
结果 SHALL 含 `ok`、`httpStatus`、`latencyMs`、`model`、失败时 `error`；测试
MUST 为 provider-local：不落盘、不计限额、不经 fabric。

#### Scenario: 默认最便宜模型测试

- **WHEN** 对 z.ai 预设形状发起测试且未指定模型，模型清单含多档价格
- **THEN** 引擎选价格最低的 chat 模型发单轮请求，返回 ok 与耗时；密钥错误时返回带上游状态码的失败结果

### Requirement: 密钥值语义（裸 key + Bearer 前缀开关）

密钥库条目 SHALL 携带 `bearerPrefix`（默认 true）：注入（$secret: 解析与连通测试）
时自动前拼 `"Bearer "`（值已以 Bearer 开头则不重复）；false 按原样注入。既有文件
无该字段 SHALL 读为 true。RPC `secrets.set` 接受可选 `bearerPrefix`，覆写未给时
沿用旧值。

#### Scenario: 裸 key 默认可用

- **WHEN** 用户在面板存入裸密钥（未手写 Bearer）并选中注入
- **THEN** 上游收到 `authorization: Bearer <key>`；关闭开关的条目按原样注入

### Requirement: 分组管理对齐密钥面

分组 SHALL 支持行级管理：限额更新（`setLimits`，省略=清除为无限）与删除
（`remove`）。删除时组内仍有未撤销密钥 SHALL 以 CONFLICT 拒绝（提示先撤销）。
CLI 同步提供 `group set-services` / `group remove`。

#### Scenario: 有键分组不可删

- **WHEN** 分组存在未撤销密钥时请求删除
- **THEN** 返回 CONFLICT 与 "revoke them first"；撤销后删除成功

### Requirement: 自定义上游模型探测

模型清单 SHALL 支持第二来源：对自定义上游（不在 models.dev 覆盖内）实时探测
`GET {upstream}/models`（带密钥注入；OpenAI 兼容形状 `{data:[{id}]}`），便宜档
命名启发式（mini/flash/small/lite/nano/turbo）排前。连通测试的模型选择顺序 SHALL
为：显式指定 > models.dev 缓存（priced chat 最低价）> 上游探测。测试结果 SHALL
携带请求详情（method/url/model）、模型来源（modelSource）与非 2xx 时的上游正文
摘录（截断、密钥值打码）。

#### Scenario: 中转站无 models.dev 条目

- **WHEN** 对 https://api.example-relay.com/v1 发起测试且该站不在 models.dev
- **THEN** 引擎探测其 /models 取首个便宜档模型发起单轮请求；401 时错误含上游 JSON 正文摘录
