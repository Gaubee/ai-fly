// rewrite 单测（表驱动）：URL 拼接（base path + strip/append）、双重断言（//host
// origin 逃逸与 /../../admin 回溯越界 -> RewriteError）、$env 头链矩阵（设置/空串/
// 未设置）、Host 缺省与覆盖、headerRemove/headerSet、凭据头纵深剥离、WS 升级识别。

import { describe, expect, it } from "vitest";
import type { ReqHeader } from "../../../src/wire/frames.ts";
import {
  buildUpstreamRequest,
  isWebSocketUpgradeRequest,
  resolveHeaderValue,
  RewriteError,
  SecretMissingError,
  PathNotOfferedError,
} from "../../../src/provider/rewrite.ts";
import type { ServiceConfig } from "../../../src/provider/store.ts";

function makeService(over: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    serviceId: "svctest",
    name: "test",
    match: [{ type: "suffix", value: ".local" }],
    upstream: "http://127.0.0.1:11434",
    rewrite: undefined,
    defaultPort: 11434,
    ...over,
  };
}

function makeReq(over: Partial<ReqHeader> = {}): ReqHeader {
  return {
    v: 1,
    id: "req1",
    serviceId: "svctest",
    method: "POST",
    path: "/v1/chat",
    bodyLen: 0,
    ...over,
  };
}

describe("URL 构造", () => {
  it("根基础路径 + 请求路径直拼", () => {
    const plan = buildUpstreamRequest(makeService(), makeReq(), {});
    expect(plan.url.href).toBe("http://127.0.0.1:11434/v1/chat");
    expect(plan.host).toBe("127.0.0.1:11434");
  });

  it("上游基础路径保留：/api + /v1/chat -> /api/v1/chat", () => {
    const service = makeService({ upstream: "http://upstream.test:8080/api" });
    const plan = buildUpstreamRequest(service, makeReq(), {});
    expect(plan.url.pathname).toBe("/api/v1/chat");
    expect(plan.host).toBe("upstream.test:8080");
  });

  it("前缀剥离：strip=/ollama + /ollama/v1 -> /v1（不误伤 /ollamax）", () => {
    const service = makeService({ rewrite: { pathPrefixStrip: "/ollama" } });
    expect(buildUpstreamRequest(service, makeReq({ path: "/ollama/v1" }), {}).url.pathname).toBe("/v1");
    expect(buildUpstreamRequest(service, makeReq({ path: "/ollamax" }), {}).url.pathname).toBe("/ollamax");
  });

  it("剥离 + 追加 + 基础路径组合", () => {
    const service = makeService({
      upstream: "http://upstream.test:8080/svc",
      rewrite: { pathPrefixStrip: "/ollama", pathPrefixAppend: "/api" },
    });
    const plan = buildUpstreamRequest(service, makeReq({ path: "/ollama/v1" }), {});
    expect(plan.url.pathname).toBe("/svc/api/v1");
  });

  it("查询串保留", () => {
    const plan = buildUpstreamRequest(makeService(), makeReq({ path: "/v1/x?stream=true&q=1" }), {});
    expect(plan.url.search).toBe("?stream=true&q=1");
  });

  it("默认端口 Host 不带端口（https 443）", () => {
    const service = makeService({ upstream: "https://api.example.com", defaultPort: 8443 });
    expect(buildUpstreamRequest(service, makeReq(), {}).host).toBe("api.example.com");
  });

  it("hostHeader 覆盖 Host", () => {
    const service = makeService({ rewrite: { hostHeader: "internal.alias" } });
    expect(buildUpstreamRequest(service, makeReq(), {}).host).toBe("internal.alias");
  });
});

