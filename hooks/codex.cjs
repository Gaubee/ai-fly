// 内建 hooks 脚本：codex —— 读 codex CLI 登录态（~/.codex/auth.json）。
// 钩子清单（按函数名命名规范被发现）：
// - authHeader(ctx) -> string：ChatGPT Codex backend 的 Bearer 认证头（去前缀裸值，
//   框架按需拼 "Bearer " 由 headerSet 配置的 bearer 决定——本脚本返回裸 token）。
module.exports.authHeader = function authHeader({ homedir }) {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const auth = JSON.parse(readFileSync(join(homedir, ".codex", "auth.json"), "utf8"));
  const token = auth && auth.tokens && auth.tokens.access_token;
  if (typeof token !== "string" || token === "") throw new Error("codex auth.json missing access_token");
  return token;
};
