# 发布与变更管理标准（release & change management）

一套从日常变更到 npm 发布的完整节奏。目标：main 永远可发布、每次发布可追溯、
版本与变更记录一一对应。

## 1. 变更管理（日常开发）

- **一切有计划的变更走 OpenSpec change**：proposal → tasks → 实现 → Owner 验收。
  一个 change 承载一个主题；验收完成（tasks 全勾）后在下一次发布时归档。
- **提交信息：Conventional Commits**（`feat:` / `fix:` / `revert:` / `chore:` /
  `docs:` …）。Owner 裁决类提交在正文引用裁决日期（本项目惯例）。
- **trunk-based**：直接在 main 上小步提交；不设发布分支。

## 2. 版本管理

- **semver**。`0.x` 阶段：minor 允许破坏性变更（仍需在 release notes 显著标注）。
- 版本唯一事实源 = 根 `package.json` 的 `version`。
- CI 门禁强制 **tag 名 == package.json version**（release.yml 的 version guard），
  不一致即发布失败——本地脚本同样前置校验。

## 3. 发布流程

一条命令：

```bash
node scripts/release.mjs <version>   # 显式版本（如 0.1.0）
node scripts/release.mjs patch       # 或 patch / minor / major 自动递增
```

脚本职责（顺序即门禁）：

1. **前置**：工作树干净、当前分支 = main、与 origin/main 同步。
2. **门禁**：`pnpm typecheck` + `pnpm test`（vitest 全量；integration/e2e 属
   本机/实机验证面，不阻塞发布——需要时手动跑 `pnpm test:integration`）。
3. **版本对齐**：目标版本 ≠ 当前则 bump 并提交；相同则复用（补发/首发的场景）。
4. **归档**：提示（不自动）归档已完成的 openspec changes——
   `openspec archive <change>` 在发布提交前手工执行，归档属于发布提交的一部分。
5. **打标**：annotated tag `v<version>`，提交 `chore(release): v<version>`，
   push main + tag。

之后 CI（`.github/workflows/release.yml`）接管：

- `v*` tag 触发 → install → typecheck → vitest → build（tsdown）→
  **tag/version guard** → `npm publish --provenance`（trusted publishing/OIDC，
  无 token；npm 侧配置：package `ai-fly` ↔ repo `Gaubee/ai-fly` ↔ workflow
  `release.yml` ↔ environment `npm-publish`）→ GitHub Release（自动 notes）。

## 4. 发布后核验

```bash
gh run watch            # 或 Actions 页盯跑
npm view ai-fly version # 应等于刚发的版本
gh release view         # Release 与 notes 就位
```

## 5. 失败与补发

- **publish 失败（版本已占）**：bump patch 重走流程；npm 不允许重发同版本。
- **CI 失败在门禁**：本地复跑对应命令修复，新提交后**重新打 tag**（删旧 tag
  `git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z`，修复提交后重打）。
- **热修**：main 上修复 → `node scripts/release.mjs patch`。

## 6. 归档节奏

openspec change 的归档绑定发布：发布提交里带上 `openspec archive`，保证
archive 目录的每个变更都能对应到一个 `v*` tag。发布后 openspec/changes/
应为空（或只剩进行中的 change）。
