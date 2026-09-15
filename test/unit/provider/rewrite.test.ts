// rewrite 单测（表驱动）：URL 拼接（base path + strip/append）、双重断言（//host
// origin 逃逸与 /../../admin 回溯越界 -> RewriteError）、$env 头链矩阵（设置/空串/
// 未设置）、Host 缺省与覆盖、headerRemove/headerSet、凭据头纵深剥离、WS 升级识别、
// hooks-lifecycle 4.1 管道固定顺序（①auth 注入三族+bearer → remove → set → ②脚本
// 增量脚本胜 → 防护头再过滤；$secret 缺失 secret_missing）。

import { afterEach, describe, expect, it } from "vitest";
import type { ReqHeader } from "../../../src/wire/frames.ts";
import {
  buildUpstreamRequest,
  isWebSocketUpgradeRequest,
  RewriteError,
  SecretMissingError,
  PathNotOfferedError,
} from "../../../src/provider/rewrite.ts";
import { HookMissingError, HookStageError } from "../../../src/provider/hook.ts";
import type { ServiceConfig } from "../../../src/provider/store.ts";

function makeService(over: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    serviceId: "svctest",
    name: "test",
    match: [{ type: "suffix", value: ".local" }],
    upstream: "http://127.0.0.1:11434",
    rewrite: undefined,
    defaultPort: 11434,
    enabled: true,
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
  it("根基础路径 + 请求路径直拼", async () => {
    const plan = await buildUpstreamRequest(makeService(), makeReq(), {});
    expect(plan.url.href).toBe("http://127.0.0.1:11434/v1/chat");
    expect(plan.host).toBe("127.0.0.1:11434");
  });

  it("上游基础路径保留：/api + /v1/chat -> /api/v1/chat", async () => {
    const service = makeService({ upstream: "http://upstream.test:8080/api" });
    const plan = await buildUpstreamRequest(service, makeReq(), {});
    expect(plan.url.pathname).toBe("/api/v1/chat");
    expect(plan.host).toBe("upstream.test:8080");
  });

  it("前缀剥离：strip=/ollama + /ollama/v1 -> /v1（不误伤 /ollamax）", async () => {
    const service = makeService({ rewrite: { pathPrefixStrip: "/ollama" } });
    expect((await buildUpstreamRequest(service, makeReq({ path: "/ollama/v1" }), {})).url.pathname).toBe("/v1");
    expect((await buildUpstreamRequest(service, makeReq({ path: "/ollamax" }), {})).url.pathname).toBe("/ollamax");
  });

  it("剥离 + 追加 + 基础路径组合", async () => {
    const service = makeService({
      upstream: "http://upstream.test:8080/svc",
      rewrite: { pathPrefixStrip: "/ollama", pathPrefixAppend: "/api" },
    });
    const plan = await buildUpstreamRequest(service, makeReq({ path: "/ollama/v1" }), {});
    expect(plan.url.pathname).toBe("/svc/api/v1");
  });

  it("查询串保留", async () => {
    const plan = await buildUpstreamRequest(makeService(), makeReq({ path: "/v1/x?stream=true&q=1" }), {});
    expect(plan.url.search).toBe("?stream=true&q=1");
  });

  it("默认端口 Host 不带端口（https 443）", async () => {
    const service = makeService({ upstream: "https://api.example.com", defaultPort: 8443 });
    expect((await buildUpstreamRequest(service, makeReq(), {})).host).toBe("api.example.com");
  });

  it("rewrite.host 覆盖 Host（v2 瘦身后字段名）", async () => {
    const service = makeService({ rewrite: { host: "internal.alias" } });
    expect((await buildUpstreamRequest(service, makeReq(), {})).host).toBe("internal.alias");
  });
});

