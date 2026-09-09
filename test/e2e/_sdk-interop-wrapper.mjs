// e2e 专用：SDK 的 ESM 命名导出包装（见 _sdk-interop-register.mjs）。
// 经 createRequire 走 CJS require（绕开 ESM 命名导出检测），再以命名导出呈现。
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Native = require("@jixo/opendweb-client-sdk");

export const Fabric = Native.Fabric;
export const deriveErrorCode = Native.deriveErrorCode;
export const importSecret = Native.importSecret;
export const nativeVersion = Native.nativeVersion;
export default Native;
