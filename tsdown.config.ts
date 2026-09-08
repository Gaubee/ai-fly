import { defineConfig } from "tsdown/config";

export default defineConfig({
  entry: { "ai-fly": "./src/bin.ts" },
  format: "esm",
  dts: true,
  platform: "node",
  // bin 入口需要 shebang；tsdown 会保留源文件首行
  outputOptions: {
    // ESM bin 在无扩展名 import 的 Node 生态下保持 .js 后缀即可
    entryFileNames: "[name].js",
  },
});
