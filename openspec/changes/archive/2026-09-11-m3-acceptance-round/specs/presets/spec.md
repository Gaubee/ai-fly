# presets Delta

## ADDED Requirements

### Requirement: 预设图标

预设 SHALL 派生图标地址 `https://models.dev/logos/{iconId}.svg`：精选集条目可选
携带 `iconId` 覆写（默认取 `id`；变体条目如 zai-coding/zai-cn 覆写为 zai）；长尾
预设 `iconId` 恒为其 models.dev id。UI 加载失败（404/断网）SHALL 回退到首字母
tile 占位，不报错、不留空位。

#### Scenario: 变体预设用同源图标

- **WHEN** 预设列表包含 zai 与 zai-coding 两条精选
- **THEN** 两者分别经 `logos/zai.svg` 与（覆写后）同源图标渲染，任一加载失败显示首字母 tile

### Requirement: 模型清单与价格（models.dev）

models.dev 拉取 SHALL 同时解析 provider 级 `models`（至少 `id`、`cost.input`、
`cost.output`，USD/Mtok，缺失视为未知价）并入缓存。RPC `presets.models` SHALL 输入
`presetId`，输出该预设按（input+output）价格升序的模型清单（含价格与未知价尾排），
并标记非 chat 模型（按 id 启发式：embed/image/whisper/tts/rerank/moderation 归
non-chat）。缓存未命中或已过期时 SHALL 先尝试刷新，失败回退缓存并附错误说明。

#### Scenario: 最便宜模型排首位

- **WHEN** 调用 `presets.models` 且该 provider 有多档价格模型
- **THEN** 返回清单首项为价格已知的最低价 chat 模型，未知价格条目排在已知价格之后
