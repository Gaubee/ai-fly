// upstream-test 单测（m3 MODELS-TEST 5.2）：三 apiForm 最小请求形状（URL/头/正文，
// fetchImpl 捕获断言——零真实网络）、密钥缺失结果级失败、模型缺省（api.json 按
// upstream 定位 provider 取 priced chat 最低价；清单不可用要求显式指定）、非 2xx、
// 网络错误摘要不含密钥、整体超时（AbortController 小值注入）。

import { describe, expect, it } from "vitest";
import { testUpstream } from "../../../src/provider/upstream-test.ts";

interface Captured {
  url: string;
  init: RequestInit;
}

function captureFetch(status = 200): { calls: Captured[]; fetchImpl: typeof fetch } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("{}", { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const SECRETS = { get: (name: string): string | undefined => (name === "ok" ? "Bearer sk-1" : undefined) };

const MODELS_RAW = JSON.stringify({
  "some-llm": {
    id: "some-llm",
    api: "https://api.some-llm.example/v1",
    models: {
      "cheap-chat": { id: "cheap-chat", cost: { input: 0.1, output: 0.2 } },
      "pricey-chat": { id: "pricey-chat", cost: { input: 10, output: 20 } },
      "mid-chat": { id: "mid-chat", cost: { input: 1, output: 1 } },
      "unpriced-chat": { id: "unpriced-chat" },
      "embed-3": { id: "embed-3", cost: { input: 0.01, output: 0.01 } },
    },
  },
});

describe("testUpstream 请求形状", () => {
  it("openai-completions：POST {upstream}/chat/completions + authorization + ping 单轮 + max_tokens 1", async () => {
    const { calls, fetchImpl } = captureFetch();
    const result = await testUpstream({
      upstream: "https://api.example.com/v1",
      apiForm: "openai-completions",
      secretName: "ok",
      model: "gpt-x",
      fetchImpl,
      secretsStore: SECRETS,
    });
    expect(result).toMatchObject({ ok: true, httpStatus: 200, model: "gpt-x" });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.example.com/v1/chat/completions");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-1");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: "gpt-x",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    });
  });

  it("upstream 去尾斜杠后拼接", async () => {
    const { calls, fetchImpl } = captureFetch();
    await testUpstream({ upstream: "https://api.example.com/v1/", model: "m", fetchImpl });
    expect(calls[0]!.url).toBe("https://api.example.com/v1/chat/completions");
  });

  it("anthropic-messages：/v1/messages + anthropic-version 头", async () => {
    const { calls, fetchImpl } = captureFetch();
    await testUpstream({
      upstream: "https://api.anthropic.com",
      apiForm: "anthropic-messages",
      secretName: "ok",
      model: "claude-x",
      fetchImpl,
      secretsStore: SECRETS,
    });
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-1");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: "claude-x",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    });
  });

  it("gemini-native：generateContent URL + x-goog-api-key；无 secret 则不带密钥头", async () => {
    const withSecret = captureFetch();
    await testUpstream({
      upstream: "https://gen.example.com",
      apiForm: "gemini-native",
      secretName: "ok",
      model: "gemini-x",
      fetchImpl: withSecret.fetchImpl,
      secretsStore: SECRETS,
    });
    expect(withSecret.calls[0]!.url).toBe("https://gen.example.com/v1beta/models/gemini-x:generateContent");
    const headers = withSecret.calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("Bearer sk-1");
    expect(headers["authorization"]).toBeUndefined();
    expect(JSON.parse(String(withSecret.calls[0]!.init.body))).toEqual({
      contents: [{ parts: [{ text: "ping" }] }],
      generationConfig: { maxOutputTokens: 1 },
    });

    const noSecret = captureFetch();
    await testUpstream({
      upstream: "https://gen.example.com",
      apiForm: "gemini-native",
      model: "gemini-x",
      fetchImpl: noSecret.fetchImpl,
    });
    const bare = noSecret.calls[0]!.init.headers as Record<string, string>;
    expect(bare["x-goog-api-key"]).toBeUndefined();
    expect(bare["authorization"]).toBeUndefined();
  });

  it("apiForm 缺省 openai-completions", async () => {
    const { calls, fetchImpl } = captureFetch();
    await testUpstream({ upstream: "https://api.example.com", model: "m", fetchImpl });
    expect(calls[0]!.url).toBe("https://api.example.com/chat/completions");
  });
});

