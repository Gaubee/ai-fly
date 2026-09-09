// App 图标生成（C 车道 m2 §4.2，2026-09-09）：独立脚本（app:icons），不经
// webui 的 vite 构建（webui/vite.config.ts 属 B 车道，本仓库不碰）。
// - App identity catalog（icns/ico/linux png + app-icon.json manifest）：
//   @opentray/vite-plugin 的独立 API generateOpenTrayAppIcon（bundling.md 的
//   openTrayAppIconPlugin 同源生成器，插件外可直接调用）。
// - 托盘 template 小图（tray-icon.png，黑色透明底）：sharp 从单色 SVG 源渲染。
// 产物全部落 resources/app-icons/（main.ts 的 projectAppIcon/resolveTrayIcon
// 按固定文件名消费）。构建期工具：不进 dist bundle、不进运行时依赖面。

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { generateOpenTrayAppIcon } from "@opentray/vite-plugin";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const sourceSvg = join(root, "resources", "icon.svg");
const traySvg = join(root, "resources", "tray-icon.svg");
const outDir = join(root, "resources", "app-icons");

mkdirSync(outDir, { recursive: true });

// [1] App identity catalog（生成器负责安全区 tile/平台编码器/缓存一致性）
await generateOpenTrayAppIcon({
  sourcePath: sourceSvg,
  outputPath: join(outDir, "app-icon.png"),
  icnsOutputPath: join(outDir, "app-icon.icns"),
  icoOutputPath: join(outDir, "app-icon.ico"),
  linuxOutputDirectory: join(outDir, "linux"),
  manifestOutputPath: join(outDir, "app-icon.json"),
  // 生成器缓存默认落 cwd/.cache——显式收进 node_modules（仓库根零杂物）
  cachePath: join(root, "node_modules", ".cache", "opentray-app-icon.json"),
});

// [2] 托盘 template 小图（黑色/透明，macOS isTemplate 自适应反相）
await sharp(traySvg, { density: 96 })
  .resize(96, 96, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(join(outDir, "tray-icon.png"));

console.log(`[app:icons] generated into ${outDir}`);
