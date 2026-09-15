// lifecycle v2 领域类型单源单测（hooks-lifecycle 0.1）：四槽 schema 往返 /
// 非法形状拒绝（三族互斥、args 形状、headers 值协议）、STAGE_FN_NAMES 顺序冻结、
// 掩码常量、归一出站形（类型层——编译期契约，此处仅锁运行时常量与推导入口）。

import { describe, expect, it } from "vitest";
import {
  AUTH_SLOT_SCHEMA,
  HEADERS_SLOT_SCHEMA,
  LIFECYCLE_SLOTS_SCHEMA,
  MASK_LITERAL,
  REQUEST_SLOT_SCHEMA,
  RESPONSE_SLOT_SCHEMA,
  SERVICE_VALUE_MASK,
  STAGE_FN_NAMES,
  isEnvRef,
  isMaskedRef,
  isSecretRef,
  type NormalizedUpstreamResponse,
} from "../../../src/provider/lifecycle.ts";

function ok(schema: { safeParse: (x: unknown) => { success: boolean } }, input: unknown): void {
  expect(schema.safeParse(input).success).toBe(true);
}

function bad(schema: { safeParse: (x: unknown) => { success: boolean } }, input: unknown): void {
  expect(schema.safeParse(input).success).toBe(false);
}

describe("STAGE_FN_NAMES", () => {
  it("四阶段常量与管线顺序冻结", () => {
    expect(STAGE_FN_NAMES).toEqual([
      "onRequestBearerAuthentication",
      "onRequestHeaders",
      "onRequest",
      "onResponse",
    ]);
  });
});

describe("auth 槽（三族单选 + bearer）", () => {
  it("三族各自合法（含可选 args/bearer）", () => {
    ok(AUTH_SLOT_SCHEMA, { secret: "openai-main" });
    ok(AUTH_SLOT_SCHEMA, { secret: "openai-main", bearer: false });
    ok(AUTH_SLOT_SCHEMA, { script: "codex" });
    ok(AUTH_SLOT_SCHEMA, { script: "codex", args: { path: "~/.codex/auth.json" }, bearer: true });
    ok(AUTH_SLOT_SCHEMA, { literal: "Bearer sk-xxx" });
  });

  it("非法形状拒绝：空值 / 脚本名词汇 / 多族并存 / 未知字段", () => {
    bad(AUTH_SLOT_SCHEMA, { secret: "" });
    bad(AUTH_SLOT_SCHEMA, { secret: "OpenAI" }); // 词汇：小写开头
    bad(AUTH_SLOT_SCHEMA, { script: "Not-A-Script" });
    bad(AUTH_SLOT_SCHEMA, { script: "" });
    bad(AUTH_SLOT_SCHEMA, { literal: "" });
    bad(AUTH_SLOT_SCHEMA, { secret: "a", script: "b" }); // 三族单选
    bad(AUTH_SLOT_SCHEMA, { secret: "a", unknown: 1 }); // strict
    bad(AUTH_SLOT_SCHEMA, { script: "s", args: { "": "v" } }); // args 变量名非空
    bad(AUTH_SLOT_SCHEMA, "secret");
  });
});

describe("headers 槽（remove + set 值仅字面量 + 整段脚本）", () => {
  it("合法形状（remove/set/script 组合、$env:/$secret: 字面量引用平移语义）", () => {
    ok(HEADERS_SLOT_SCHEMA, {});
    ok(HEADERS_SLOT_SCHEMA, { remove: ["x-a", "x-b"] });
    ok(HEADERS_SLOT_SCHEMA, { set: { authorization: "$env:ZAI_KEY", "x-s": "$secret:openai", "x-l": "keep" } });
    ok(HEADERS_SLOT_SCHEMA, { script: { name: "hdr", args: { mode: "strict" } } });
    ok(HEADERS_SLOT_SCHEMA, { remove: ["x-a"], set: { "x-l": "v" }, script: { name: "hdr" } });
  });

  it("非法形状拒绝：逐头脚本对象协议（v2 已删除）/ 数组 remove / 未知字段 / 上限", () => {
    // 值协议仅字面量 string——逐头脚本对象（v1 形状）必须拒绝
    bad(HEADERS_SLOT_SCHEMA, { set: { authorization: { hook: "authHeader", args: { name: "x" } } } });
    bad(HEADERS_SLOT_SCHEMA, { remove: "x-a" });
    bad(HEADERS_SLOT_SCHEMA, { remove: ["x-a"], unknown: 1 });
    bad(HEADERS_SLOT_SCHEMA, { script: { name: "hdr", args: null } });
    const many: string[] = [];
    for (let i = 0; i < 33; i++) many.push(`x-${i}`);
    bad(HEADERS_SLOT_SCHEMA, { remove: many }); // ≤32
  });
});

describe("request / response 槽", () => {
  it("合法：{script, args?}；非法：缺 script / 空 / 未知字段", () => {
    ok(REQUEST_SLOT_SCHEMA, { script: "relay" });
    ok(REQUEST_SLOT_SCHEMA, { script: "relay", args: { base: "https://x" } });
    ok(RESPONSE_SLOT_SCHEMA, { script: "transform" });
    bad(REQUEST_SLOT_SCHEMA, {});
    bad(REQUEST_SLOT_SCHEMA, { script: "" });
    bad(REQUEST_SLOT_SCHEMA, { script: "relay", unknown: 1 });
    bad(RESPONSE_SLOT_SCHEMA, { name: "transform" }); // headers.script 的形状不通用
  });
});

describe("LIFECYCLE_SLOTS_SCHEMA（四槽合体）", () => {
  it("四槽并存合法；非法槽形状整体拒绝", () => {
    ok(LIFECYCLE_SLOTS_SCHEMA, {
      auth: { secret: "openai" },
      headers: { set: { "x-a": "v" } },
      request: { script: "relay" },
      response: { script: "transform" },
    });
    ok(LIFECYCLE_SLOTS_SCHEMA, {});
    bad(LIFECYCLE_SLOTS_SCHEMA, { auth: { secret: "a", literal: "b" } });
    bad(LIFECYCLE_SLOTS_SCHEMA, { request: { script: "r", extra: true } });
  });
});

describe("掩码与间接引用", () => {
  it("SERVICE_VALUE_MASK = ●；MASK_LITERAL 仅接受掩码", () => {
    expect(SERVICE_VALUE_MASK).toBe("\u25cf");
    ok(MASK_LITERAL, SERVICE_VALUE_MASK);
    bad(MASK_LITERAL, "openai");
    bad(MASK_LITERAL, "");
  });

  it("引用判定：$env: / $secret: 前缀", () => {
    expect(isEnvRef("$env:VAR")).toBe(true);
    expect(isEnvRef("$secret:V")).toBe(false);
    expect(isSecretRef("$secret:name")).toBe(true);
    expect(isMaskedRef("$env:V")).toBe(true);
    expect(isMaskedRef("$secret:n")).toBe(true);
    expect(isMaskedRef("plain")).toBe(false);
  });
});

describe("归一出站形（类型契约）", () => {
  it("AsyncIterable body 的形状可构造（编译期契约的运行时锚点）", async () => {
    const chunks = [new Uint8Array([1]), new Uint8Array([2, 3])];
    const normalized: NormalizedUpstreamResponse = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: (async function* () {
        for (const c of chunks) yield c;
      })(),
    };
    const collected: number[] = [];
    for await (const chunk of normalized.body) collected.push(...chunk);
    expect(collected).toEqual([1, 2, 3]);
  });
});
