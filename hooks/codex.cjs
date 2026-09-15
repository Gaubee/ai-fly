// 内建 hooks 脚本：codex —— 读 codex CLI 登录态（~/.codex/auth.json）。
// 只读 auth.json —— ai-fly 永不写凭据文件（Owner 2026-09-14 裁决）。
// 阶段矩阵（按四阶段导出名被发现）：
// - onRequestBearerAuthentication(ctx) -> string：① auth 阶段，返回 ChatGPT Codex
//   backend 的 Bearer 认证头裸值（"Bearer " 前缀由服务 auth 槽的 bearer 开关拼，
//   本脚本只返回裸 token）。
module.exports.onRequestBearerAuthentication = function onRequestBearerAuthentication({ homedir }) {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const auth = JSON.parse(readFileSync(join(homedir, ".codex", "auth.json"), "utf8"));
  const token = auth && auth.tokens && auth.tokens.access_token;
  if (typeof token !== "string" || token === "") throw new Error("codex auth.json missing access_token");
  return token;
};
