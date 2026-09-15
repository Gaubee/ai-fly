// 内建 hooks 脚本：env —— 环境变量桥。
// 阶段矩阵：
// - onRequestBearerAuthentication(ctx) -> string：① auth 阶段，读 args.var 指定的
//   环境变量（OPENAI_API_KEY 等）。
module.exports.onRequestBearerAuthentication = function onRequestBearerAuthentication({ args, env: ctxEnv }) {
  const name = args && args.var;
  if (typeof name !== "string" || name === "") throw new Error("env hook requires args.var");
  const value = (ctxEnv && ctxEnv(name)) || process.env[name];
  if (value === undefined || value === "") throw new Error(`env '${name}' unset`);
  return value;
};
