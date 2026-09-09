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
  deriveModelsDevPresets,
  fetchModelsDevPresets,
  loadCuratedPresets,
  modelsDevCachePath,
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
    expect(curated.length).toBeGreaterThanOrEqual(18);
    for (const preset of curated) {
      expect(preset.baseUrl).toMatch(/^https?:\/\//);
      expect(preset.defaultPort).toBeGreaterThanOrEqual(1024); // 特权端口须避开
      expect(preset.matchDomains.length).toBeGreaterThanOrEqual(1);
      expect(preset.source).toMatch(/^https?:\/\//);
    }
  });

  it("covers the spec-mandated provider list", () => {
    const ids = new Set(loadCuratedPresets().map((p) => p.id));
    const required = [
      "openai",
      "anthropic",
      "gemini",
      "openrouter",
      "deepseek",
      "zai",
      "zai-coding",
      "zai-cn",
      "moonshot",
      "moonshot-anthropic",
      "minimax",
      "qwen-token-plan",
      "github-copilot",
      "groq",
      "xai",
      "together",
      "ollama",
      "lmstudio",
    ];
    for (const id of required) expect(ids.has(id), `missing preset: ${id}`).toBe(true);
  });

  it("has unique ids and ports", () => {
    const curated = loadCuratedPresets();
    expect(new Set(curated.map((p) => p.id)).size).toBe(curated.length);
    expect(new Set(curated.map((p) => p.defaultPort)).size).toBe(curated.length);
  });

  it("local runtime templates carry no keyEnv", () => {
    const curated = loadCuratedPresets();
    for (const id of ["ollama", "lmstudio"]) {
      const preset = curated.find((p) => p.id === id);
      expect(preset).toBeDefined();
      expect(preset!.keyEnv).toBeUndefined();
    }
    // 远端预设都有 keyEnv 建议
    for (const preset of curated.filter((p) => p.id !== "ollama" && p.id !== "lmstudio")) {
      expect(preset.keyEnv, `${preset.id} should declare keyEnv`).toBeDefined();
    }
  });

  it("covers all three api forms (protocol diversity)", () => {
    const forms = new Set(loadCuratedPresets().map((p) => p.apiForm));
    expect(forms.has("openai-completions")).toBe(true);
    expect(forms.has("anthropic-messages")).toBe(true);
    expect(forms.has("gemini-native")).toBe(true);
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