describe("testUpstream 密钥与模型缺省", () => {
  it("密钥缺失 -> { ok:false, error:'secret not found' }（不抛、零 fetch）", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("{}");
    }) as typeof fetch;
    const result = await testUpstream({
      upstream: "https://api.example.com",
      secretName: "ghost",
      model: "m",
      fetchImpl,
      secretsStore: SECRETS,
    });
    expect(result).toMatchObject({ ok: false, error: "secret not found", model: "m" });
    expect(calls).toBe(0);
  });

  it("模型缺省：api.json 定位 provider 取 priced chat 最低价（non-chat 更便宜也不选）", async () => {
    const { calls, fetchImpl } = captureFetch();
    const result = await testUpstream({
      upstream: "https://api.some-llm.example/v1",
      fetchImpl,
      modelsRaw: MODELS_RAW,
    });
    expect(result.model).toBe("cheap-chat");
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBe("cheap-chat");
  });

  it("模型缺省：upstream 主机命中 api.json（无显式 api 精确匹配时）", async () => {
    const raw = JSON.stringify({
      p: { id: "p", api: "https://api.some-llm.example/other/path", models: { m1: { id: "m1", cost: { input: 1, output: 1 } } } },
    });
    const { fetchImpl } = captureFetch();
    const result = await testUpstream({
      upstream: "https://api.some-llm.example/v1",
      fetchImpl,
      modelsRaw: raw,
    });
    expect(result.model).toBe("m1");
  });

  it("清单不可用且未指定模型 -> 结果级失败", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("{}");
    }) as typeof fetch;
    const noRaw = await testUpstream({ upstream: "https://api.unknown.example", fetchImpl });
    expect(noRaw).toMatchObject({ ok: false, error: "model list unavailable; specify a model" });
    const unknownProvider = await testUpstream({
      upstream: "https://api.unknown.example",
      fetchImpl,
      modelsRaw: MODELS_RAW,
    });
    expect(unknownProvider.ok).toBe(false);
    expect(calls).toBe(0);
  });
});

describe("testUpstream 结果语义", () => {
  it("非 2xx -> ok:false 且带 httpStatus 与 error", async () => {
    const { fetchImpl } = captureFetch(401);
    const result = await testUpstream({ upstream: "https://api.example.com", model: "m", fetchImpl });
    expect(result).toMatchObject({ ok: false, httpStatus: 401, model: "m" });
    expect(result.error).toContain("401");
  });

  it("网络错误 -> error 摘要（不含密钥）", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:443");
    }) as typeof fetch;
    const result = await testUpstream({
      upstream: "https://api.example.com",
      secretName: "ok",
      model: "m",
      fetchImpl,
      secretsStore: SECRETS,
    });
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBeUndefined();
    expect(result.error).toContain("ECONNREFUSED");
    expect(result.error).not.toContain("sk-1");
  });

  it("网络错误摘要意外含密钥原文 -> 整段打码（防御式）", async () => {
    const fetchImpl = (async () => {
      throw new Error("boom Bearer sk-1 leaked");
    }) as typeof fetch;
    const result = await testUpstream({
      upstream: "https://api.example.com",
      secretName: "ok",
      model: "m",
      fetchImpl,
      secretsStore: SECRETS,
    });
    expect(result.error).not.toContain("sk-1");
  });

  it("整体超时（timeoutMs 注入）-> request timed out", async () => {
    const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const result = await testUpstream({
      upstream: "https://slow.example.com",
      model: "m",
      fetchImpl,
      timeoutMs: 30,
    });
    expect(result).toMatchObject({ ok: false, error: "request timed out", model: "m" });
  });
});