describe("双重断言（纵深防御：零上游请求语义）", () => {
  it("//host 形态 -> origin 断言拒绝", async () => {
    await expect(buildUpstreamRequest(makeService(), makeReq({ path: "//evil.com/v1/keys" }), {})).rejects.toThrow(RewriteError);
  });

  it("/../../admin 回溯 -> 拒绝", async () => {
    await expect(buildUpstreamRequest(makeService(), makeReq({ path: "/../../admin" }), {})).rejects.toThrow(RewriteError);
  });

  it("相对段 .. 深层注入（schema 失效兜底）-> 拒绝", async () => {
    await expect(buildUpstreamRequest(makeService(), makeReq({ path: "/a/../../../etc" }), {})).rejects.toThrow(RewriteError);
  });

  it("反斜杠形态 -> 拒绝", async () => {
    await expect(buildUpstreamRequest(makeService(), makeReq({ path: "/\\evil" }), {})).rejects.toThrow(RewriteError);
  });

  it("基础路径前缀不可逃逸：strip 吞掉基础路径形态仍以基础路径为前缀", async () => {
    const service = makeService({ upstream: "http://up.test/base", rewrite: { pathPrefixStrip: "/base" } });
    // /base/base/x -> strip 掉首个 /base -> 拼回 /base/x
    const plan = await buildUpstreamRequest(service, makeReq({ path: "/base/base/x" }), {});
    expect(plan.url.pathname).toBe("/base/base/x");
  });
});

