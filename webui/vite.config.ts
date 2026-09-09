// webui — Vite + Svelte 5 + Tailwind v4 SPA（jixoai-ui 消费形态，参照
// jixoai-labs/ui 的 verify-shadcn-add 消费模板：$lib 别名根 + svelte/tailwind 插件）。
// dev 代理 /ws → 本地 UI daemon（C 车道 main.ts 起的 127.0.0.1 服务）。
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
      // 共享契约直连仓库源（browser-safe：仅 zod + @orpc/contract）。
      $shared: fileURLToPath(new URL("../src/shared", import.meta.url)),
    },
  },
  build: { outDir: "dist", target: "esnext" },
  server: {
    port: 5190,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8790", ws: true },
    },
  },
});
