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
- [ ] 7. 发布：0.4.0-alpha.1（含 $file/codex）→ 实机（有 codex 登录态的机器）
      验证真 token 200 → 0.4.0 latest
