// rewrite 单测（表驱动）：URL 拼接（base path + strip/append）、双重断言（//host
// origin 逃逸与 /../../admin 回溯越界 -> RewriteError）、$env 头链矩阵（设置/空串/
// 未设置）、Host 缺省与覆盖、headerRemove/headerSet、凭据头纵深剥离、WS 升级识别。

import { describe, expect, it } from "vitest";
import type { ReqHeader } from "../../../src/wire/frames.ts";
import { buildUpstreamRequest, isWebSocketUpgradeRequest, RewriteError } from "../../../src/provider/rewrite.ts";
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
