// e2e 专用：注册 SDK CJS 命名导出桥接（引擎 bug #1 的测试车道过渡措施）。
//
// 背景：@jixo/opendweb-client-sdk 是 CJS（`module.exports = Native`），cjs-module-lexer
// 检测不到命名导出；src 内 `const { Fabric } = await import("...")` 在真实 Node 进程
// 里拿到 undefined（CLI serve/share/import/join 全部启动即崩，见交付报告 bug #1）。
// 本钩子把该 specifier 重定向到下面的 ESM 包装（default import + 命名再导出），
// 使 CLI 子进程在引擎修复前可跑。引擎修复后本桥接无害（可删）。
//
// 用法：node --import tsx --import <abs>/test/e2e/_sdk-interop-register.mjs src/bin.ts ...
import { register } from "node:module";

register("./_sdk-interop-hook.mjs", import.meta.url);
