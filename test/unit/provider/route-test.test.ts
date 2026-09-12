// 提供方侧按标准路由测试（src/provider/route-test.ts）：路由命中 + rewrite
// 注入 + 直打 upstream 的最小闭环。假 fetch 记录请求（url/headers/body），
// 断言：前缀路由改写、$secret 注入（Bearer 语义）、白名单未命中零请求、
// 成功也读正文摘录。

import { describe, expect, it } from "vitest";
import { testServiceRoute } from "../../../src/provider/route-test.ts";
import type { ServiceConfig } from "../../../src/provider/store.ts";

function makeService(patch: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    serviceId: "test-service",
    name: "test",
    upstream: "https://api.example.com/",
    match: [{ type: "suffix", value: "api.example.com" }],
    defaultPort: 4300,
    ...patch,
  } as ServiceConfig;
}

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function recorder(status: number, body: string) {
  const calls: Recorded[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe("testServiceRoute（provider 侧按标准路由测试）", () => {
  it("openai-chat + /v1 路由：POST upstream/v1/chat/completions + $secret 注入 Bearer", async () => {
    const { calls, impl } = recorder(200, '{"choices":[{"message":{"content":"hi"}}]}');
    const service = makeService({
      upstream: "https://api.example.com/",
      routes: [{ forms: ["openai-chat", "openai-responses"], localPrefix: "/v1", upstreamPrefix: "/v1" }],
      rewrite: { headerSet: { authorization: { hook: "authHeader", args: { name: "sk-panel" } } } },
    });
    const result = await testServiceRoute({
      service,
      form: "openai-chat",
      content: "hi",
      fetchImpl: impl,
      now: () => 0,
      // SecretSource 契约 = 终值（Bearer 拼接在 SecretsStore.resolve 侧）
      secrets: () => "Bearer raw-key",
    });
    expect(result.ok).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.request.url).toBe("https://api.example.com/v1/chat/completions");
    expect(result.bodyExcerpt).toContain("hi");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer raw-key");
    expect(JSON.parse(calls[0]!.body).messages[0].content).toBe("hi");
  });

  it("anthropic 形态：剥版本段 + anthropic-version 头 + max_tokens", async () => {
    const { calls, impl } = recorder(200, '{"content":[{"type":"text","text":"hey"}]}');
    const service = makeService({
      routes: [{ forms: ["anthropic"], localPrefix: "/anthropic", upstreamPrefix: "/anthropic" }],
    });
    const result = await testServiceRoute({
      service,
      form: "anthropic",
      fetchImpl: impl,
      now: () => 0,
    });
    expect(result.request.url).toBe("https://api.example.com/anthropic/v1/messages");
    expect(calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(JSON.parse(calls[0]!.body).max_tokens).toBe(1024);
    // content 缺省 "hi"
    expect(JSON.parse(calls[0]!.body).messages[0].content).toBe("hi");
  });

  it("白名单未命中：ok=false + path not offered + 零上游请求", async () => {
    const { calls, impl } = recorder(200, "");
    const service = makeService({
      routes: [{ forms: ["openai-chat"], localPrefix: "/v1", upstreamPrefix: "/v1" }],
    });
    const result = await testServiceRoute({
      service,
      form: "anthropic",
      fetchImpl: impl,
      now: () => 0,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("path not offered");
    expect(calls).toHaveLength(0);
  });

  it("非 2xx：ok=false + httpStatus + 错误正文摘录", async () => {
    const { impl } = recorder(401, '{"error":{"message":"Authentication Fails (governor)"}}');
    const result = await testServiceRoute({
      service: makeService(),
      form: "openai-chat",
      fetchImpl: impl,
      now: () => 0,
    });
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(401);
    expect(result.bodyExcerpt).toContain("Authentication Fails");
  });
});
