// 消费侧连通测试单测（M3-r4）：注入 fetch 断言三种 API 标准的最小请求形状
// （URL = 本地标准前缀 + 官方版本段；不带 authorization）；2xx/4xx/传输失败
// 三形态的结果归纳。

import { describe, expect, it } from "vitest";
import { testLocalService } from "../../../src/consumer/local-test.ts";

function makeResponse(status: number, body = ""): Response {
  return new Response(body, { status });
}

function captureFetch(): { impl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return makeResponse(200, '{"ok":true}');
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("testLocalService 请求形状", () => {
  it("openai-chat：POST :port/openai/v1/chat/completions，无凭据头", async () => {
    const { impl, calls } = captureFetch();
    const result = await testLocalService({ port: 4304, form: "openai-chat", model: "deepseek-chat", fetchImpl: impl, now: () => 1000 });
    expect(result.ok).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.request).toEqual({
      method: "POST",
      url: "http://127.0.0.1:4304/v1/chat/completions",
      model: "deepseek-chat",
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBe("deepseek-chat");
  });

  it("openai-responses：POST :port/responses/v1/responses", async () => {
    const { impl, calls } = captureFetch();
    await testLocalService({ port: 4300, form: "openai-responses", fetchImpl: impl, now: () => 1000 });
    expect(calls[0]!.url).toBe("http://127.0.0.1:4300/v1/responses");
  });

  it("anthropic：POST :port/anthropic/v1/messages + anthropic-version 头", async () => {
    const { impl, calls } = captureFetch();
    await testLocalService({ port: 4304, form: "anthropic", fetchImpl: impl, now: () => 1000 });
    expect(calls[0]!.url).toBe("http://127.0.0.1:4304/anthropic/v1/messages");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("模型缺省：body 不带 model 字段，request.model 缺席", async () => {
    const { impl, calls } = captureFetch();
    const result = await testLocalService({ port: 4304, form: "openai-chat", fetchImpl: impl, now: () => 1000 });
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBeUndefined();
    expect(result.request.model).toBeUndefined();
  });

  it("提示词缺省 ping、content 覆盖（M3-r8 单轮输入框）", async () => {
    const a = captureFetch();
    await testLocalService({ port: 1, form: "openai-chat", fetchImpl: a.impl, now: () => 0 });
    expect(JSON.parse(String(a.calls[0]!.init.body)).messages[0].content).toBe("ping");
    const b = captureFetch();
    await testLocalService({ port: 1, form: "anthropic", fetchImpl: b.impl, content: "hi", now: () => 0 });
    expect(JSON.parse(String(b.calls[0]!.init.body)).messages[0].content).toBe("hi");
    const c = captureFetch();
    await testLocalService({ port: 1, form: "openai-responses", fetchImpl: c.impl, content: "hello", now: () => 0 });
    expect(JSON.parse(String(c.calls[0]!.init.body)).input).toBe("hello");
  });

  it("显式端点路径（localPrefix）拼进请求 URL", async () => {
    const { impl, calls } = captureFetch();
    await testLocalService({ port: 4390, form: "openai-chat", localPrefix: "/relay", fetchImpl: impl, now: () => 0 });
    expect(calls[0]!.url).toBe("http://127.0.0.1:4390/relay/chat/completions");
  });
});

describe("testLocalService 结果归纳", () => {
  it("非 2xx：ok=false + httpStatus + 正文摘录", async () => {
    const impl = (async () =>
      makeResponse(404, '{"error":{"message":"model not found"}}')) as unknown as typeof fetch;
    const result = await testLocalService({ port: 1, form: "openai-chat", fetchImpl: impl, now: () => 0 });
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(404);
    expect(result.bodyExcerpt).toContain("model not found");
  });

  it("2xx：ok=true 且读模型回复正文（M3-r8 聊天面板呈现）", async () => {
    const impl = (async () =>
      makeResponse(200, '{"choices":[{"message":{"content":"hello there"}}]}')) as unknown as typeof fetch;
    const result = await testLocalService({ port: 1, form: "openai-chat", fetchImpl: impl, now: () => 0 });
    expect(result.ok).toBe(true);
    expect(result.bodyExcerpt).toContain("hello there");
  });

  it("传输失败（网关未运行）：ok=false + error，无 httpStatus", async () => {
    const impl = (async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await testLocalService({ port: 1, form: "anthropic", fetchImpl: impl, now: () => 0 });
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBeUndefined();
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("5xx 归纳为 upstream/gateway error 摘要", async () => {
    const impl = (async () => makeResponse(503, "provider offline")) as unknown as typeof fetch;
    const result = await testLocalService({ port: 1, form: "openai-chat", fetchImpl: impl, now: () => 0 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("HTTP 503");
  });
});
