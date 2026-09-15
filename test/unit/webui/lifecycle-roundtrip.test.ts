// webui 生命周期概念模型互转测试（hooks-lifecycle 复核 R1-F3）：
// auth 槽 bearer 往返——false 必须显式落库（运行时省略语义是 true，丢掉会把
// 用户关掉的前缀悄悄打开）、true 可省略、回显缺省与 rewrite.applyBearerPrefix
// 单源一致。同时覆盖四族选择器 ↔ 契约槽位的整体形状。

import { describe, expect, it } from "vitest";
import { authSelFromService, authSlotFromSel } from "../../../webui/src/lib/lifecycle.ts";
import type { ServiceConfigView } from "$shared/rpc-contract.ts";

const serviceWithAuth = (auth: ServiceConfigView["auth"]): ServiceConfigView =>
  ({ serviceId: "s", name: "svc", match: [], upstream: "http://127.0.0.1:1", defaultPort: 1, enabled: true, auth });

describe("预设模式 lib 助手（rust-fetch-sidecar）", () => {
  it("presetEligibleScripts 仅列 ≥1 阶段导出的脚本；coveredStagesOf 返回覆盖阶段", async () => {
    const { presetEligibleScripts, coveredStagesOf } = await import("../../../webui/src/lib/lifecycle.ts");
    const rows = [
      { name: "codex", source: "builtin" as const, stages: ["onRequestBearerAuthentication", "onRequestHeaders", "onRequest"] as never[] },
      { name: "legacy", source: "user" as const, stages: [] as never[] },
    ];
    expect(presetEligibleScripts(rows).map((r) => r.name)).toEqual(["codex"]);
    expect(coveredStagesOf(rows, "codex")).toHaveLength(3);
    expect(coveredStagesOf(rows, "ghost")).toEqual([]);
  });
});

describe("干净会话预设模式装载（复核 R4-P1）", () => {
  // webui 无组件级测试跑器（root vitest 为 node 环境、无 svelte 插件）——按仓库
  // 惯例拆两层：源级接线守卫（ServiceForm 挂载必须自载 hooks 清单）+ 派生组合
  // （空清单 → 装载后 codex 入列与 ①②③ 徽章）。
  it("ServiceForm 挂载即触发 loadHooks（源级接线守卫——预设模式不渲染 AuthSourcePicker）", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../../../webui/src/components/ServiceForm.svelte", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/onMount\(\(\) => \{\s*\n\s*void loadHooks\(\);/);
    // 反向锚点：装载不得只依赖 AuthSourcePicker（其 onMount 是既有第二入口）
    expect(src).toContain('import { hooksPanel, loadHooks }');
  });

  it("空清单（未装载）无候选；装载后 codex 入列且 ①②③ 徽章齐备", async () => {
    const { presetEligibleScripts, coveredStagesOf } = await import("../../../webui/src/lib/lifecycle.ts");
    // 干净会话初始态（advanced.svelte.ts hooksPanel.scripts = []）：
    expect(presetEligibleScripts([])).toEqual([]);
    // hooks.list 装载后的 stages-only 行形状（含 codex ①②③）：
    const rows = [
      {
        name: "codex",
        source: "builtin" as const,
        stages: ["onRequestBearerAuthentication", "onRequestHeaders", "onRequest"] as never[],
      },
      { name: "none-stage", source: "user" as const, stages: [] as never[] },
    ];
    const candidates = presetEligibleScripts(rows);
    expect(candidates.map((r) => r.name)).toEqual(["codex"]);
    expect(coveredStagesOf(rows, "codex")).toHaveLength(3);
  });
});

describe("auth 槽 bearer 往返（提交组装 ↔ 编辑回显）", () => {
  it("bearer:false 显式落库并经回显还原（三族）", () => {
    for (const sel of [
      { kind: "secret", name: "lib", bearer: false },
      { kind: "script", script: "codex", bearer: false },
      { kind: "literal", value: "tok", bearer: false },
    ] as const) {
      const slot = authSlotFromSel(sel)!;
      expect(slot.bearer).toBe(false); // 关键：不得因 falsy 被展开语法丢弃
      expect(authSelFromService(serviceWithAuth(slot))).toEqual(sel);
    }
  });

  it("bearer:true 落库省略（省略=默认开），回显还原为 true", () => {
    const slot = authSlotFromSel({ kind: "secret", name: "lib", bearer: true })!;
    expect(slot).toEqual({ secret: "lib" }); // true 省略不写
    expect(authSelFromService(serviceWithAuth(slot))).toEqual({ kind: "secret", name: "lib", bearer: true });
  });

  it("回显缺省语义 = true（与 rewrite.applyBearerPrefix 单源一致）", () => {
    const sel = authSelFromService(serviceWithAuth({ secret: "lib" }));
    expect(sel).toEqual({ kind: "secret", name: "lib", bearer: true });
  });

  it("none 族清除绑定（undefined）", () => {
    expect(authSlotFromSel({ kind: "none" })).toBeUndefined();
    expect(authSelFromService(serviceWithAuth(undefined)).kind).toBe("none");
  });

  it("script 族 args 透传共存于 bearer:false", () => {
    const slot = authSlotFromSel({ kind: "script", script: "file", bearer: false }, { path: "~/c.json" })!;
    expect(slot).toEqual({ script: "file", args: { path: "~/c.json" }, bearer: false });
  });
});
