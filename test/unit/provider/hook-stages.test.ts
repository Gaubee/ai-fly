// hook 阶段化契约单测（hooks-lifecycle 3.1/3.2）：discoverHooks 阶段矩阵、
// ① 三态契约（string | Promise | AsyncIterable 订阅缓存）、② 对象返回契约
// （{set?, remove?} + wire 帧上限 ≤32 头/键 ≤1KiB/值 ≤8KiB）、③④ 调用壳的
// ctx 形状（③ {url, method, headers, body, signal}；④ {status, headers,
// body, signal}）与返回形状校验、错误分族（① secret_missing 族 vs ②③④
// hook_failed 族，消息脱敏固定文案）。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverHooks,
  disposeHookSubscriptions,
  HookMissingError,
  HookStageError,
  resolveStageAuth,
  resolveStageHeaders,
  resolveStageRequest,
  resolveStageResponse,
  stageFnsOf,
  STAGE_HEADER_LIMITS,
} from "../../../src/provider/hook.ts";
import type { RequestStageCtx, ResponseStageCtx } from "../../../src/provider/hook.ts";

const loaderOf = (mods: Record<string, Record<string, unknown>>) =>
  (name: string): Record<string, unknown> | undefined => mods[name];

const REQUEST = { method: "POST", path: "/v1/chat", headers: { "content-type": "application/json" } };

afterEach(async () => {
  await disposeHookSubscriptions();
});

// ---------------------------------------------------------------------------
// 阶段矩阵归类
// ---------------------------------------------------------------------------

