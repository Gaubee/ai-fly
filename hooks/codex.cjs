// 内建 hooks 脚本：codex —— ChatGPT Codex backend 全生命周期（只读登录态）。
// 只读 ~/.codex/auth.json —— ai-fly 永不写凭据文件（Owner 2026-09-14 裁决）。
// 阶段矩阵（按四阶段导出名被发现）：
// - onRequestBearerAuthentication(ctx) -> string：① auth 阶段，返回 ChatGPT
//   Codex backend 的 Bearer 认证头裸值（"Bearer " 前缀由服务 auth 槽的 bearer
//   开关拼，缺省开；本脚本只返回裸 token）。
// - onRequestHeaders(ctx) -> {set}：② headers 阶段，注入 codex CLI 同款协议
//   头集（chatgpt-account-id / originator / openai-beta / user-agent——镜像
//   codex.js 实测头集）。
// - onRequest(ctx)：③ request 阶段，委托 rust-fetch sidecar（rustls 客户端栈）
//   发起出站——codex 预设模式的完整生命周期即由本脚本三导出构成
//   （Owner 2026-09-15 双模式裁决）。
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const ORIGINATOR = "codex_cli_rs";
const CODEX_VERSION = "0.154.0"; // 与 models_cache.json 的 client_version 对齐

function readAuth(homedir) {
  const auth = JSON.parse(readFileSync(join(homedir, ".codex", "auth.json"), "utf8"));
  const tokens = auth && auth.tokens;
  if (tokens === undefined || typeof tokens !== "object") {
    throw new Error("codex auth.json missing tokens");
  }
  return tokens;
}

module.exports.onRequestBearerAuthentication = function onRequestBearerAuthentication({ homedir }) {
  const token = readAuth(homedir).access_token;
  if (typeof token !== "string" || token === "") throw new Error("codex auth.json missing access_token");
  return token;
};

module.exports.onRequestHeaders = function onRequestHeaders({ homedir }) {
  const tokens = readAuth(homedir);
  const accountId = tokens.account_id;
  if (typeof accountId !== "string" || accountId === "") {
    throw new Error("codex auth.json missing account_id");
  }
  return {
    set: {
      "chatgpt-account-id": accountId,
      originator: ORIGINATOR,
      "openai-beta": "responses=experimental",
      "user-agent": `${ORIGINATOR}/${CODEX_VERSION} (Mac OS 26.0; arm64) ${join(homedir, ".codex")}`,
    },
  };
};

module.exports.onRequest = function onRequest(ctx) {
  return require("./rust-fetch.cjs").onRequest(ctx);
};