describe("WS 升级识别", () => {
  it("connection 含 upgrade token + upgrade: websocket（大小写不敏感）", async () => {
    expect(isWebSocketUpgradeRequest({ connection: "keep-alive, Upgrade", upgrade: "websocket" })).toBe(true);
    expect(isWebSocketUpgradeRequest({ connection: "Upgrade", upgrade: "WebSocket" })).toBe(true);
  });

  it("非升级请求（缺头 / connection 无 token / 其他协议）", async () => {
    expect(isWebSocketUpgradeRequest({})).toBe(false);
    expect(isWebSocketUpgradeRequest({ connection: "keep-alive", upgrade: "websocket" })).toBe(false);
    expect(isWebSocketUpgradeRequest({ connection: "upgrade", upgrade: "h2c" })).toBe(false);
  });

  it("plan.isWebSocketUpgrade 分流标记", async () => {
    const plan = await buildUpstreamRequest(
      makeService(),
      makeReq({ headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13" } }),
      {},
    );
    expect(plan.isWebSocketUpgrade).toBe(true);
    expect((await buildUpstreamRequest(makeService(), makeReq(), {})).isWebSocketUpgrade).toBe(false);
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

  it("DeepSeek anthropic 形态：/anthropic/v1/messages -> /anthropic/v1/messages（1:1）", async () => {
    const plan = await buildUpstreamRequest(deepseek, makeReq({ path: "/anthropic/v1/messages" }), {});
    expect(plan.url.href).toBe("https://api.deepseek.com/anthropic/v1/messages");
  });

  it("DeepSeek openai 形态：/v1/chat/completions -> /v1/chat/completions（1:1 官方镜像）", async () => {
    const plan = await buildUpstreamRequest(deepseek, makeReq({ path: "/v1/chat/completions" }), {});
    expect(plan.url.href).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("段边界：/v1beta 不命中 /v1 路由（不误伤）；/anthropicapi 同理", async () => {
    await expect(buildUpstreamRequest(deepseek, makeReq({ path: "/v1beta/x" }), {})).rejects.toThrow(
      PathNotOfferedError,
    );
    await expect(buildUpstreamRequest(deepseek, makeReq({ path: "/anthropicapi/v1" }), {})).rejects.toThrow(
      PathNotOfferedError,
    );
  });

  it("未命中路径拒绝（白名单语义：路由表外零上游请求）", async () => {
    await expect(buildUpstreamRequest(deepseek, makeReq({ path: "/user/balance" }), {})).rejects.toThrow(
      PathNotOfferedError,
    );
    await expect(buildUpstreamRequest(deepseek, makeReq({ path: "/openai/v1/chat/completions" }), {})).rejects.toThrow(
      PathNotOfferedError,
    );
  });

  it("自定义 from→to：/foo/x -> /bar/x（解绑态自由映射）", async () => {
    const service = makeService({
      upstream: "https://agg.test",
      routes: [{ forms: [], localPrefix: "/foo", upstreamPrefix: "/bar" }],
    });
    expect((await buildUpstreamRequest(service, makeReq({ path: "/foo/models" }), {})).url.pathname).toBe("/bar/models");
    await expect(buildUpstreamRequest(service, makeReq({ path: "/other" }), {})).rejects.toThrow(PathNotOfferedError);
  });

  it("localPrefix 缺省派生规范前缀（forms 首项）", async () => {
    const service = makeService({
      upstream: "https://api.deepseek.com",
      routes: [
        { forms: ["openai-chat"], upstreamPrefix: "" },
        { forms: ["anthropic"], upstreamPrefix: "/anthropic" },
      ],
    });
    // openai-chat 的 to 为根 ""：/v1/models -> /models（from 前缀被替换掉）
    expect((await buildUpstreamRequest(service, makeReq({ path: "/v1/models" }), {})).url.pathname).toBe("/models");
    expect((await buildUpstreamRequest(service, makeReq({ path: "/anthropic/v1/messages" }), {})).url.pathname).toBe(
      "/anthropic/v1/messages",
    );
  });

  it("to 为根：/v1/x -> /x", async () => {
    const service = makeService({
      upstream: "https://agg.test",
      routes: [{ forms: [], localPrefix: "/v1", upstreamPrefix: "" }],
    });
    expect((await buildUpstreamRequest(service, makeReq({ path: "/v1/models" }), {})).url.pathname).toBe("/models");
  });

  it("路由前缀根命中：/anthropic -> upstream /anthropic", async () => {
    const plan = await buildUpstreamRequest(deepseek, makeReq({ path: "/anthropic" }), {});
    expect(plan.url.pathname).toBe("/anthropic");
  });

  it("upstream 带基础路径时拼接在映射后：base /api + to /v1 + /v1/x -> /api/v1/x", async () => {
    const service = makeService({
      upstream: "https://agg.test/api",
      routes: [{ forms: [], localPrefix: "/v1", upstreamPrefix: "/v1" }],
    });
    const plan = await buildUpstreamRequest(service, makeReq({ path: "/v1/messages" }), {});
    expect(plan.url.href).toBe("https://agg.test/api/v1/messages");
  });

  it("query 保留在映射后", async () => {
    const plan = await buildUpstreamRequest(deepseek, makeReq({ path: "/v1/models?list=1" }), {});
    expect(plan.url.pathname).toBe("/v1/models");
    expect(plan.url.search).toBe("?list=1");
  });

  it("无路由服务行为与从前完全一致（回归）", async () => {
    const plan = await buildUpstreamRequest(makeService(), makeReq({ path: "/v1/chat" }), {});
    expect(plan.url.href).toBe("http://127.0.0.1:11434/v1/chat");
  });
});

describe("路由顺序命中与 pattern 模式（M3-r7）", () => {
  it("顺序命中：先声明的规则赢——短前缀在前也优先于长前缀", async () => {
    const service = makeService({
      upstream: "https://agg.test",
      routes: [
        { forms: [], localPrefix: "/a", upstreamPrefix: "/first" },
        { forms: [], localPrefix: "/a/b", upstreamPrefix: "/second" },
      ],
    });
    expect((await buildUpstreamRequest(service, makeReq({ path: "/a/b/x" }), {})).url.pathname).toBe("/first/b/x");
    // 交换顺序后长前缀赢
    const swapped = makeService({
      upstream: "https://agg.test",
      routes: [
        { forms: [], localPrefix: "/a/b", upstreamPrefix: "/second" },
        { forms: [], localPrefix: "/a", upstreamPrefix: "/first" },
      ],
    });
    expect((await buildUpstreamRequest(swapped, makeReq({ path: "/a/b/x" }), {})).url.pathname).toBe("/second/x");
  });

  it("pattern 模式：URLPattern 组 + RFC 6570 模板拼装", async () => {
    const service = makeService({
      upstream: "https://agg.test",
      routes: [{ forms: [], mode: "pattern", matchPattern: "/v1/:ver/chat/completions", template: "/relay/{ver}/chat/completions" }],
    });
    const plan = await buildUpstreamRequest(service, makeReq({ path: "/v1/v1/chat/completions" }), {});
    expect(plan.url.pathname).toBe("/relay/v1/chat/completions");
  });

  it("pattern：花括号组语法翻译兼容（{ver} ≡ :ver）", async () => {
    const service = makeService({
      upstream: "https://agg.test",
      routes: [{ forms: [], mode: "pattern", matchPattern: "/v1/{ver}/*", template: "/proxy/{+0}" }],
    });
    const plan = await buildUpstreamRequest(service, makeReq({ path: "/v1/v1/models/gpt-x" }), {});
    expect(plan.url.pathname).toBe("/proxy/models/gpt-x");
  });

  it("pattern：查询参数进模板变量域，模板产物替换查询串", async () => {
    const service = makeService({
      upstream: "https://agg.test",
      routes: [{ forms: [], mode: "pattern", matchPattern: "/search", template: "/s{?q}" }],
    });
    const plan = await buildUpstreamRequest(service, makeReq({ path: "/search?q=hello+world&extra=1" }), {});
    expect(plan.url.pathname).toBe("/s");
    expect(plan.url.search).toBe("?q=hello%20world");
  });

  it("pattern 未命中 → 继续后续规则；全部未命中 → 404 白名单", async () => {
    const service = makeService({
      upstream: "https://agg.test",
      routes: [
        { forms: [], mode: "pattern", matchPattern: "/special/:id", template: "/s/{id}" },
        { forms: [], localPrefix: "/v1", upstreamPrefix: "/v1" },
      ],
    });
    expect((await buildUpstreamRequest(service, makeReq({ path: "/special/9" }), {})).url.pathname).toBe("/s/9");
    expect((await buildUpstreamRequest(service, makeReq({ path: "/v1/models" }), {})).url.pathname).toBe("/v1/models");
    await expect(buildUpstreamRequest(service, makeReq({ path: "/other" }), {})).rejects.toThrow(PathNotOfferedError);
  });

  it("pattern 模板产物拼在 upstream 基础路径后", async () => {
    const service = makeService({
      upstream: "https://agg.test/base",
      routes: [{ forms: [], mode: "pattern", matchPattern: "/x/*", template: "/y/{+0}" }],
    });
    expect((await buildUpstreamRequest(service, makeReq({ path: "/x/a/b" }), {})).url.pathname).toBe("/base/y/a/b");
  });
});

// ---------------------------------------------------------------------------
// headers 槽（hooks-lifecycle v2 最小平移：remove → set 字面量间接引用）
// ---------------------------------------------------------------------------

describe("headers 槽（remove → set 字面量）", () => {
  it("headers.remove 删除帧内头；headers.set 字面量原样覆盖", async () => {
    const service = makeService({
      headers: { remove: ["x-drop"], set: { "x-literal": "abc", "x-override": "declared" } },
    });
    const plan = await buildUpstreamRequest(
      service,
      makeReq({ headers: { "x-drop": "1", "x-override": "frame", "x-keep": "k" } }),
      {},
    );
    expect(plan.headers["x-drop"]).toBeUndefined();
    expect(plan.headers["x-literal"]).toBe("abc");
    expect(plan.headers["x-override"]).toBe("declared");
    expect(plan.headers["x-keep"]).toBe("k");
  });

  it("$env: 命中取值；空串/未设置 → 该头省略（v2 语义）", async () => {
    const service = makeService({
      headers: { set: { authorization: "$env:UPSTREAM_KEY", "x-lit": "v" } },
    });
    const hit = await buildUpstreamRequest(service, makeReq(), { UPSTREAM_KEY: "sk-1" });
    expect(hit.headers["authorization"]).toBe("sk-1");
    const empty = await buildUpstreamRequest(service, makeReq(), { UPSTREAM_KEY: "" });
    expect(empty.headers["authorization"]).toBeUndefined();
    expect(empty.headers["x-lit"]).toBe("v");
    const unset = await buildUpstreamRequest(service, makeReq(), {});
    expect(unset.headers["authorization"]).toBeUndefined();
  });

  it("$secret: 命中注入完整头值；未命中 -> SecretMissingError（消息不含名字）", async () => {
    const service = makeService({
      headers: { set: { authorization: "$secret:openai" } },
    });
    const hit = await buildUpstreamRequest(service, makeReq(), {}, (name) =>
      name === "openai" ? "Bearer sk-lib" : undefined,
    );
    expect(hit.headers["authorization"]).toBe("Bearer sk-lib");
    try {
      await buildUpstreamRequest(service, makeReq(), {}, () => undefined);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SecretMissingError);
      expect((err as Error).message).not.toContain("openai");
    }
  });
});

// ---------------------------------------------------------------------------
// hooks-lifecycle 4.1：生命周期头链固定顺序（①auth → remove → set → ②脚本 → 防护再过滤）
// ---------------------------------------------------------------------------

const loaderOf = (mods: Record<string, Record<string, unknown>>) =>
  (name: string): Record<string, unknown> | undefined => mods[name];

describe("① auth 槽注入（三族 + bearer 单源）", () => {
  it("{secret}：密钥库原样值；bearer 默认拼（已带 Bearer 不重复）；bearer:false 原样；缺失 -> SecretMissingError", async () => {
    const secrets = (name: string): string | undefined => (name === "lib" ? "sk-raw" : undefined);
    const bare = await buildUpstreamRequest(
      makeService({ auth: { secret: "lib" } }),
      makeReq(),
      {},
      secrets,
    );
    expect(bare.headers["authorization"]).toBe("Bearer sk-raw");
    const prefilled = await buildUpstreamRequest(
      makeService({ auth: { secret: "lib", bearer: true } }),
      makeReq(),
      {},
      (name) => (name === "lib" ? "Bearer sk-raw" : undefined),
    );
    expect(prefilled.headers["authorization"]).toBe("Bearer sk-raw");
    const off = await buildUpstreamRequest(
      makeService({ auth: { secret: "lib", bearer: false } }),
      makeReq(),
      {},
      secrets,
    );
    expect(off.headers["authorization"]).toBe("sk-raw");
    await expect(
      buildUpstreamRequest(makeService({ auth: { secret: "ghost" } }), makeReq(), {}, secrets),
    ).rejects.toBeInstanceOf(SecretMissingError);
  });

  it("{script}：resolveStageAuth 裸值 + bearer 拼；ctx 携 method/path/headers；失效 -> HookMissingError", async () => {
    let seen: Record<string, unknown> = {};
    const mods = {
      a: {
        onRequestBearerAuthentication: (ctx: Record<string, unknown>) => {
          seen = ctx;
          return "tok-1";
        },
      },
      broken: { onRequestBearerAuthentication: () => { throw new Error("x"); } },
    };
    const loader = loaderOf(mods);
    const plan = await buildUpstreamRequest(
      makeService({ auth: { script: "a" } }),
      makeReq({ headers: { "x-keep": "k" } }),
      {},
      undefined,
      { loader },
    );
    expect(plan.headers["authorization"]).toBe("Bearer tok-1");
    expect(seen.method).toBe("POST");
    expect(seen.path).toBe("/v1/chat");
    expect(seen.headers).toEqual({ "x-keep": "k" }); // 入站剥离后的当前头态
    await expect(
      buildUpstreamRequest(makeService({ auth: { script: "broken" } }), makeReq(), {}, undefined, { loader }),
    ).rejects.toBeInstanceOf(HookMissingError);
  });

  it("{literal}：原样 / $env:（空=省略）/ $secret:（缺失 -> SecretMissingError）；bearer 同规则", async () => {
    const lit = await buildUpstreamRequest(
      makeService({ auth: { literal: "tok-lit", bearer: false } }),
      makeReq(),
      {},
    );
    expect(lit.headers["authorization"]).toBe("tok-lit");
    const env = await buildUpstreamRequest(
      makeService({ auth: { literal: "$env:AUTH_KEY" } }),
      makeReq(),
      { AUTH_KEY: "env-tok" },
    );
    expect(env.headers["authorization"]).toBe("Bearer env-tok");
    const envEmpty = await buildUpstreamRequest(
      makeService({ auth: { literal: "$env:AUTH_KEY" } }),
      makeReq(),
      { AUTH_KEY: "" },
    );
    expect(envEmpty.headers["authorization"]).toBeUndefined(); // $env 空 = 省略该头
    await expect(
      buildUpstreamRequest(makeService({ auth: { literal: "$secret:nope" } }), makeReq(), {}, () => undefined),
    ).rejects.toBeInstanceOf(SecretMissingError);
  });
});

describe("头链固定顺序与 ② 脚本增量", () => {
  it("顺序：①auth 注入可被声明 remove 移除、被声明 set 覆盖；②脚本 remove 后 set（脚本胜）", async () => {
    const mods = { s: { onRequestHeaders: () => ({ set: { "X-A": "script" }, remove: ["x-declared"] }) } };
    const service = makeService({
      auth: { literal: "auth-tok", bearer: false },
      headers: {
        remove: ["authorization"], // 声明 remove 移除 ① 注入的 authorization
        set: { "x-a": "declared", "x-declared": "will-be-script-removed" },
        script: { name: "s" },
      },
    });
    const plan = await buildUpstreamRequest(service, makeReq({ headers: { "x-frame": "f" } }), {}, undefined, {
      loader: loaderOf(mods),
    });
    expect(plan.headers["authorization"]).toBeUndefined(); // ① 被 remove 移除
    expect(plan.headers["x-a"]).toBe("script"); // 脚本胜过声明 set
    expect(plan.headers["x-declared"]).toBeUndefined(); // 脚本 remove 对声明 set 生效
    expect(plan.headers["x-frame"]).toBe("f"); // 帧内头存活
  });

  it("② 脚本 ctx 携带管线当前头态（含 ① 注入与声明 set 的结果）", async () => {
    let seen: Record<string, unknown> = {};
    const mods = {
      s: {
        onRequestHeaders: (ctx: Record<string, unknown>) => {
          seen = ctx;
          return {};
        },
      },
    };
    await buildUpstreamRequest(
      makeService({
        auth: { literal: "tok" },
        headers: { set: { "x-decl": "d" }, script: { name: "s" } },
      }),
      makeReq({ headers: { "x-keep": "k" } }),
      {},
      undefined,
      { loader: loaderOf(mods) },
    );
    expect(seen.method).toBe("POST");
    expect(seen.headers).toEqual({
      "x-keep": "k",
      authorization: "Bearer tok",
      "x-decl": "d",
    });
  });

  it("防护头再过滤：脚本/声明引入的 host/hop-by-hop/content-length 一律剥离；authorization 存活", async () => {
    const mods = {
      s: {
        onRequestHeaders: () => ({
          set: { host: "evil.example", connection: "keep-alive", "content-length": "999", "x-ok": "1" },
        }),
      },
    };
    const service = makeService({
      auth: { literal: "tok" },
      headers: { set: { "transfer-encoding": "chunked" }, script: { name: "s" } },
    });
    const plan = await buildUpstreamRequest(service, makeReq(), {}, undefined, { loader: loaderOf(mods) });
    expect(plan.headers["host"]).toBeUndefined();
    expect(plan.headers["connection"]).toBeUndefined();
    expect(plan.headers["content-length"]).toBeUndefined();
    expect(plan.headers["transfer-encoding"]).toBeUndefined();
    expect(plan.headers["x-ok"]).toBe("1");
    expect(plan.headers["authorization"]).toBe("Bearer tok"); // ① 产物不受防护再过滤影响
  });

  it("② 脚本失效（缺席/抛错/形状非法）-> HookStageError（上游映射 hook_failed）", async () => {
    const mods = {
      absent: { other: () => "x" },
      throws: { onRequestHeaders: () => { throw new Error("boom"); } },
      badShape: { onRequestHeaders: () => "not-an-object" },
    };
    const loader = loaderOf(mods);
    for (const name of ["absent", "throws", "badShape"]) {
      await expect(
        buildUpstreamRequest(
          makeService({ headers: { script: { name } } }),
          makeReq(),
          {},
          undefined,
          { loader },
        ),
      ).rejects.toBeInstanceOf(HookStageError);
    }
  });
});