describe("阶段矩阵（discoverHooks / stageFnsOf）", () => {
  it("按 STAGE_FN_NAMES 归类：阶段导出进 stages（管线顺序），旧名/辅助函数只进 fns", () => {
    const mod = {
      onRequestHeaders: () => ({}),
      onResponse: () => ({}),
      onRequestBearerAuthentication: () => "tok",
      authHeader: () => "legacy", // v1 导出名：不进 stages
      _helper: () => "x",
      notAHook: 42,
    };
    const stages = stageFnsOf(mod);
    expect(stages).toEqual([
      "onRequestBearerAuthentication",
      "onRequestHeaders",
      "onResponse",
    ]);
  });

  it("discoverHooks 输出各脚本 stages 矩阵 + fns 清单（用户库优先）", () => {
    const home = mkdtempSync(join(tmpdir(), "aifly-hook-disc-"));
    try {
      const userDir = join(home, ".aifly", "hooks");
      mkdirSync(userDir, { recursive: true });
      writeFileSync(
        join(userDir, "zlegacy.cjs"),
        "module.exports = { authHeader: () => 'old' };\n",
      );
      writeFileSync(
        join(userDir, "astaged.cjs"),
        "module.exports = { onRequest: async () => ({ status: 200, headers: {} }), onResponse: () => ({}) };\n",
      );
      const scripts = discoverHooks(home);
      const legacy = scripts.find((s) => s.name === "zlegacy")!;
      expect(legacy.fns).toEqual(["authHeader"]);
      expect(legacy.stages).toEqual([]); // 旧导出名被新矩阵排除
      const staged = scripts.find((s) => s.name === "astaged")!;
      expect(staged.stages).toEqual(["onRequest", "onResponse"]);
      expect(staged.fns).toEqual(["onRequest", "onResponse"]);
      // 内建脚本照常枚举（如 secret/env）
      expect(scripts.some((s) => s.source === "builtin")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ① 三态契约（auth 阶段独有）
// ---------------------------------------------------------------------------

describe("① resolveStageAuth 三态契约", () => {
  it("string / Promise 每请求拉取", async () => {
    const mods = {
      s: { onRequestBearerAuthentication: () => "sync-tok" },
      p: { onRequestBearerAuthentication: async () => "promise-tok" },
    };
    expect(await resolveStageAuth({ script: "s" }, { loader: loaderOf(mods) })).toBe("sync-tok");
    expect(await resolveStageAuth({ script: "p" }, { loader: loaderOf(mods) })).toBe("promise-tok");
  });

  it("内建 file 脚本返回裸值：Bearer 前缀只由 auth 槽 bearer 开关单源拼装", async () => {
    const home = mkdtempSync(join(tmpdir(), "aifly-hook-file-"));
    try {
      const tokenFile = join(home, "cred.json");
      writeFileSync(tokenFile, JSON.stringify({ tokens: { access_token: "raw-tok" } }));
      const fileHook = require("../../../hooks/file.cjs").onRequestBearerAuthentication;
      const raw = fileHook({ homedir: home, args: { path: "~/cred.json", jsonPath: "tokens.access_token" } });
      expect(raw).toBe("raw-tok"); // 脚本层不再自拼前缀（args.bearer 退役）
      const { applyBearerPrefix } = await import("../../../src/provider/rewrite.ts");
      expect(applyBearerPrefix(raw, undefined)).toBe("Bearer raw-tok"); // 默认拼
      expect(applyBearerPrefix(raw, false)).toBe("raw-tok"); // bearer:false 可完全关掉前缀
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("AsyncIterable 订阅：首请求等首个 yield；后续读 latest（零重启热更）", async () => {
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
          if (queue.length === 0) await new Promise<void>((r) => (resolver = r));
          return { value: queue.shift()!, done: false };
        },
        return: async () => ({ value: undefined, done: true }),
      }),
    };
    const mods = { w: { onRequestBearerAuthentication: () => stream } };
    expect(await resolveStageAuth({ script: "w" }, { loader: loaderOf(mods) })).toBe("tok-1");
    push("tok-2");
    await new Promise((r) => setTimeout(r, 20));
    expect(await resolveStageAuth({ script: "w" }, { loader: loaderOf(mods) })).toBe("tok-2");
  });

  it("ctx 含 {homedir, args, secrets, env} + 请求级 {method, path, headers}", async () => {
    let seen: Record<string, unknown> = {};
    const mods = {
      ctxprobe: {
        onRequestBearerAuthentication: (ctx: Record<string, unknown>) => {
          seen = ctx;
          return "tok";
        },
      },
    };
    const value = await resolveStageAuth(
      { script: "ctxprobe", args: { k: "v" } },
      {
        loader: loaderOf(mods),
        secrets: (n) => (n === "s1" ? "sv" : undefined),
        env: (n) => (n === "e1" ? "ev" : undefined),
        request: REQUEST,
      },
    );
    expect(value).toBe("tok");
    expect(seen.homedir).toBeTypeOf("string");
    expect(seen.args).toEqual({ k: "v" });
    expect((seen.secrets as (n: string) => string | undefined)("s1")).toBe("sv");
    expect((seen.env as (n: string) => string | undefined)("e1")).toBe("ev");
    expect(seen.method).toBe("POST");
    expect(seen.path).toBe("/v1/chat");
    expect(seen.headers).toEqual({ "content-type": "application/json" });
  });

  it("失败归 secret_missing 族：缺席/抛错/空串/订阅无首值 → HookMissingError", async () => {
    const mods = {
      absent: { other: () => "x" },
      throws: { onRequestBearerAuthentication: () => { throw new Error("boom"); } },
      empty: { onRequestBearerAuthentication: () => "" },
      ended: { onRequestBearerAuthentication: () => ({ [Symbol.asyncIterator]: async function* () {} }) },
    };
    const loader = loaderOf(mods);
    await expect(resolveStageAuth({ script: "absent" }, { loader })).rejects.toBeInstanceOf(HookMissingError);
    await expect(resolveStageAuth({ script: "no-such-script" }, { loader })).rejects.toBeInstanceOf(HookMissingError);
    try {
      await resolveStageAuth({ script: "throws" }, { loader });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HookMissingError);
      expect((err as Error).message).not.toContain("boom");
    }
    await expect(resolveStageAuth({ script: "empty" }, { loader })).rejects.toBeInstanceOf(HookMissingError);
    await expect(resolveStageAuth({ script: "ended" }, { loader })).rejects.toBeInstanceOf(HookMissingError);
  });
});

// ---------------------------------------------------------------------------
// ② 对象返回契约（{set?, remove?} + 上限）
// ---------------------------------------------------------------------------

describe("② resolveStageHeaders 对象契约", () => {
  it("合法：{set, remove} / {} no-op / Promise 形式；ctx 含请求级三件", async () => {
    let seen: Record<string, unknown> = {};
    const mods = {
      h: {
        onRequestHeaders: (ctx: Record<string, unknown>) => {
          seen = ctx;
          return { set: { "x-a": "1" }, remove: ["x-b"] };
        },
      },
      noop: { onRequestHeaders: () => ({}) },
      asyncH: { onRequestHeaders: async () => Promise.resolve({ set: { "x-c": "2" } }) },
    };
    const loader = loaderOf(mods);
    const result = await resolveStageHeaders({ name: "h" }, REQUEST, { loader });
    expect(result).toEqual({ set: { "x-a": "1" }, remove: ["x-b"] });
    expect(seen.method).toBe("POST");
    expect(seen.path).toBe("/v1/chat");
    expect(seen.headers).toEqual({ "content-type": "application/json" });
    expect(await resolveStageHeaders({ name: "noop" }, REQUEST, { loader })).toEqual({});
    expect(await resolveStageHeaders({ name: "asyncH" }, REQUEST, { loader })).toEqual({ set: { "x-c": "2" } });
  });

  it("顶层键 strict：未知键（如 sets 拼错）一律 HookStageError——拒绝静默 no-op", async () => {
    const loader = loaderOf({
      typo: { onRequestHeaders: () => ({ set: { "x-a": "1" }, typo: 1 }) },
      sets: { onRequestHeaders: () => ({ sets: { "x-a": "1" } }) },
    });
    await expect(resolveStageHeaders({ name: "typo" }, REQUEST, { loader })).rejects.toBeInstanceOf(HookStageError);
    await expect(resolveStageHeaders({ name: "sets" }, REQUEST, { loader })).rejects.toBeInstanceOf(HookStageError);
  });

  it("① Promise 拒绝归一 HookMissingError（不外泄脚本原始异常）", async () => {
    const loader = loaderOf({
      rej: { onRequestBearerAuthentication: async () => Promise.reject(new Error("leak sk-rej")) },
    });
    await expect(resolveStageAuth({ script: "rej" }, { loader })).rejects.toBeInstanceOf(HookMissingError);
  });

  it("上限：头数量 ≤32 / 键 ≤1KiB / 值 ≤8KiB——超限一律 HookStageError", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= STAGE_HEADER_LIMITS.maxCount; i += 1) many[`x-h${i}`] = "v";
    const longName = `x-${"a".repeat(STAGE_HEADER_LIMITS.nameMaxBytes)}`;
    const longValue = "v".repeat(STAGE_HEADER_LIMITS.valueMaxBytes + 1);
    const mods = {
      count: { onRequestHeaders: () => ({ set: many }) },
      name: { onRequestHeaders: () => ({ set: { [longName]: "v" } }) },
      value: { onRequestHeaders: () => ({ set: { "x-a": longValue } }) },
      removeCount: { onRequestHeaders: () => ({ remove: new Array(STAGE_HEADER_LIMITS.maxCount + 1).fill("x") }) },
      removeName: { onRequestHeaders: () => ({ remove: [longName] }) },
    };
    const loader = loaderOf(mods);
    for (const name of ["count", "name", "value", "removeCount", "removeName"]) {
      await expect(resolveStageHeaders({ name }, REQUEST, { loader })).rejects.toBeInstanceOf(HookStageError);
    }
    // 恰好在限内（=32 头 / =1KiB 键 / =8KiB 值）合法
    const atLimit: Record<string, string> = {};
    for (let i = 0; i < STAGE_HEADER_LIMITS.maxCount - 1; i += 1) atLimit[`x-h${i}`] = "v";
    const okMods = {
      ok: {
        onRequestHeaders: () => ({
          set: {
            ...atLimit,
            [`x-${"a".repeat(STAGE_HEADER_LIMITS.nameMaxBytes - 2)}`]: "v".repeat(STAGE_HEADER_LIMITS.valueMaxBytes),
          },
        }),
      },
    };
    const ok = await resolveStageHeaders({ name: "ok" }, REQUEST, { loader: loaderOf(okMods) });
    expect(Object.keys(ok.set!)).toHaveLength(STAGE_HEADER_LIMITS.maxCount);
  });

  it("形状非法 → HookStageError：非对象返回 / set 值非 string / remove 非数组或含非 string", async () => {
    const mods = {
      str: { onRequestHeaders: () => "not-an-object" },
      arr: { onRequestHeaders: () => ["x"] },
      nullv: { onRequestHeaders: () => null },
      setNum: { onRequestHeaders: () => ({ set: { a: 123 } }) },
      removeStr: { onRequestHeaders: () => ({ remove: "x-a" }) },
      removeNum: { onRequestHeaders: () => ({ remove: [1] }) },
      setArr: { onRequestHeaders: () => ({ set: ["a"] }) },
    };
    const loader = loaderOf(mods);
    for (const name of ["str", "arr", "nullv", "setNum", "removeStr", "removeNum", "setArr"]) {
      await expect(resolveStageHeaders({ name }, REQUEST, { loader })).rejects.toBeInstanceOf(HookStageError);
    }
  });

  it("绑定缺席（导出缺失）/ 抛错 → HookStageError；消息固定脱敏（不含脚本名）", async () => {
    const mods = {
      absent: { other: () => "x" },
      throws: { onRequestHeaders: () => { throw new Error("secret-detail"); } },
    };
    const loader = loaderOf(mods);
    await expect(resolveStageHeaders({ name: "absent" }, REQUEST, { loader })).rejects.toBeInstanceOf(HookStageError);
    await expect(resolveStageHeaders({ name: "no-such" }, REQUEST, { loader })).rejects.toBeInstanceOf(HookStageError);
    try {
      await resolveStageHeaders({ name: "throws" }, REQUEST, { loader });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HookStageError);
      expect((err as Error).message).toBe("hook stage failed");
      expect((err as Error).message).not.toContain("secret-detail");
      expect((err as Error).message).not.toContain("throws");
    }
  });
});

// ---------------------------------------------------------------------------
// ③ onRequest 调用壳（ctx + 返回形状）
// ---------------------------------------------------------------------------

function requestCtx(): RequestStageCtx {
  return {
    url: "http://127.0.0.1:11434/v1/chat",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode('{"q":"hi"}'),
    signal: new AbortController().signal,
  };
}

describe("③ resolveStageRequest 契约", () => {
  it("ctx 形状 {url, method, headers, body, signal} + 基础面（homedir/args/secrets/env）", async () => {
    let seen: Record<string, unknown> = {};
    const ctx = requestCtx();
    const mods = {
      probe: {
        onRequest: (c: Record<string, unknown>) => {
          seen = c;
          return { status: 200, headers: { "x-ok": "1" } };
        },
      },
    };
    const result = await resolveStageRequest(
      { name: "probe", args: { k: "v" } },
      ctx,
      { loader: loaderOf(mods), secrets: (n) => (n === "s" ? "sv" : undefined), env: (n) => (n === "e" ? "ev" : undefined) },
    );
    expect(result).toEqual({ status: 200, headers: { "x-ok": "1" } });
    expect(seen.url).toBe(ctx.url);
    expect(seen.method).toBe("POST");
    expect(seen.headers).toEqual({ "content-type": "application/json" });
    expect(seen.body).toBe(ctx.body);
    expect(seen.signal).toBe(ctx.signal);
    expect(seen.args).toEqual({ k: "v" });
    expect((seen.secrets as (n: string) => string | undefined)("s")).toBe("sv");
    expect((seen.env as (n: string) => string | undefined)("e")).toBe("ev");
  });

  it("body 接受 ReadableStream | AsyncIterable；缺省合法（空流归引擎归一层）", async () => {
    const mods = {
      stream: { onRequest: () => ({ status: 200, headers: {}, body: new ReadableStream() }) },
      iter: {
        onRequest: () => ({
          status: 200,
          headers: {},
          body: (async function* () { yield new Uint8Array([1]); })(),
        }),
      },
      none: { onRequest: () => ({ status: 204, headers: {} }) },
    };
    const loader = loaderOf(mods);
    const viaStream = await resolveStageRequest({ name: "stream" }, requestCtx(), { loader });
    expect(viaStream.body).toBeInstanceOf(ReadableStream);
    const viaIter = await resolveStageRequest({ name: "iter" }, requestCtx(), { loader });
    expect(viaIter.body).toBeDefined();
    expect(typeof (viaIter.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]).toBe("function");
    const none = await resolveStageRequest({ name: "none" }, requestCtx(), { loader });
    expect(none.body).toBeUndefined();
  });

  it("status 域 200-599：199/600/非整数/缺省 → HookStageError；200/599 合法", async () => {
    const mods = {
      low: { onRequest: () => ({ status: 199, headers: {} }) },
      high: { onRequest: () => ({ status: 600, headers: {} }) },
      frac: { onRequest: () => ({ status: 200.5, headers: {} }) },
      str: { onRequest: () => ({ status: "200", headers: {} }) },
      ok200: { onRequest: () => ({ status: 200, headers: {} }) },
      ok599: { onRequest: () => ({ status: 599, headers: {} }) },
    };
    const loader = loaderOf(mods);
    for (const name of ["low", "high", "frac", "str"]) {
      await expect(resolveStageRequest({ name }, requestCtx(), { loader })).rejects.toBeInstanceOf(HookStageError);
    }
    expect((await resolveStageRequest({ name: "ok200" }, requestCtx(), { loader })).status).toBe(200);
    expect((await resolveStageRequest({ name: "ok599" }, requestCtx(), { loader })).status).toBe(599);
  });

  it("非对象返回 / headers 非法 / body 非流 / 抛错 / 缺席 → HookStageError", async () => {
    const mods = {
      str: { onRequest: () => "nope" },
      headersStr: { onRequest: () => ({ status: 200, headers: "x" }) },
      headersNum: { onRequest: () => ({ status: 200, headers: { a: 1 } }) },
      bodyStr: { onRequest: () => ({ status: 200, headers: {}, body: "chunked-string" }) },
      throws: { onRequest: () => { throw new Error("boom"); } },
      absent: { other: () => "x" },
    };
    const loader = loaderOf(mods);
    for (const name of ["str", "headersStr", "headersNum", "bodyStr", "throws", "absent"]) {
      await expect(resolveStageRequest({ name }, requestCtx(), { loader })).rejects.toBeInstanceOf(HookStageError);
    }
  });
});

// ---------------------------------------------------------------------------
// ④ onResponse 调用壳（ctx + 局部覆盖形状）
// ---------------------------------------------------------------------------

function responseCtx(): ResponseStageCtx {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: (async function* () { yield new Uint8Array([1, 2]); })(),
    signal: new AbortController().signal,
  };
}

