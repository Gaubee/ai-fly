// webui — Vite + Svelte 5 + Tailwind v4 SPA（jixoai-ui 消费形态，参照
// jixoai-labs/ui 的 verify-shadcn-add 消费模板：$lib 别名根 + svelte/tailwind 插件）。
// dev 代理 /ws → 本地 UI daemon（C 车道 main.ts 起的 127.0.0.1 服务）。
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";

/** dev token 门禁桥：?token= 请求由 vite 服务端代赎（转发 8790，回写 set-cookie，
 *  303 落回同源 /）。cookie 按 host 不分端口，后续 /ws 代理自动携带——否则 dev
 *  形态 token 永远到不了 daemon，ws 全部 401（2026-09-10 实机踩坑）。 */
function devTokenGate(daemon: string): Plugin {
  return {
    name: "aifly-dev-token-gate",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const raw = req.url ?? "/";
        if (!raw.includes("token=")) return next();
        const url = new URL(raw, "http://127.0.0.1");
        if (!url.searchParams.has("token")) return next();
        void fetch(daemon + raw, { redirect: "manual" })
          .then((upstream) => {
            // 303 = 赎回成功：回写会话 cookie 后落回同源 /（cookie 不分端口，
            // /ws 代理自动携带）。其它状态（如已消费 token 的指引页）不携带
            // cookie，仅重定向——SPA 会以断连横幅呈现，dev 可接受。
            if (upstream.status === 303) {
              for (const cookie of upstream.headers.getSetCookie?.() ?? []) {
                res.setHeader("set-cookie", cookie);
              }
            }
            res.statusCode = 303;
            res.setHeader("location", "/");
            res.end();
          })
          .catch(() => {
            res.statusCode = 502;
            res.end("ui daemon unreachable (start: pnpm app:dev)");
          });
      });
    },
  };
}

export default defineConfig({
  plugins: [svelte(), tailwindcss(), devTokenGate("http://127.0.0.1:8790")],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
      // 共享契约直连仓库源（browser-safe：仅 zod + @orpc/contract）。
      $shared: fileURLToPath(new URL("../src/shared", import.meta.url)),
    },
  },
  build: { outDir: "dist", target: "esnext" },
  server: {
    // 显式绑 IPv4 回环：dev 窗口入口固定 127.0.0.1:5190（vite 8 默认 localhost
    // 仅绑 ::1，窗口加载 127.0.0.1 会 connection refused——2026-09-10 实机踩坑）
    host: "127.0.0.1",
    port: 5190,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8790", ws: true },
    },
  },
});
