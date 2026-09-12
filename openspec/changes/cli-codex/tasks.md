# CLI Codex Tasks

- [x] 1. $file: 凭据引用（rewrite.ts）：parseFileRef/evalJsonPath/
      defaultFileCredentialSource + resolveHeaderValue 扩展（~ 展开、?bearer、
      未命中 SecretMissingError、每请求读盘无缓存）
- [x] 2. Preset codex（providers.json）：/codex=/backend-api/codex @openai-responses、
      authHeader 预填、4306、chatgpt.com
- [x] 3. 契约：PRESET_SCHEMA.authHeader? + API_FORM_SCHEMA += openai-responses
      （GUI presetToServiceInput 与 CLI service add 双侧合并：--secret >
      authHeader > keyEnv）
- [x] 4. upstream-test：openai-responses 最小探测构建器
- [x] 5. service test 智能缺省（唯一/命中路由的 form + localPrefix）
- [x] 6. 测试：rewrite $file 矩阵 + presets 凭据源断言 + CLI codex 预填/覆盖
      + 端到端伪 token 401 实证；531/531 全绿
- [x] 7a. GUI 随包分发：files += dist/app/** + webui/dist + resources/app-icons；
      resolveRepoRoot 支持安装布局（name=ai-fly 的 package.json 向上探测）；
      新增 `ai-fly app` 命令（spawn dist/app/main.js）；release.yml 补
      webui:build。安装冒烟：sandbox prefix 安装 tarball → `ai-fly app` →
      "ui server listening (webui: .../node_modules/ai-fly/webui/dist)" ✓
- [x] 7b. $script: 第四种凭据源（Owner 裁决 2026-09-12：统一 Node 脚本跨平台、
      无 VM——node:vm 非安全边界且 Bun/Deno 支持残缺）。CJS 模块导出同步函数，
      createRequire 加载（Node/Bun/Deno 同语义），每请求调用（值按调用计算，
      token 刷新即刻生效；脚本文件修改需重启——require 缓存）；ctx 透传
      {homedir}；?bearer 同 $file。E2E：~/.aifly/codex.cjs 读登录态 →
      service test 401 实证；rewrite 54 例
- [ ] 7. 发布：alpha.1（$file/codex）→ alpha.2（+GUI 随包）→ alpha.3
      （+$script）→ 实机真 token 验证（codex 登录态机器）→ 0.4.0 latest

- [x] 7c. hooks 终态（两协议/资源域/命名发现/三态/ctx/env 访问器/dispose
      300ms 竞速/CLI hooks 命令集/--header-set JSON 值/preset codex→hooks:
      codex/GUI 显示与创建面 humanize/订阅测试）——519 全绿
- [ ] 7d. 发布 0.4.0-alpha.4（含 hooks 终态）→ 实机 codex 真 token 验证 →
      0.4.0 latest → Owner 视觉验收
