// rewrite 单测（表驱动）：URL 拼接（base path + strip/append）、双重断言（//host
// origin 逃逸与 /../../admin 回溯越界 -> RewriteError）、$env 头链矩阵（设置/空串/
// 未设置）、Host 缺省与覆盖、headerRemove/headerSet、凭据头纵深剥离、WS 升级识别。

import { afterEach, describe, expect, it } from "vitest";
import type { ReqHeader } from "../../../src/wire/frames.ts";
import {
  buildUpstreamRequest,
  isWebSocketUpgradeRequest,
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

  it("hostHeader 覆盖 Host", async () => {
    const service = makeService({ rewrite: { hostHeader: "internal.alias" } });
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
// $file: 文件型凭据（cli-codex：~/.codex/auth.json#.tokens.access_token?bearer）
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// $script: 脚本型凭据（Owner 裁决 2026-09-12：Node 脚本统一跨平台，无 VM）
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 头值两协议（Owner 2026-09-12 终态）：literal | { hook, args?, bearer? }
// 内建脚本 env/secret/file 经 args 形态推导；自定义脚本注入 loader。
// ---------------------------------------------------------------------------
describe("头值两协议（literal | hook）", () => {
  afterEach(async () => {
    const { disposeHookSubscriptions } = await import("../../../src/provider/hook.ts");
    await disposeHookSubscriptions();
  });

  const loaderOf = (mods: Record<string, Record<string, unknown>>) =>
    (name: string): Record<string, unknown> | undefined => mods[name];

  it("literal 原样；空串省略", async () => {
    const { resolveHeaderEntry } = await import("../../../src/provider/rewrite.ts");
    expect(await resolveHeaderEntry("v", {})).toBe("v");
    expect(await resolveHeaderEntry("", {})).toBeUndefined();
  });

  it("内建 env：命中取值；未设置 fail-fast（SecretMissingError，语义收紧）", async () => {
    const { resolveHeaderEntry } = await import("../../../src/provider/rewrite.ts");
    const entry = { hook: "authHeader", args: { var: "K" } } as const;
    expect(await resolveHeaderEntry(entry, { env: { K: "v1" } })).toBe("v1");
    await expect(resolveHeaderEntry(entry, { env: {} })).rejects.toThrow();
  });

  it("内建 secret：经注入 secrets 取值；bearer 拼前缀", async () => {
    const { resolveHeaderEntry } = await import("../../../src/provider/rewrite.ts");
    expect(
      await resolveHeaderEntry({ hook: "authHeader", args: { name: "k1" }, bearer: true }, { secrets: (n) => (n === "k1" ? "sk-1" : undefined) }),
    ).toBe("Bearer sk-1");
    await expect(resolveHeaderEntry({ hook: "authHeader", args: { name: "ghost" } }, { secrets: () => undefined })).rejects.toThrow();
  });

  it("内建 file：路径 + 点径（tmp home 隔离）", async () => {
    const { resolveHeaderEntry } = await import("../../../src/provider/rewrite.ts");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "aifly-hv-"));
    try {
      writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "t1" } }));
      const entry = { hook: "authHeader", args: { path: "~/auth.json", jsonPath: ".tokens.access_token" } } as const;
      expect(await resolveHeaderEntry(entry, { home })).toBe("t1");
      await expect(
        resolveHeaderEntry({ hook: "authHeader", args: { path: "~/auth.json", jsonPath: ".tokens.missing" } }, { home }),
      ).rejects.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("自定义脚本（loader 注入）：同步串 / Promise / AsyncIterable 订阅动态更新", async () => {
    const { resolveHeaderEntry } = await import("../../../src/provider/rewrite.ts");
    const mods: Record<string, Record<string, unknown>> = {
      s: { authHeader: () => "sync-v" },
      p: { authHeader: async () => "promise-v" },
    };
    expect(await resolveHeaderEntry({ hook: "authHeader" }, { script: "s", loader: loaderOf(mods) })).toBe("sync-v");
    expect(await resolveHeaderEntry({ hook: "authHeader" }, { script: "p", loader: loaderOf(mods) })).toBe("promise-v");
    // AsyncIterable 订阅：首请求等待首个 yield；后续 push 动态更新 latest（零重启）
    const queue: string[] = ["tok-1"];
    let resolver: (() => void) | undefined;
    const push = (v: string): void => {
      queue.push(v);
      resolver?.();
      resolver = undefined;
    };
    const stream: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (queue.length === 0) {
            await new Promise<void>((r) => {
              resolver = r;
            });
          }
          return { value: queue.shift()!, done: false };
        },
        return: async () => ({ value: undefined, done: true }),
      }),
    };
    const w = { authHeader: () => stream } as unknown as Record<string, unknown>;
    expect(await resolveHeaderEntry({ hook: "authHeader" }, { script: "w", loader: loaderOf({ w }) })).toBe("tok-1");
    push("tok-2");
    await new Promise((r) => setTimeout(r, 20));
    expect(await resolveHeaderEntry({ hook: "authHeader" }, { script: "w", loader: loaderOf({ w }) })).toBe("tok-2");
    push("tok-3");
    await new Promise((r) => setTimeout(r, 20));
    expect(await resolveHeaderEntry({ hook: "authHeader", bearer: true }, { script: "w", loader: loaderOf({ w }) })).toBe("Bearer tok-3");
  });

  it("脚本/函数缺席、调用抛错 -> SecretMissingError（不泄脚本名与值）", async () => {
    const { resolveHeaderEntry } = await import("../../../src/provider/rewrite.ts");
    const bad = loaderOf({ e: { other: () => "x" }, t: { authHeader: () => { throw new Error("boom"); } } });
    await expect(resolveHeaderEntry({ hook: "authHeader" }, { script: "e", loader: bad })).rejects.toThrow();
    try {
      await resolveHeaderEntry({ hook: "authHeader" }, { script: "t", loader: bad });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain("boom");
    }
  });
});
