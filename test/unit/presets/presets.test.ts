// 预设库单测：精选集数据契约（presets spec 清单/字段规则）、apiForm 归类、
// 端口派生、models.dev 派生与缓存回退（fixture 缓存路径注入——无网络依赖）。

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MODELS_DEV_CACHE_TTL_MS,
  classifyApiForm,
  derivedPortFor,
  deriveModels,
  deriveModelsDevPresets,
  fetchModelsDevPresets,
  findModelsDevProviderKey,
  isChatModelId,
  loadCuratedPresets,
  modelsDevCachePath,
  readModelsDevRaw,
} from "../../../presets/models-dev.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aifly-presets-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 精选集（presets spec「预设数据契约」）
// ---------------------------------------------------------------------------

describe("curated presets", () => {
  it("loads and validates against the contract schema", () => {
    const curated = loadCuratedPresets();
    expect(curated.length).toBeGreaterThanOrEqual(3);
    for (const preset of curated) {
      expect(preset.baseUrl).toMatch(/^https?:\/\//);
      expect(preset.defaultPort).toBeGreaterThanOrEqual(1024); // 特权端口须避开
      expect(preset.matchDomains.length).toBeGreaterThanOrEqual(1);
      expect(preset.source).toMatch(/^https?:\/\//);
    }
  });

  it("covers the M3-r4 curated list (OpenAI/Anthropic/DeepSeek)", () => {
    const ids = new Set(loadCuratedPresets().map((p) => p.id));
    const required = ["openai", "anthropic", "deepseek"];
    for (const id of required) expect(ids.has(id), `missing preset: ${id}`).toBe(true);
  });

  it("covers the hooks-lifecycle frozen list (复核 R2-F5)：全部 16 家在册", () => {
    const ids = new Set(loadCuratedPresets().map((p) => p.id));
    // spec 冻结清单：OpenAI、Anthropic、Gemini、OpenRouter、DeepSeek、z.ai 双端点
    // (coding/国内站)、Kimi 双协议、Minimax、Qwen token-plan、Copilot、groq、
    // xai、together、Ollama、LM Studio（+ codex 订阅模板）。
    const required = [
      "openai", "anthropic", "gemini", "openrouter", "deepseek",
      "zai-coding", "zai-cn", // z.ai coding/国内站双端点
      "moonshot", // Kimi 双协议（openai + anthropic 双路由）
      "minimax", "qwen-token-plan", "github-copilot",
      "groq", "xai", "together", "ollama", "lmstudio", "codex",
    ];
    for (const id of required) expect(ids.has(id), `missing preset: ${id}`).toBe(true);
  });

  it("codex 预设走预设模式（rust-fetch-sidecar）：hooks 整段绑定、无 auth 槽", () => {
    const codex = loadCuratedPresets().find((p) => p.id === "codex")!;
    expect(codex.hooks).toEqual({ script: "codex" });
    expect(codex.auth).toBeUndefined();
    expect(codex.keyEnv).toBeUndefined(); // 凭据来自 ~/.codex/auth.json（脚本只读）
  });

  it("hooks-lifecycle 冻结面形状：本地模板无 keyEnv；Kimi 双协议双路由；本地运行时走 http", () => {
    const curated = loadCuratedPresets();
    for (const id of ["ollama", "lmstudio"]) {
      const p = curated.find((x) => x.id === id)!;
      expect(p.keyEnv, `${id} is a local runtime template - no keyEnv`).toBeUndefined();
      expect(p.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    }
    const moonshot = curated.find((p) => p.id === "moonshot")!;
    expect(moonshot.routes?.some((r) => r.forms.includes("anthropic"))).toBe(true);
    expect(moonshot.routes?.some((r) => r.forms.includes("openai-chat"))).toBe(true);
    // 版本段照抄的 baseUrl（探测/请求构造按版本段感知，不重复补 /v1）
    expect(curated.find((p) => p.id === "minimax")!.baseUrl).toBe("https://api.minimax.io/anthropic/v1");
    expect(curated.find((p) => p.id === "zai-coding")!.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
  });

  it("M3-r4 按标准路由：deepseek 三路由（含 responses，官方支持 codex）、openai 双 openai 形态", () => {
    const curated = loadCuratedPresets();
    const deepseek = curated.find((p) => p.id === "deepseek")!;
    expect(deepseek.routes).toEqual([
      { forms: ["openai-chat", "openai-responses"], localPrefix: "/v1", upstreamPrefix: "/v1" },
      { forms: ["anthropic"], localPrefix: "/anthropic", upstreamPrefix: "/anthropic" },
    ]);
    const openai = curated.find((p) => p.id === "openai")!;
    expect(openai.routes).toEqual([
      { forms: ["openai-chat", "openai-responses"], localPrefix: "/v1", upstreamPrefix: "/v1" },
    ]);
    const anthropic = curated.find((p) => p.id === "anthropic")!;
    expect(anthropic.routes).toEqual([{ forms: ["anthropic"], localPrefix: "/v1", upstreamPrefix: "/v1" }]);
  });

  it("has unique ids and ports", () => {
    const curated = loadCuratedPresets();
    expect(new Set(curated.map((p) => p.id)).size).toBe(curated.length);
    expect(new Set(curated.map((p) => p.defaultPort)).size).toBe(curated.length);
  });

  it("curated presets declare a credential source (keyEnv or auth)", () => {
    for (const preset of loadCuratedPresets()) {
      // 本地运行时模板（Ollama/LM Studio，回环 baseUrl）无 keyEnv——spec 冻结豁免
      const isLocalRuntime = /^http:\/\/(127\.0\.0\.1|localhost)/.test(preset.baseUrl);
      // hooks-lifecycle 6.3：凭据源为 preset.auth（v2 槽位直吐）或 keyEnv 建议
      expect(
        isLocalRuntime ||
          preset.keyEnv !== undefined ||
          preset.auth !== undefined ||
          preset.hooks !== undefined,
        `${preset.id} should declare keyEnv, auth or hooks`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 归类与端口派生
// ---------------------------------------------------------------------------

describe("classifyApiForm", () => {
  it("maps npm packages per spec", () => {
    expect(classifyApiForm("@ai-sdk/openai-compatible")).toEqual({
      apiForm: "openai-completions",
      unverified: false,
    });
    expect(classifyApiForm("@ai-sdk/anthropic")).toEqual({
      apiForm: "anthropic-messages",
      unverified: false,
    });
    expect(classifyApiForm("@ai-sdk/google")).toEqual({ apiForm: "gemini-native", unverified: false });
    expect(classifyApiForm("@ai-sdk/openai")).toEqual({
      apiForm: "openai-completions",
      unverified: false,
    });
    expect(classifyApiForm("@openrouter/ai-sdk-provider")).toEqual({
      apiForm: "openai-completions",
      unverified: true, // spec：非 openai-compatible/anthropic/google 的 npm 归「其它」并标 unverified
    });
    expect(classifyApiForm("@ai-sdk/something-else")).toEqual({
      apiForm: "openai-completions",
      unverified: true,
    });
    expect(classifyApiForm(undefined)).toEqual({ apiForm: "openai-completions", unverified: true });
  });
});

describe("derivedPortFor", () => {
  it("is deterministic and unprivileged", () => {
    expect(derivedPortFor("some-provider")).toBe(derivedPortFor("some-provider"));
    expect(derivedPortFor("openai")).toBeGreaterThanOrEqual(20000);
    expect(derivedPortFor("openai")).toBeLessThan(65000);
  });
});

// ---------------------------------------------------------------------------
// models.dev 派生与缓存
// ---------------------------------------------------------------------------

const FIXTURE_RAW = JSON.stringify({
  openai: { id: "openai", name: "OpenAI", npm: "@ai-sdk/openai" }, // 无 api：跳过
  "some-llm": {
    id: "some-llm",
    name: "Some LLM",
    api: "https://api.some-llm.example/v1",
    env: ["SOME_LLM_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
  },
  "weird-protocol": {
    id: "weird-protocol",
    name: "Weird",
    api: "https://api.weird.example",
    npm: "@ai-sdk/exotic",
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    api: "https://api.deepseek.com",
    env: ["DEEPSEEK_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
  },
});

describe("deriveModelsDevPresets", () => {
  it("skips entries without explicit api, excludes curated ids, marks unverified", () => {
    const presets = deriveModelsDevPresets(FIXTURE_RAW, new Set(["deepseek"]));
    const ids = presets.map((p) => p.id);
    expect(ids).toContain("some-llm");
    expect(ids).toContain("weird-protocol");
    expect(ids).not.toContain("openai"); // 无 api
    expect(ids).not.toContain("deepseek"); // 精选集胜出
    const weird = presets.find((p) => p.id === "weird-protocol")!;
    expect(weird.unverified).toBe(true);
    expect(weird.apiForm).toBe("openai-completions");
    const some = presets.find((p) => p.id === "some-llm")!;
    expect(some.unverified).toBeUndefined();
    expect(some.keyEnv).toBe("SOME_LLM_API_KEY");
    expect(some.source).toBe("models.dev");
    expect(some.matchDomains).toEqual(["api.some-llm.example"]);
  });
});

// ---------------------------------------------------------------------------
// 模型清单与价格（deriveModels / findModelsDevProviderKey）
// ---------------------------------------------------------------------------

const MODELS_FIXTURE_RAW = JSON.stringify({
  "some-llm": {
    id: "some-llm",
    name: "Some LLM",
    api: "https://api.some-llm.example/v1",
    npm: "@ai-sdk/openai-compatible",
    models: {
      "pricey-chat": { id: "pricey-chat", name: "Pricey", cost: { input: 10, output: 20 } },
      "mid-chat": { id: "mid-chat", cost: { input: 1, output: 1 } },
      "cheap-chat": { id: "cheap-chat", cost: { input: 0.1, output: 0.2 } },
      "unpriced-chat": { id: "unpriced-chat", name: "No Price" },
      "half-priced": { id: "half-priced", cost: { input: 0.5 } }, // 只有 input：未知价
      "cheap-embed": { id: "text-embedding-3", cost: { input: 0.01, output: 0.01 } },
      "image-gen": { id: "dall-e-3", cost: { input: 0.001, output: 0 } },
      "unpriced-embed": { id: "whisper-1" },
    },
  },
  empty: { id: "empty", api: "https://api.empty.example" }, // 无 models
});

describe("deriveModels", () => {
  it("排序：chat 价已知升序 -> chat 未价 -> non-chat 价已知 -> non-chat 未价", () => {
    const models = deriveModels(MODELS_FIXTURE_RAW, "some-llm")!;
    expect(models.map((m) => m.id)).toEqual([
      "cheap-chat", // 0.3
      "mid-chat", // 2
      "pricey-chat", // 30
      "half-priced", // 只有 input：未知价，chat 未价组（按 id 排）
      "unpriced-chat", // 未知价，chat 未价组
      "dall-e-3", // non-chat 价已知（0.001）
      "text-embedding-3", // non-chat 价已知（0.02）
      "whisper-1", // non-chat 未价
    ]);
    const first = models[0]!;
    expect(first.id).toBe("cheap-chat");
    expect(first.priced).toBe(true);
    expect(first.chat).toBe(true);
    expect(first.pricePerMTok).toBeCloseTo(0.3, 10);
    expect(models[3]!).toMatchObject({ id: "half-priced", priced: false, chat: true });
    expect(models[3]!.pricePerMTok).toBeUndefined();
    expect(models[1]!.name).toBeUndefined(); // name 缺省省略
    expect(models.find((m) => m.id === "pricey-chat")!.name).toBe("Pricey");
  });

  it("最便宜 chat 模型排首位（spec Scenario）", () => {
    expect(deriveModels(MODELS_FIXTURE_RAW, "some-llm")![0]!.id).toBe("cheap-chat");
  });

  it("chat 启发式（id 词族）", () => {
    expect(isChatModelId("gpt-4o")).toBe(true);
    expect(isChatModelId("claude-sonnet-4")).toBe(true);
    for (const nonChat of [
      "text-embedding-3-large",
      "gpt-image-1",
      "whisper-1",
      "tts-1-hd",
      "rerank-v2",
      "omni-moderation-latest",
      "dall-e-3",
      "sd3.5-large",
    ]) {
      expect(isChatModelId(nonChat), nonChat).toBe(false);
    }
  });

  it("provider 不在清单 -> undefined；空 models -> []（两者语义区分）", () => {
    expect(deriveModels(MODELS_FIXTURE_RAW, "nope")).toBeUndefined();
    expect(deriveModels(MODELS_FIXTURE_RAW, "empty")).toEqual([]);
  });

  it("防御式：cost 非法值不炸（整清单该条目按未知价或跳过）", () => {
    const raw = JSON.stringify({
      p: {
        id: "p",
        models: {
          ok: { id: "ok", cost: { input: 1, output: 1 } },
          weird: { id: "weird", extra: "ignored", cost: { input: 1, output: 1, currency: "USD" } },
        },
      },
    });
    const models = deriveModels(raw, "p")!;
    expect(models).toHaveLength(2);
    expect(models.every((m) => m.priced)).toBe(true);
  });
});

describe("findModelsDevProviderKey", () => {
  it("精确命中 > 路径前缀 > 主机名；未命中 undefined", () => {
    expect(findModelsDevProviderKey(MODELS_FIXTURE_RAW, "https://api.some-llm.example/v1")).toBe("some-llm");
    // 前缀（upstream 比 api 短/长都算）
    expect(findModelsDevProviderKey(MODELS_FIXTURE_RAW, "https://api.some-llm.example/v1/")).toBe("some-llm");
    expect(findModelsDevProviderKey(MODELS_FIXTURE_RAW, "https://api.some-llm.example")).toBe("some-llm");
    // 主机名兜底
    expect(findModelsDevProviderKey(MODELS_FIXTURE_RAW, "https://api.some-llm.example/other")).toBe("some-llm");
    expect(findModelsDevProviderKey(MODELS_FIXTURE_RAW, "https://api.other.example")).toBeUndefined();
  });

  it("同主机多候选：长 api（更具体）胜出", () => {
    const raw = JSON.stringify({
      a: { id: "a", api: "https://x.example.com", models: {} },
      b: { id: "b", api: "https://x.example.com/specific", models: {} },
    });
    expect(findModelsDevProviderKey(raw, "https://x.example.com/specific/deeper")).toBe("b");
  });

  it("非 JSON 原文 -> undefined（不抛）", () => {
    expect(findModelsDevProviderKey("{not json", "https://api.example.com")).toBeUndefined();
  });
});

describe("readModelsDevRaw", () => {
  it("读缓存原始文本；损坏/不存在返回 undefined", () => {
    const cachePath = join(dir, "raw-cache", "models-dev.json");
    expect(readModelsDevRaw(cachePath)).toBeUndefined();
    mkdirSync(join(dir, "raw-cache"), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ fetchedAt: 5, raw: FIXTURE_RAW }));
    expect(readModelsDevRaw(cachePath)).toBe(FIXTURE_RAW);
    writeFileSync(cachePath, "{broken");
    expect(readModelsDevRaw(cachePath)).toBeUndefined();
  });
});

describe("fetchModelsDevPresets", () => {
  const fetchOk: typeof fetch = async () =>
    new Response(FIXTURE_RAW, { status: 200, headers: { "content-type": "application/json" } });
  const fetchDead: typeof fetch = async () => {
    throw new Error("network down");
  };

  it("fetches, caches, then serves from cache within TTL", async () => {
    const cachePath = join(dir, "cache", "models-dev.json");
    let t = 1_000_000;
    const now = () => t;
    const first = await fetchModelsDevPresets([], { cachePath, fetchImpl: fetchOk, now });
    expect(first.origin).toBe("fetch");
    expect(first.presets.map((p) => p.id)).toContain("some-llm");
    expect(existsSync(cachePath)).toBe(true);
    const cachedRaw = JSON.parse(readFileSync(cachePath, "utf8")) as { fetchedAt: number; raw: string };
    expect(cachedRaw.raw).toBe(FIXTURE_RAW);

    // TTL 内：fetch 死了也走缓存
    const second = await fetchModelsDevPresets([], { cachePath, fetchImpl: fetchDead, now });
    expect(second.origin).toBe("cache");
    expect(second.error).toBeUndefined();
    expect(second.presets.map((p) => p.id)).toContain("some-llm");
  });

  it("refetches after TTL expiry and falls back to cache on failure", async () => {
    const cachePath = join(dir, "cache2", "models-dev.json");
    let t = 1_000_000;
    const now = () => t;
    await fetchModelsDevPresets([], { cachePath, fetchImpl: fetchOk, now });
    t += MODELS_DEV_CACHE_TTL_MS + 1;
    const expired = await fetchModelsDevPresets([], { cachePath, fetchImpl: fetchDead, now });
    expect(expired.origin).toBe("cache");
    expect(expired.error).toMatch(/fetch failed/);
  });

  it("reports error when offline with no cache (curated set stays usable upstream)", async () => {
    const cachePath = join(dir, "nope", "models-dev.json");
    const result = await fetchModelsDevPresets([], { cachePath, fetchImpl: fetchDead, now: () => 5 });
    expect(result.presets).toEqual([]);
    expect(result.error).toMatch(/no cache available/);
  });

  it("force bypasses a fresh cache", async () => {
    const cachePath = join(dir, "cache3", "models-dev.json");
    let calls = 0;
    const countingFetch: typeof fetch = async (input) => {
      calls++;
      return fetchOk(input);
    };
    await fetchModelsDevPresets([], { cachePath, fetchImpl: countingFetch, now: () => 5 });
    await fetchModelsDevPresets([], { cachePath, fetchImpl: countingFetch, now: () => 6, force: true });
    expect(calls).toBe(2);
  });

  it("writes cache files under a private directory (0600-equivalent path shape)", async () => {
    const base = join(dir, "home");
    const cachePath = modelsDevCachePath(base);
    await fetchModelsDevPresets([], { cachePath, fetchImpl: fetchOk, now: () => 5 });
    expect(existsSync(join(base, ".aifly", "cache", "models-dev.json"))).toBe(true);
  });

  it("recovers from a corrupt cache file via refetch", async () => {
    const cachePath = join(dir, "cache4", "models-dev.json");
    mkdirSync(join(dir, "cache4"), { recursive: true });
    writeFileSync(cachePath, "{not json");
    const result = await fetchModelsDevPresets([], { cachePath, fetchImpl: fetchOk, now: () => 5 });
    expect(result.origin).toBe("fetch");
  });
});
