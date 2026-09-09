# app/shell Delta

## ADDED Requirements

### Requirement: 品牌图标资产

应用图标 SHALL 以仓库内 `resources/icon.svg` 为唯一 canon（1024 全出血矢量，hue 95
琥珀家族），`resources/tray-icon.svg` 为其纯黑透明单色版；两者经 `pnpm app:icons`
（generateOpenTrayAppIcon + sharp template 渲染）产出 `resources/app-icons/` 全平台
资产。canon 变更 SHALL 满足：16px 缩略下主体剪影仍可辨、与生成器安全区 tile 兼容
（主体占画布 62%~78% 高度）。图标方向的选型 SHOULD 经多方案评审留痕（竞赛稿与
评选记录存档于 change 目录）。

#### Scenario: 重生成一致

- **WHEN** canon SVG 更新后执行 `pnpm app:icons`
- **THEN** icns/ico/linux png/app-icon.json 全部随新 canon 再生，托盘 template 图与 app 图标为同一符号语言