describe("双重断言（纵深防御：零上游请求语义）", () => {
  it("//host 形态 -> origin 断言拒绝", () => {
    expect(() => buildUpstreamRequest(makeService(), makeReq({ path: "//evil.com/v1/keys" }), {})).toThrow(RewriteError);
  });

  it("/../../admin 回溯 -> 拒绝", () => {
    expect(() => buildUpstreamRequest(makeService(), makeReq({ path: "/../../admin" }), {})).toThrow(RewriteError);
  });

  it("相对段 .. 深层注入（schema 失效兜底）-> 拒绝", () => {
    expect(() => buildUpstreamRequest(makeService(), makeReq({ path: "/a/../../../etc" }), {})).toThrow(RewriteError);
  });

  it("反斜杠形态 -> 拒绝", () => {
    expect(() => buildUpstreamRequest(makeService(), makeReq({ path: "/\\evil" }), {})).toThrow(RewriteError);
  });

  it("基础路径前缀不可逃逸：strip 吞掉基础路径形态仍以基础路径为前缀", () => {
    const service = makeService({ upstream: "http://up.test/base", rewrite: { pathPrefixStrip: "/base" } });
    // /base/base/x -> strip 掉首个 /base -> 拼回 /base/x
    const plan = buildUpstreamRequest(service, makeReq({ path: "/base/base/x" }), {});
    expect(plan.url.pathname).toBe("/base/base/x");
  });
});