describe("④ resolveStageResponse 契约", () => {
  it("ctx 形状 {status, headers, body, signal} + 基础面", async () => {
    let seen: Record<string, unknown> = {};
    const ctx = responseCtx();
    const mods = {
      probe: {
        onResponse: (c: Record<string, unknown>) => {
          seen = c;
          return {};
        },
      },
    };
    await resolveStageResponse({ name: "probe", args: { k: "v" } }, ctx, { loader: loaderOf(mods) });
    expect(seen.status).toBe(200);
    expect(seen.headers).toEqual({ "content-type": "application/json" });
    expect(seen.body).toBe(ctx.body);
    expect(seen.signal).toBe(ctx.signal);
    expect(seen.args).toEqual({ k: "v" });
    expect(seen.homedir).toBeTypeOf("string");
  });

  it("③④ 顶层键 strict（复核 R3-P2）：未知键（如 statuss 拼错）一律 HookStageError", async () => {
    const reqCtx: RequestStageCtx = {
      url: "https://u.example/x",
      method: "GET",
      headers: {},
      body: new Uint8Array(0),
      signal: AbortSignal.timeout(1_000),
    };
    await expect(
      resolveStageRequest({ name: "typo3" }, reqCtx, {
        loader: loaderOf({ typo3: { onRequest: () => ({ status: 200, headers: {}, statuss: 201 }) } }),
      }),
    ).rejects.toBeInstanceOf(HookStageError);
    await expect(
      resolveStageResponse({ name: "typo4" }, responseCtx(), {
        loader: loaderOf({ typo4: { onResponse: () => ({ boddy: new ReadableStream() }) } }),
      }),
    ).rejects.toBeInstanceOf(HookStageError);
  });

  it("局部覆盖：{} / {status} / {headers} / {body(ReadableStream|AsyncIterable)} 均合法", async () => {
    const mods = {
      noop: { onResponse: () => ({}) },
      st: { onResponse: () => ({ status: 404 }) },
      hd: { onResponse: () => ({ headers: { "x-r": "1" } }) },
      stream: { onResponse: () => ({ body: new ReadableStream() }) },
      iter: {
        onResponse: () => ({ body: (async function* () { yield new Uint8Array([9]); })() }),
      },
    };
    const loader = loaderOf(mods);
    expect(await resolveStageResponse({ name: "noop" }, responseCtx(), { loader })).toEqual({});
    expect((await resolveStageResponse({ name: "st" }, responseCtx(), { loader })).status).toBe(404);
    expect((await resolveStageResponse({ name: "hd" }, responseCtx(), { loader })).headers).toEqual({ "x-r": "1" });
    expect((await resolveStageResponse({ name: "stream" }, responseCtx(), { loader })).body).toBeInstanceOf(ReadableStream);
    const iter = await resolveStageResponse({ name: "iter" }, responseCtx(), { loader });
    expect(typeof (iter.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]).toBe("function");
  });

  it("status 域同 ③（200-599）；非对象/非法形状/抛错/缺席 → HookStageError", async () => {
    const mods = {
      low: { onResponse: () => ({ status: 199 }) },
      high: { onResponse: () => ({ status: 600 }) },
      str: { onResponse: () => "nope" },
      bodyStr: { onResponse: () => ({ body: "text" }) },
      headersNum: { onResponse: () => ({ headers: { a: 1 } }) },
      throws: { onResponse: () => { throw new Error("boom"); } },
      absent: { other: () => "x" },
    };
    const loader = loaderOf(mods);
    for (const name of ["low", "high", "str", "bodyStr", "headersNum", "throws", "absent"]) {
      await expect(resolveStageResponse({ name }, responseCtx(), { loader })).rejects.toBeInstanceOf(HookStageError);
    }
  });
});

