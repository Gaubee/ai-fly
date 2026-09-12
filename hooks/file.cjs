// 内建 hooks 脚本：file —— JSON 文件取值（点径）。
// 钩子清单：
// - authHeader(ctx) -> string：读 args.path（支持 ~）+ args.jsonPath（.a.b 风格）；
//   args.bearer 为 "true"/"1" 时返回值拼 "Bearer " 前缀。
//   watch 模式示例（返回 AsyncIterable）：unwatchOnClose 实现见文档。
module.exports.authHeader = function authHeader({ homedir, args }) {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const path = args && args.path;
  const jsonPath = (args && args.jsonPath) || ".";
  if (typeof path !== "string" || path === "") throw new Error("file hook requires args.path");
  const abs = path.startsWith("~/") ? join(homedir, path.slice(1)) : path;
  let doc;
  try {
    doc = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    throw new Error("file unreadable or invalid JSON");
  }
  let cur = doc;
  for (const seg of jsonPath.split(".").filter(Boolean)) {
    if (cur === null || cur === undefined) throw new Error("json path miss");
    cur = cur[seg];
  }
  if (typeof cur !== "string" || cur === "") throw new Error("json path value missing");
  const bearer = args && (args.bearer === "true" || args.bearer === "1");
  return bearer ? `Bearer ${cur}` : cur;
};