describe("$env 头链矩阵", () => {
  const service = makeService({
    rewrite: {
      headerSet: { authorization: "$env:UPSTREAM_KEY", "x-lit": "plain", "x-maybe": "$env:MAYBE" },
    },
  });

  it("已设置 -> 注入；literal 原样", () => {
    const plan = buildUpstreamRequest(service, makeReq(), { UPSTREAM_KEY: "sk-live-123" });
    expect(plan.headers["authorization"]).toBe("sk-live-123");
    expect(plan.headers["x-lit"]).toBe("plain");
  });

  it("空串与未设置同义 -> 该头省略", () => {
    const plan = buildUpstreamRequest(service, makeReq(), { UPSTREAM_KEY: "" });
    expect(plan.headers["authorization"]).toBeUndefined();
    expect(plan.headers["x-maybe"]).toBeUndefined();
    expect(plan.headers["x-lit"]).toBe("plain");
  });

  it("headerRemove 先于 headerSet；帧内同名头可被覆盖", () => {
    const svc = makeService({
      rewrite: { headerRemove: ["x-drop"], headerSet: { "x-custom": "set" } },
    });
    const plan = buildUpstreamRequest(
      svc,
      makeReq({ headers: { "x-drop": "1", "x-custom": "frame", "anthropic-version": "2023-06-01" } }),
      {},
    );
    expect(plan.headers["x-drop"]).toBeUndefined();
    expect(plan.headers["x-custom"]).toBe("set");
    expect(plan.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("凭据类/hop-by-hop/content-length 帧内头纵深剥离", () => {
    const plan = buildUpstreamRequest(
      makeService(),
      makeReq({ headers: { authorization: "Bearer x", cookie: "a=b", host: "evil", connection: "keep-alive", "content-length": "9" } }),
      {},
    );
    expect(plan.headers).toEqual({});
  });

  it("contentType 折叠为 content-type 头", () => {
    const plan = buildUpstreamRequest(makeService(), makeReq({ contentType: "application/json" }), {});
    expect(plan.headers["content-type"]).toBe("application/json");
  });
});

describe("$secret 头链矩阵", () => {
  const service = makeService({
    rewrite: {
      headerSet: {
        authorization: "$secret:openai",
        "x-api-key": "$secret:vendor.key",
        "x-env": "$env:UPSTREAM_KEY",
        "x-lit": "plain",
      },
    },
  });
  const secrets = (name: string): string | undefined =>
    name === "openai" ? "Bearer sk-live-1" : undefined;

  it("命中 -> 注入完整头值；与 $env 并存于不同头；literal 原样", () => {
    const allSecrets = (name: string): string | undefined =>
      name === "openai" ? "Bearer sk-live-1" : name === "vendor.key" ? "sk-vendor" : undefined;
    const plan = buildUpstreamRequest(service, makeReq(), { UPSTREAM_KEY: "sk-env-2" }, allSecrets);
    expect(plan.headers["authorization"]).toBe("Bearer sk-live-1");
    expect(plan.headers["x-api-key"]).toBe("sk-vendor");
    expect(plan.headers["x-env"]).toBe("sk-env-2");
    expect(plan.headers["x-lit"]).toBe("plain");
  });

  it("未知名 -> SecretMissingError（不省略、不回退空值）", () => {
    expect(() => buildUpstreamRequest(service, makeReq(), {}, secrets)).toThrow(SecretMissingError);
  });

  it("未注入密钥源（secrets 缺省）-> 任何 $secret 引用都抛 SecretMissingError", () => {
    expect(() => buildUpstreamRequest(service, makeReq(), {})).toThrow(SecretMissingError);
  });

  it("密钥库值为空串 -> 同未命中", () => {
    expect(() => buildUpstreamRequest(service, makeReq(), {}, () => "")).toThrow(SecretMissingError);
  });

  it("$secret 判定优先于 $env（值以 $secret: 开头时不走 env 路径）", () => {
    // "$secret:openai" 不是合法 env 名——若前缀判定顺序错误，会从 env 取到 undefined 而静默省略。
    const plan = buildUpstreamRequest(
      makeService({ rewrite: { headerSet: { authorization: "$secret:openai" } } }),
      makeReq(),
      {},
      secrets,
    );
    expect(plan.headers["authorization"]).toBe("Bearer sk-live-1");
  });

  it("resolveHeaderValue：$secret 未命中错误信息不含名字与值", () => {
    try {
      resolveHeaderValue("$secret:ghost", {}, secrets);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SecretMissingError);
      expect((err as Error).message).not.toContain("ghost");
      expect((err as Error).message).not.toContain("sk-live");
    }
  });

  it("$env 语义保持：空串/未设置 -> 省略（不抛）", () => {
    const plan = buildUpstreamRequest(
      makeService({ rewrite: { headerSet: { authorization: "$env:NOPE" } } }),
      makeReq(),
      { NOPE: "" },
      secrets,
    );
    expect(plan.headers["authorization"]).toBeUndefined();
  });
});

describe("WS 升级识别", () => {
  it("connection 含 upgrade token + upgrade: websocket（大小写不敏感）", () => {
    expect(isWebSocketUpgradeRequest({ connection: "keep-alive, Upgrade", upgrade: "websocket" })).toBe(true);
    expect(isWebSocketUpgradeRequest({ connection: "Upgrade", upgrade: "WebSocket" })).toBe(true);
  });

  it("非升级请求（缺头 / connection 无 token / 其他协议）", () => {
    expect(isWebSocketUpgradeRequest({})).toBe(false);
    expect(isWebSocketUpgradeRequest({ connection: "keep-alive", upgrade: "websocket" })).toBe(false);
    expect(isWebSocketUpgradeRequest({ connection: "upgrade", upgrade: "h2c" })).toBe(false);
  });

  it("plan.isWebSocketUpgrade 分流标记", () => {
    const plan = buildUpstreamRequest(
      makeService(),
      makeReq({ headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13" } }),
      {},
    );
    expect(plan.isWebSocketUpgrade).toBe(true);
    expect(buildUpstreamRequest(makeService(), makeReq(), {}).isWebSocketUpgrade).toBe(false);
  });
});

describe("路径路由（M3-r6：通用 from→to 规则 + 白名单）", () => {
  // DeepSeek 预设镜像：/v1 → /v1（openai 家族）、/anthropic → /anthropic，全 1:1
  const deepseek = makeService({
    upstream: "https://api.deepseek.com",
    routes: [
      { forms: ["openai-chat", "openai-responses"], localPrefix: "/v1", upstreamPrefix: "/v1" },
      { forms: ["anthropic"], localPrefix: "/anthropic", upstreamPrefix: "/anthropic" },
    ],
  });

  it("DeepSeek anthropic 形态：/anthropic/v1/messages -> /anthropic/v1/messages（1:1）", () => {
    const plan = buildUpstreamRequest(deepseek, makeReq({ path: "/anthropic/v1/messages" }), {});
    expect(plan.url.href).toBe("https://api.deepseek.com/anthropic/v1/messages");
  });

  it("DeepSeek openai 形态：/v1/chat/completions -> /v1/chat/completions（1:1 官方镜像）", () => {
    const plan = buildUpstreamRequest(deepseek, makeReq({ path: "/v1/chat/completions" }), {});
    expect(plan.url.href).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("段边界：/v1beta 不命中 /v1 路由（不误伤）；/anthropicapi 同理", () => {
    expect(() => buildUpstreamRequest(deepseek, makeReq({ path: "/v1beta/x" }), {})).toThrow(
      PathNotOfferedError,
    );
    expect(() => buildUpstreamRequest(deepseek, makeReq({ path: "/anthropicapi/v1" }), {})).toThrow(
      PathNotOfferedError,
    );
  });

  it("未命中路径拒绝（白名单语义：路由表外零上游请求）", () => {
    expect(() => buildUpstreamRequest(deepseek, makeReq({ path: "/user/balance" }), {})).toThrow(
      PathNotOfferedError,
    );
    expect(() => buildUpstreamRequest(deepseek, makeReq({ path: "/openai/v1/chat/completions" }), {})).toThrow(
      PathNotOfferedError,
    );
  });

  it("自定义 from→to：/foo/x -> /bar/x（解绑态自由映射）", () => {
    const service = makeService({
      upstream: "https://agg.test",
      routes: [{ forms: [], localPrefix: "/foo", upstreamPrefix: "/bar" }],
    });
    expect(buildUpstreamRequest(service, makeReq({ path: "/foo/models" }), {}).url.pathname).toBe("/bar/models");
    expect(() => buildUpstreamRequest(service, makeReq({ path: "/other" }), {})).toThrow(PathNotOfferedError);
  });

  it("localPrefix 缺省派生规范前缀（forms 首项）", () => {
    const service = makeService({
      upstream: "https://api.deepseek.com",
      routes: [
        { forms: ["openai-chat"], upstreamPrefix: "" },
        { forms: ["anthropic"], upstreamPrefix: "/anthropic" },
      ],
    });
    // openai-chat 的 to 为根 ""：/v1/models -> /models（from 前缀被替换掉）
    expect(buildUpstreamRequest(service, makeReq({ path: "/v1/models" }), {}).url.pathname).toBe("/models");
    expect(buildUpstreamRequest(service, makeReq({ path: "/anthropic/v1/messages" }), {}).url.pathname).toBe(
      "/anthropic/v1/messages",
    );
  });

  it("to 为根：/v1/x -> /x", () => {
    const service = makeService({
      upstream: "https://agg.test",
      routes: [{ forms: [], localPrefix: "/v1", upstreamPrefix: "" }],
    });
    expect(buildUpstreamRequest(service, makeReq({ path: "/v1/models" }), {}).url.pathname).toBe("/models");
  });

  it("路由前缀根命中：/anthropic -> upstream /anthropic", () => {
    const plan = buildUpstreamRequest(deepseek, makeReq({ path: "/anthropic" }), {});
    expect(plan.url.pathname).toBe("/anthropic");
  });

  it("upstream 带基础路径时拼接在映射后：base /api + to /v1 + /v1/x -> /api/v1/x", () => {
    const service = makeService({
      upstream: "https://agg.test/api",
      routes: [{ forms: [], localPrefix: "/v1", upstreamPrefix: "/v1" }],
    });
    const plan = buildUpstreamRequest(service, makeReq({ path: "/v1/messages" }), {});
    expect(plan.url.href).toBe("https://agg.test/api/v1/messages");
  });

  it("query 保留在映射后", () => {
    const plan = buildUpstreamRequest(deepseek, makeReq({ path: "/v1/models?list=1" }), {});
    expect(plan.url.pathname).toBe("/v1/models");
    expect(plan.url.search).toBe("?list=1");
  });

  it("无路由服务行为与从前完全一致（回归）", () => {
    const plan = buildUpstreamRequest(makeService(), makeReq({ path: "/v1/chat" }), {});
    expect(plan.url.href).toBe("http://127.0.0.1:11434/v1/chat");
  });
});
