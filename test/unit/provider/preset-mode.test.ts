// 预设模式（service.hooks 整段绑定——rust-fetch-sidecar 变更，Owner 2026-09-15
// 双模式裁决）单测：
// - store：往返持久化 / 与四槽互斥 / 既有 v2 文件向后兼容（缺省 = 自定义模式）
// - effectiveLifecycleSlots：stages 矩阵逐阶段取导出（缺导出回退缺省语义）；
//   自定义模式原样透传；双模式同现防御（逐槽胜）
// - scriptHasStageExports：入口校验
// - detail：hooks 位掩码 ●

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderStore, StoreError, STORE_VERSION } from "../../../src/provider/store.ts";
import {
  effectiveLifecycleSlots,
  scriptHasStageExports,
} from "../../../src/provider/hook.ts";
import { buildServiceDetail } from "../../../src/provider/detail.ts";
import { SERVICE_VALUE_MASK } from "../../../src/provider/lifecycle.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aifly-preset-mode-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const MATCH = [{ type: "exact" as const, value: "x.test" }];

describe("store：hooks 槽持久化与互斥", () => {
  it("预设模式往返：hooks 落库、重载恢复、version 维持 2", () => {
    const store = ProviderStore.open(dir);
    store.addService({
      name: "codex-e2e",
      upstream: "https://chatgpt.com",
      match: MATCH,
      defaultPort: 4306,
      hooks: { script: "codex" },
    });
    const file = JSON.parse(readFileSync(ProviderStore.filePath(dir), "utf8"));
    expect(file.version).toBe(STORE_VERSION);
    expect(file.services[0].hooks).toEqual({ script: "codex" });
    const reloaded = ProviderStore.open(dir).getServiceByName("codex-e2e");
    expect(reloaded?.hooks).toEqual({ script: "codex" });
    // 自定义四槽字段不出现在预设模式服务上
    expect(reloaded?.auth).toBeUndefined();
    expect(reloaded?.request).toBeUndefined();
  });

  it("互斥：hooks 与 auth / request 同现一律 invalid", () => {
    const store = ProviderStore.open(dir);
    for (const over of [
      { auth: { script: "codex" } as const },
      { request: { script: "rust-fetch" } as const },
      { headers: { set: { "x-a": "1" } } as const },
      { response: { script: "r" } as const },
    ]) {
      try {
        store.addService({ name: "bad", upstream: "https://u.test", match: MATCH, defaultPort: 9100, hooks: { script: "codex" }, ...over });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(StoreError);
        expect((err as StoreError).code).toBe("invalid");
        expect((err as StoreError).message).toContain("mutually exclusive");
      }
    }
    expect(store.listServices()).toHaveLength(0);
  });

  it("store 唯一门禁（复核 R1-P2-2）：直接 addService 零阶段脚本拒绝", () => {
    const store = ProviderStore.open(dir);
    try {
      store.addService({
        name: "ghost",
        upstream: "https://u.test",
        match: MATCH,
        defaultPort: 9100,
        hooks: { script: "definitely-not-a-script" },
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(StoreError);
      expect((err as StoreError).code).toBe("invalid");
      expect((err as StoreError).message).toContain("no lifecycle stage function");
    }
  });

  it("store 唯一门禁：手写 v2 文件 hooks+auth 混合 → open 判 corrupt（不进运行时局部覆盖）", () => {
    const mixed = {
      version: STORE_VERSION,
      revision: 1,
      services: [
        {
          serviceId: "s1",
          name: "mixed",
          match: MATCH,
          upstream: "https://u.test",
          defaultPort: 9100,
          hooks: { script: "codex" },
          auth: { script: "codex" },
        },
      ],
      groups: [],
      keys: [],
    };
    writeFileSync(ProviderStore.filePath(dir), JSON.stringify(mixed));
    try {
      ProviderStore.open(dir);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(StoreError);
      expect((err as StoreError).code).toBe("corrupt");
      expect((err as StoreError).message).toContain("mutually exclusive");
    }
  });

  it("向后兼容：既有 v2 文件（无 hooks 字段）照常加载为自定义模式", () => {
    const plain = {
      version: STORE_VERSION,
      revision: 3,
      services: [
        { serviceId: "s1", name: "plain", match: MATCH, upstream: "https://u.test", defaultPort: 9100 },
      ],
      groups: [],
      keys: [],
    };
    writeFileSync(ProviderStore.filePath(dir), JSON.stringify(plain));
    const store = ProviderStore.open(dir);
    expect(store.legacy).toBeNull();
    expect(store.getServiceByName("plain")?.hooks).toBeUndefined();
  });
});

describe("effectiveLifecycleSlots（stages 矩阵逐阶段解析）", () => {
  const loader = (name: string) =>
    ({
      full: {
        onRequestBearerAuthentication: () => "tok",
        onRequestHeaders: () => ({ set: { "x-h": "1" } }),
        onRequest: async () => ({ status: 200, headers: {} }),
        onResponse: () => ({}),
      },
      partial: {
        onRequestBearerAuthentication: () => "tok",
        onRequestHeaders: () => ({ set: {} }),
      },
      none: { notAHook: 42 },
    })[name] as Record<string, unknown> | undefined;

  it("整段脚本覆盖的阶段生效；缺导出阶段回退缺省（③ undefined = js-backend-fetch）", () => {
    const full = effectiveLifecycleSlots({ hooks: { script: "full" } }, { loader });
    expect(full.auth).toEqual({ script: "full" });
    expect(full.headersScript).toEqual({ name: "full" });
    expect(full.request).toEqual({ script: "full" });
    expect(full.response).toEqual({ script: "full" });

    const partial = effectiveLifecycleSlots({ hooks: { script: "partial" } }, { loader });
    expect(partial.auth).toEqual({ script: "partial" });
    expect(partial.headersScript).toEqual({ name: "partial" });
    expect(partial.request).toBeUndefined(); // ③ 缺导出 → js-backend-fetch
    expect(partial.response).toBeUndefined();

    const none = effectiveLifecycleSlots({ hooks: { script: "none" } }, { loader });
    expect(none.auth).toBeUndefined();
    expect(none.request).toBeUndefined(); // 入口校验会拦，解析层防御回退
  });

  it("自定义模式原样透传；双模式同现（数据面防御）逐槽胜", () => {
    const custom = effectiveLifecycleSlots(
      { auth: { literal: "tok" }, request: { script: "rust-fetch" } },
      { loader },
    );
    expect(custom.auth).toEqual({ literal: "tok" });
    expect(custom.request).toEqual({ script: "rust-fetch" });
    expect(custom.headersScript).toBeUndefined();

    const clash = effectiveLifecycleSlots(
      { auth: { literal: "tok" }, hooks: { script: "full" } },
      { loader },
    );
    expect(clash.auth).toEqual({ literal: "tok" }); // 逐槽胜（防御）
    expect(clash.request).toEqual({ script: "full" }); // 未被逐槽占用的阶段走整段
  });

  it("args 透传到各阶段绑定", () => {
    const eff = effectiveLifecycleSlots({ hooks: { script: "full", args: { k: "v" } } }, { loader });
    expect(eff.auth).toEqual({ script: "full", args: { k: "v" } });
    expect(eff.headersScript).toEqual({ name: "full", args: { k: "v" } });
  });

  it("scriptHasStageExports：有阶段导出 true；无导出/缺脚本 false", () => {
    expect(scriptHasStageExports("full", { loader })).toBe(true);
    expect(scriptHasStageExports("partial", { loader })).toBe(true);
    expect(scriptHasStageExports("none", { loader })).toBe(false);
    expect(scriptHasStageExports("ghost", { loader })).toBe(false);
  });
});

describe("detail：hooks 位掩码", () => {
  it("预设模式披露 hooks.script = ●（脚本名与 args 不出网）", () => {
    const detail = buildServiceDetail({
      upstream: "https://u.test",
      match: MATCH,
      hooks: { script: "codex", args: { k: "v" } },
    });
    expect(detail.hooks).toEqual({ script: SERVICE_VALUE_MASK });
    expect(JSON.stringify(detail)).not.toContain("codex");
    expect(JSON.stringify(detail)).not.toContain("\"k\"");
  });
});
