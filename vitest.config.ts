import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // webui 概念模型模块（lifecycle.ts 等）进 root vitest 的运行时互转测试：
      // $shared 与 webui/vite.config.ts 同源（$lib 仅类型位使用，运行时被擦除）。
      $shared: fileURLToPath(new URL("./src/shared", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
