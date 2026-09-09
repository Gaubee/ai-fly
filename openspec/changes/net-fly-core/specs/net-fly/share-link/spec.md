# net-fly/share-link Specification

## Purpose

定义分享链接契约：一键分享的产品载体。链接是自包含字符串，**组合了两类独立凭据**——fabric 邀请令牌（设备准入）与分组访问密钥（应用层授权）；使用方导入即完成组网与授权。令牌与密钥是两码事：链接只是首访便捷信封，不是新的安全原语。

## ADDED Requirements

### Requirement: 链接构成与编码

`ai-fly share --group <name> [--ttl <dur>]` SHALL 生成链接：
`aifly1.<base64url(payload)>`，payload 为 JSON：`v`、`invite`（fabric 邀请令牌，
`dweb1.` 前缀，issuer-online 单次兑换——**设备准入凭据**）、`key`（分组访问
密钥原文——**应用层授权凭据**）、`keyId`、`provider`（`alias`、`endpointId`、
`relayUrls`）、`group`（分组名）、`services`（服务视图：serviceId/name/
defaultPort/match + `detail` 脱敏披露）。链接 MUST 自包含（无需联网即可解析
预览），且不含任何环境变量名、凭据值或其它分组的引用。生成链接 SHALL 先做
前置检查：分组存在且非空、密钥有效、relay 已配置（无 relay 时按 fabric 既有
`--allow-relayless` 逃生阀语义警告；输出中附**稳定入口部署指引**提示——提供方
relay 用稳定域名/隧道可让入口永不变化，opendweb 原生支持）。链接即凭证：
payload 含密钥原文，经用户自选渠道传递，界面上 MUST 有"链接等同密钥"的提示。

#### Scenario: 链接自包含预览

- **WHEN** 离线状态下解析链接（`ai-fly import --preview <link>`）
- **THEN** 显示提供者别名、分组、服务列表与默认端口；不发起任何网络请求

#### Scenario: 敏感信息不入链

- **WHEN** 检查链接 payload 结构
- **THEN** 其中不存在 env 变量名、上游凭据值、除所选分组外的任何信息；detail 披露与 AUTH_OK 同规（`$env` 头值为 `●`）

### Requirement: 兑换语义

链接的**网络加入**部分（invite）SHALL 受 fabric 邀请语义约束：单次兑换
（invite_id CAS）、签发者在线、TTL 默认 60 分钟（CLI 层校验值域 1s..30d，复用
时长解析约定）。**授权部分**（密钥）MUST NOT 随兑换消耗：同一密钥在链接被兑换
后依然有效；已入网设备再次导入（含其它链接）时跳过兑换、密钥直接入环（见
consumer spec 三入口）。**裸密钥独立流转**：密钥可脱离链接经任意带外渠道传递，
由已入网设备 `ai-fly key add` 入环——链接不是密钥的唯一载体。

#### Scenario: 链接二次兑换被拒

- **WHEN** 链接已被设备 X 成功兑换，未入网的设备 Y 再度导入同一链接
- **THEN** fabric 层兑换失败（令牌已消费），导入失败并提示提供方重新 share 或走 `key add`

#### Scenario: 老设备跳过兑换

- **WHEN** 已入网设备 X 导入提供方任何新链接
- **THEN** 不触发兑换（令牌保留），密钥直接入环，既有连接与授权不受影响

#### Scenario: 密钥独立于链接存续

- **WHEN** 设备 X 兑换成功在线，提供方对同组再次 `share` 生成新链接（按签发语义总是新令牌 + 新密钥）供设备 Y
- **THEN** 设备 X 既有连接与授权不受影响（其密钥仍有效），设备 Y 以新链接正常导入

### Requirement: 撤销语义（两级）

分享范围的收紧 SHALL 提供两级手段，语义明确分离：**撤销密钥**（`ai-fly key
revoke <keyId>`，应用层）——该密钥的授权即刻剔除（无余钥会话断开，有则目录
刷新剔除），后续 AUTH 计入 rejected，适合"收回某个朋友/某台设备的访问"；**
revoke 成员**（`ai-fly revoke <endpointId>`，fabric 级）——该设备从名册移除、
连接断开、后续连接被会话门控拒绝，适合"彻底踢出这台设备"。两者 MUST NOT 混淆：
撤密钥不动名册（其它持钥设备继续可用），踢成员不删密钥记录（该设备重新入网后
持有效密钥即可恢复授权）。

#### Scenario: 撤钥不踢人

- **WHEN** 提供方撤销使用方所持一枚密钥但未 revoke 成员，且使用方另有有效密钥
- **THEN** 使用方收到剔除该分组的目录刷新，其余分组继续可用；名册成员身份不变

#### Scenario: 踢人不撤钥

- **WHEN** 提供方 revoke 某成员但密钥未撤
- **THEN** 该设备无法连接（需重新入网才能恢复）；密钥对其它设备不受影响