// ---------------------------------------------------------------------------
// 错误分族（① secret_missing vs ②③④ hook_failed）
// ---------------------------------------------------------------------------

describe("错误分族与脱敏", () => {
  it("① → HookMissingError（secret_missing 族）；②③④ → HookStageError（hook_failed 族）", async () => {
    const mods = {
      a: { onRequestBearerAuthentication: () => { throw new Error("x"); } },
      b: { onRequestHeaders: () => { throw new Error("x"); } },
      c: { onRequest: () => { throw new Error("x"); } },
      d: { onResponse: () => { throw new Error("x"); } },
    };
    const loader = loaderOf(mods);
    await expect(resolveStageAuth({ script: "a" }, { loader })).rejects.toBeInstanceOf(HookMissingError);
    await expect(resolveStageHeaders({ name: "b" }, REQUEST, { loader })).rejects.toBeInstanceOf(HookStageError);
    await expect(resolveStageRequest({ name: "c" }, requestCtx(), { loader })).rejects.toBeInstanceOf(HookStageError);
    await expect(resolveStageResponse({ name: "d" }, responseCtx(), { loader })).rejects.toBeInstanceOf(HookStageError);
  });

  it("HookStageError 消息为固定脱敏文案（不含脚本名/路径/返回值）", async () => {
    const secretPath = "/Users/leaky/.aifly/hooks/leaky.cjs";
    const mods = {
      leaky: { onRequest: () => { throw new Error(`at ${secretPath} value sk-123`); } },
    };
    try {
      await resolveStageRequest({ name: "leaky" }, requestCtx(), { loader: loaderOf(mods) });
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toBe("hook stage failed");
      expect(message).not.toContain(secretPath);
      expect(message).not.toContain("leaky");
      expect(message).not.toContain("sk-123");
    }
  });
});
