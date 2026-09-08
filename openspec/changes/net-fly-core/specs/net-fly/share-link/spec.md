# net-fly/share-link Specification

## Purpose

定义分享链接契约：一键分享的产品载体。链接是自包含字符串，内含 fabric 邀请、
分组密钥与提供者非敏感元数据；使用方导入即完成组网与授权。链接的兑换次数、
时效与撤销语义是提供方对分享范围的精确控制面。

## ADDED Requirements

### Requirement: 链接构成与编码

`netfly share --group <name> [--ttl <dur>]` SHALL 生成链接：
`netfly1.<base64url(payload)>`，payload 为 JSON：`v`、`invite`（fabric 邀请令牌，
`dweb1.` 前缀，issuer-online 单次兑换）、`key`（分组访问密钥原文）、`keyId`、
`provider`（`alias`、`endpointId`、`relayUrls`）、`group`（分组名）、`services`
（服务脱敏视图：serviceId/name/defaultPort/match）。链接 MUST 自包含（无需联网
即可解析预览），且不含任何上游地址、重写细节、环境变量名或其它分组的引用。
生成链接 SHALL 先做前置检查：分组存在且非空、密钥有效、relay 已配置（无 relay
时按 fabric 既有 `--allow-relayless` 逃生阀语义警告）。链接即凭证：payload 含
密钥原文，经用户自选渠道传递，界面上 MUST 有"链接等同密钥"的提示。

#### Scenario: 链接自包含预览

- **WHEN** 离线状态下解析链接（`netfly import --preview <link>`）
- **THEN** 显示提供者别名、分组、服务列表与默认端口；不发起任何网络请求

#### Scenario: 敏感信息不入链

- **WHEN** 检查链接 payload 结构
- **THEN** 其中不存在 upstream URL、rewrite 配置、env 变量名、除所选分组外的任何信息

### Requirement: 兑换语义

链接的**网络加入**部分 SHALL 受 fabric 邀请语义约束：单次兑换（invite_id CAS）、
签发者在线、TTL 默认 60 分钟（CLI 层校验值域 1s..30d，复用时长解析约定）。
**授权部分**（密钥）MUST NOT 随兑换消耗：同一密钥在链接被兑换后依然有效（多设备
场景由提供方显式多钥覆盖——一设备一钥一链接是推荐用法）。

#### Scenario: 链接二次兑换被拒

- **WHEN** 链接已被设备 X 成功兑换，设备 Y 再度导入同一链接
- **THEN** fabric 层兑换失败（令牌已消费），导入失败并提示提供方重新 share

#### Scenario: 密钥独立于链接存续

- **WHEN** 设备 X 兑换成功在线，提供方对同组同钥再次 `share` 生成新链接供设备 Y
- **THEN** 设备 X 既有连接与授权不受影响（密钥仍有效），设备 Y 以新链接正常导入

### Requirement: 撤销语义（两级）

分享范围的收紧 SHALL 提供两级手段，语义明确分离：**撤销密钥**（`netfly key
revoke <keyId>`，应用层）——该密钥的授权即刻剔除（无余钥会话断开，有则目录
刷新剔除），后续 AUTH 计入 rejected，适合"收回某个朋友/某台设备的访问"；
**revoke 成员**（`netfly revoke <endpointId>`，fabric 级）——该设备从名册移除、
连接断开、后续连接被会话门控拒绝，适合"彻底踢出网络"。两者 MUST NOT 混淆：
撤密钥不动名册，踢成员不删密钥记录（密钥对新设备仍可用，直到显式撤销）。

#### Scenario: 撤钥不踢人

- **WHEN** 提供方撤销使用方所持一枚密钥但未 revoke 成员，且使用方另有有效密钥
- **THEN** 使用方收到剔除该分组的目录刷新，其余分组继续可用；名册成员身份不变

#### Scenario: 踢人不撤钥

- **WHEN** 提供方 revoke 某成员但密钥未撤
- **THEN** 该设备无法连接；密钥对其它设备不受影响
