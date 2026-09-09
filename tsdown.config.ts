// 构建编排：[1] CLI 单文件 bundle（既有）；[2] 桌面 app 入口（C 车道 m2 §4.3）
// ——openTrayTsdownPlugin 在 writeBundle 后段化运行时宿主二进制并写
// opentray-app-manifest.json（@opentray/packaging 三段契约 stage/manifest/
// resolve；resolve 验证由根脚本 app:verify 执行）。
// runtimeHost.source 必须绝对路径：经 opentray 包闭包解析（pnpm 严格布局下
// optional 平台包不被提升，必须从声明方解析）——照抄 opentray bundling 文档
// 的消费者助手。

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "tsdown/config";
import { openTrayTsdownPlugin } from "@opentray/tsdown-plugin";
import { APP_ID, APP_NAME } from "./src/app/tray-menu.ts";

const require = createRequire(import.meta.url);

/** 解析已安装平台的 OpenTray 运行时宿主二进制（opentray bundling 文档同款）。 */
const resolveInstalledOpenTrayRuntime = (): string => {
  const platform =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin" || process.platform === "linux"
        ? process.platform
        : undefined;
  if (
    platform === undefined ||
    (process.arch !== "arm64" && process.arch !== "x64")
  ) {
    throw new Error(
      `OpenTray has no runtime package for ${process.platform}-${process.arch}`,
    );
  }

  const requireFromOpenTray = createRequire(
    require.resolve("opentray/package.json"),
  );
  const runtimePackageJson = requireFromOpenTray.resolve(
    `@opentray/${platform}-${process.arch}/package.json`,
  );
  return join(
    dirname(runtimePackageJson),
    "bin",
    process.platform === "win32" ? "opentray.exe" : "opentray",
  );
};

export default defineConfig([
  {
    entry: { "ai-fly": "./src/bin.ts" },
    format: "esm",
    dts: true,
    platform: "node",
    // bin 入口需要 shebang；tsdown 会保留源文件首行
    outputOptions: {
      // ESM bin 在无扩展名 import 的 Node 生态下保持 .js 后缀即可
      entryFileNames: "[name].js",
    },
  },
  {
    entry: { "app/main": "./src/app/main.ts" },
    format: "esm",
    dts: false,
    platform: "node",
    outputOptions: {
      entryFileNames: "[name].js",
    },
    // opentray/扩展在运行时经 node_modules 解析 optional 平台原生包——bundle
    // 会破坏其动态 require，显式 external（dependencies 默认外置，此处声明意图）
    external: ["opentray", "@opentray/ext-webview"],
    plugins: [
      openTrayTsdownPlugin({
        app: { id: APP_ID, name: APP_NAME },
        runtimeHost: {
          source: resolveInstalledOpenTrayRuntime(),
          executable: true,
        },
        entry: "./src/app/main.ts",
      }),
    ],
  },
]);
