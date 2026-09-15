// frames.ts schema 拒绝矩阵单测：凭据类头逐个拒绝、WS 握手头放行、path 形态逐类、
// method 边界（越界字符串 vs 非字符串）、结构上限、未知字段、错误码全集、
// AUTH_OK 目录形状、RESP_META 白名单、分类 helper。

import { describe, expect, it } from "vitest";
import {
  AUTH_HEADER_SCHEMA,
  AUTH_ERR_HEADER_SCHEMA,
  AUTH_OK_HEADER_SCHEMA,
  CLOSE_HEADER_SCHEMA,
  DATA_HEADER_SCHEMA,
  ERROR_CODE,
  ERROR_HEADER_SCHEMA,
  FORBIDDEN_REQ_HEADER_NAMES,
  HTTP_METHODS,
  REQ_BODY_HEADER_SCHEMA,
  REQ_HEADER_SCHEMA,
  RESP_META_HEADER_SCHEMA,
  REJECTED_CODE,
  SERVICE_DETAIL_SCHEMA,
  SERVICE_ENTRY_SCHEMA,
  WS_HANDSHAKE_HEADER_NAMES,
  classifySchemaFailure,
} from "../../../src/wire/frames.ts";

const ID = "abcdefghijkmnpqrstuwxyz12"; // 26 字符 z32 形态

function baseReq(): Record<string, unknown> {
  return {
    v: 1,
    id: ID,
    serviceId: "svc1234567890",
    method: "POST",
    path: "/v1/chat/completions?stream=true",
    bodyLen: 1024,
  };
}

function ok(schema: { safeParse: (x: unknown) => { success: boolean } }, input: unknown): void {
  expect(schema.safeParse(input).success).toBe(true);
}

function bad(schema: { safeParse: (x: unknown) => { success: boolean } }, input: unknown): void {
  expect(schema.safeParse(input).success).toBe(false);
}

describe("REQ schema", () => {
  it("accepts a minimal request", () => {
    ok(REQ_HEADER_SCHEMA, baseReq());
  });

  it("accepts root path and dot-bearing segments", () => {
    ok(REQ_HEADER_SCHEMA, { ...baseReq(), path: "/" });
    ok(REQ_HEADER_SCHEMA, { ...baseReq(), path: "/a.b/c..d/e?f=1.2" });
    ok(REQ_HEADER_SCHEMA, { ...baseReq(), path: "/..x/.y/../z".replace("/../", "/a/") }); // ..x 与 .y 是普通段名
    bad(REQ_HEADER_SCHEMA, { ...baseReq(), path: "/..x/y/../z" }); // 含真 .. 段
  });

  it("rejects path forms: no leading slash, //, /\\, dot segments, scheme, overlength", () => {
    const cases = [
      "v1/x", // 无 / 开头（同时覆盖 scheme 形态 http://x/y）
      "http://x/y",
      "//evil.example.com/v1/keys",
      "/\\evil",
      "/a/../b",
      "/a/./b",
      "/..",
      "/.",
      "/proxy/http://upstream", // 路径段含 scheme
      "/" + "a".repeat(4 * 1024 + 1), // > 4KiB
    ];
    for (const path of cases) bad(REQ_HEADER_SCHEMA, { ...baseReq(), path });
  });

  it("allows scheme inside query string only", () => {
    ok(REQ_HEADER_SCHEMA, { ...baseReq(), path: "/r?next=http://evil.example/x" });
  });

  it("rejects each forbidden header by exact lowercase name", () => {
    for (const name of FORBIDDEN_REQ_HEADER_NAMES) {
      bad(REQ_HEADER_SCHEMA, { ...baseReq(), headers: { [name]: "x" } });
    }
  });

  it("rejects non-normalized header names (uppercase)", () => {
    bad(REQ_HEADER_SCHEMA, { ...baseReq(), headers: { "X-Custom": "v" } });
    bad(REQ_HEADER_SCHEMA, { ...baseReq(), headers: { Authorization: "Bearer x" } });
  });

  it("allows WS handshake headers and ordinary passthrough headers", () => {
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
      accept: "text/event-stream",
    };
    for (const name of WS_HANDSHAKE_HEADER_NAMES) headers[name] = "v";
    ok(REQ_HEADER_SCHEMA, { ...baseReq(), headers });
  });

  it("enforces structural limits: count/key/value", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 33; i++) many[`h${i}`] = "v";
    bad(REQ_HEADER_SCHEMA, { ...baseReq(), headers: many });
    ok(REQ_HEADER_SCHEMA, { ...baseReq(), headers: { ["k".repeat(1024)]: "v" } });
    bad(REQ_HEADER_SCHEMA, { ...baseReq(), headers: { ["k".repeat(1025)]: "v" } });
    ok(REQ_HEADER_SCHEMA, { ...baseReq(), headers: { k: "v".repeat(8 * 1024) } });
    bad(REQ_HEADER_SCHEMA, { ...baseReq(), headers: { k: "v".repeat(8 * 1024 + 1) } });
  });

  it("method: enum members pass; out-of-enum string / non-string / missing fail", () => {
    for (const m of HTTP_METHODS) ok(REQ_HEADER_SCHEMA, { ...baseReq(), method: m });
    bad(REQ_HEADER_SCHEMA, { ...baseReq(), method: "TRACE" });
    bad(REQ_HEADER_SCHEMA, { ...baseReq(), method: "get" }); // 大小写敏感
    bad(REQ_HEADER_SCHEMA, { ...baseReq(), method: 42 });
    bad(REQ_HEADER_SCHEMA, { ...baseReq(), method: null });
    const { method: _omit, ...noMethod } = baseReq() as { method: unknown };
    bad(REQ_HEADER_SCHEMA, noMethod);
  });

  it("unknown fields fail (strict); bodyLen must be a non-negative integer", () => {
    bad(REQ_HEADER_SCHEMA, { ...baseReq(), extra: 1 });
    bad(REQ_HEADER_SCHEMA, { ...baseReq(), bodyLen: -1 });
    bad(REQ_HEADER_SCHEMA, { ...baseReq(), bodyLen: 1.5 });
    const { bodyLen: _b, ...noBodyLen } = baseReq() as { bodyLen: unknown };
    bad(REQ_HEADER_SCHEMA, noBodyLen);
    ok(REQ_HEADER_SCHEMA, { ...baseReq(), contentType: "application/json" });
  });
});

describe("AUTH / AUTH_OK / AUTH_ERR schemas", () => {
  it("AUTH requires v=1 and keys.length >= 1", () => {
    ok(AUTH_HEADER_SCHEMA, { v: 1, keys: ["sk-aifly-" + "a".repeat(52)] });
    bad(AUTH_HEADER_SCHEMA, { v: 1, keys: [] });
    bad(AUTH_HEADER_SCHEMA, { v: 1 });
    bad(AUTH_HEADER_SCHEMA, { v: 2, keys: ["sk-aifly-aaaaaaaa"] });
    bad(AUTH_HEADER_SCHEMA, { keys: ["sk-aifly-aaaaaaaa"] });
  });

  it("AUTH_OK accepts a full directory payload with rejected and refresh", () => {
    const full = {
      v: 1,
      alias: "box",
      relayUrls: ["https://relay.example/announce"],
      groups: [
        {
          keyId: "key1",
          group: "friends",
          limits: { maxConcurrency: 4, dailyRequests: 1000 },
          services: [
            {
              serviceId: "svc123",
              name: "api",
              match: [{ type: "exact", value: "api.example.com" }, { type: "suffix", value: ".example.com" }, { type: "regex", value: "^api\\." }],
              defaultPort: 11434,
              detail: {
                upstream: "https://api.upstream/v1",
                match: [{ type: "exact", value: "api.example.com" }],
                rewrite: { host: "api.upstream", prefix: "/v1" },
                auth: { secret: "●", bearer: true },
                headers: {
                  remove: ["x-drop"],
                  set: { "x-key": "●", "x-literal": "keep-me" },
                  script: { name: "●" },
                },
                request: { script: "●" },
                response: { script: "●" },
              },
            },
          ],
        },
      ],
      rejected: [{ code: REJECTED_CODE.key_invalid }, { code: REJECTED_CODE.key_revoked }],
      refresh: true,
    };
    ok(AUTH_OK_HEADER_SCHEMA, full);
    bad(AUTH_OK_HEADER_SCHEMA, { ...full, groups: [] }); // 全无效应走 AUTH_ERR
    bad(AUTH_OK_HEADER_SCHEMA, { ...full, rejected: [{ code: "aborted" }] }); // rejected 码仅两值
    bad(AUTH_OK_HEADER_SCHEMA, { ...full, refresh: false }); // 仅字面 true
    bad(AUTH_OK_HEADER_SCHEMA, { ...full, unknown: 1 });
    // 帧级（第一阶段）对 detail 宽松承载：v1 形状 detail / 顶层 hooks 条目不在
    // 帧级拒绝——交由 mux 二阶段按 SERVICE_DETAIL_SCHEMA 复核（catalogDropped）。
    const v1Style = JSON.parse(JSON.stringify(full)) as Record<string, unknown>;
    (v1Style.groups as Array<{ services: Array<Record<string, unknown>> }>)[0]!.services[0]!.hooks = "env";
    (
      (v1Style.groups as Array<{ services: Array<{ detail: Record<string, unknown> }> }>)[0]!.services[0]!.detail
        .rewrite as Record<string, unknown>
    ).headerSet = [{ name: "authorization", value: "●" }];
    ok(AUTH_OK_HEADER_SCHEMA, v1Style);
    // 条目身份字段仍严格：serviceId 缺失在帧级即拒（schemaDropped 路径）。
    const noId = JSON.parse(JSON.stringify(full)) as Record<string, unknown>;
    delete (noId.groups as Array<{ services: Array<Record<string, unknown>> }>)[0]!.services[0]!.serviceId;
    bad(AUTH_OK_HEADER_SCHEMA, noId);
  });

  it("AUTH_ERR is key_all_invalid with optional message", () => {
    ok(AUTH_ERR_HEADER_SCHEMA, { v: 1, code: "key_all_invalid" });
    ok(AUTH_ERR_HEADER_SCHEMA, { v: 1, code: "key_all_invalid", message: "all keys rejected" });
    bad(AUTH_ERR_HEADER_SCHEMA, { v: 1, code: "key_invalid" });
  });
});

describe("ERROR schema", () => {
  it("accepts every stable ERROR code and optional id", () => {
    for (const code of Object.values(ERROR_CODE)) {
      ok(ERROR_HEADER_SCHEMA, { code, message: "m" });
      ok(ERROR_HEADER_SCHEMA, { id: ID, code, message: "m" });
    }
  });

  it("hook_failed 已登记（②③④ 生命周期脚本失效；穷举 enum 强制消费侧同步映射）", () => {
    expect(ERROR_CODE.hook_failed).toBe("hook_failed");
    ok(ERROR_HEADER_SCHEMA, { id: ID, code: ERROR_CODE.hook_failed, message: "lifecycle script failed" });
  });

  it("rejects rejected-only codes and missing message", () => {
    bad(ERROR_HEADER_SCHEMA, { code: REJECTED_CODE.key_invalid, message: "m" });
    bad(ERROR_HEADER_SCHEMA, { code: REJECTED_CODE.key_revoked, message: "m" });
    bad(ERROR_HEADER_SCHEMA, { code: "protocol_error" });
  });
});

describe("SERVICE_DETAIL / SERVICE_ENTRY（v2 四槽投影）", () => {
  const MASK = "\u25cf";
  const detail = {
    upstream: "https://api.upstream/v1",
    match: [{ type: "suffix", value: ".local" }],
    rewrite: {},
    auth: { secret: MASK, bearer: true },
    headers: { remove: ["x-drop"], set: { "x-a": MASK, "x-literal": "keep" }, script: { name: MASK } },
    request: { script: MASK },
    response: { script: MASK },
  };

  it("四槽掩码投影往返（掩码位仅 ●、bearer 可见、字面量原样）", () => {
    const parsed = SERVICE_DETAIL_SCHEMA.safeParse(detail);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.auth).toEqual({ secret: MASK, bearer: true });
  });

  it("敏感位仅接受掩码字面量：明文 secret/script/literal 一律拒绝", () => {
    bad(SERVICE_DETAIL_SCHEMA, { ...detail, auth: { secret: "openai" } });
    bad(SERVICE_DETAIL_SCHEMA, { ...detail, auth: { script: "codex" } });
    bad(SERVICE_DETAIL_SCHEMA, { ...detail, auth: { literal: "sk-plain" } });
    bad(SERVICE_DETAIL_SCHEMA, { ...detail, headers: { ...detail.headers, script: { name: "hdr" } } });
    bad(SERVICE_DETAIL_SCHEMA, { ...detail, request: { script: "relay" } });
    bad(SERVICE_DETAIL_SCHEMA, { ...detail, response: { script: "transform" } });
  });

  it("headers.set 引用型值（$env:/$secret:）不得裸上 wire（掩码纪律入 schema）", () => {
    bad(SERVICE_DETAIL_SCHEMA, { ...detail, headers: { set: { "x-a": "$env:KEY" } } });
    bad(SERVICE_DETAIL_SCHEMA, { ...detail, headers: { set: { "x-a": "$secret:openai" } } });
  });

  it("旧 v1 形状拒绝：rewrite.headerSet / detail 未知槽字段", () => {
    bad(
      SERVICE_DETAIL_SCHEMA,
      { ...detail, rewrite: { host: "h", headerSet: [{ name: "authorization", value: MASK }] } as never },
    );
    bad(SERVICE_DETAIL_SCHEMA, { ...detail, hooks: "env" });
  });

  it("SERVICE_ENTRY：v2 无 hooks 字段（退役）、旧顶层 hooks 拒绝", () => {
    ok(SERVICE_ENTRY_SCHEMA, {
      serviceId: "svc123",
      name: "api",
      match: [{ type: "suffix", value: ".local" }],
      defaultPort: 11434,
      detail,
    });
    bad(SERVICE_ENTRY_SCHEMA, {
      serviceId: "svc123",
      name: "api",
      match: [{ type: "suffix", value: ".local" }],
      defaultPort: 11434,
      hooks: "env",
    });
  });
});

describe("RESP_META / 分片与控制帧 schemas", () => {
  it("RESP_META header whitelist subset", () => {
    ok(RESP_META_HEADER_SCHEMA, {
      id: ID,
      status: 200,
      contentType: "application/json",
      headers: { "x-request-id": "r1", "retry-after": "10", "sec-websocket-accept": "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" },
    });
    bad(RESP_META_HEADER_SCHEMA, { id: ID, status: 200, contentType: "a", headers: { "content-type": "a" } });
    bad(RESP_META_HEADER_SCHEMA, { id: ID, status: 200, contentType: "a", headers: { "x-custom": "a" } });
    bad(RESP_META_HEADER_SCHEMA, { id: ID, status: 99, contentType: "a" });
    bad(RESP_META_HEADER_SCHEMA, { id: ID, status: 600, contentType: "a" });
  });

  it("REQ_BODY requires seq>=0 and end boolean", () => {
    ok(REQ_BODY_HEADER_SCHEMA, { id: ID, seq: 0, end: false });
    bad(REQ_BODY_HEADER_SCHEMA, { id: ID, seq: -1, end: false });
    bad(REQ_BODY_HEADER_SCHEMA, { id: ID, seq: 0 });
  });

  it("DATA frames carry v/id/seq (spec 字面含 v)", () => {
    ok(DATA_HEADER_SCHEMA, { v: 1, id: ID, seq: 0 });
    bad(DATA_HEADER_SCHEMA, { id: ID, seq: 0 });
    bad(DATA_HEADER_SCHEMA, { v: 1, id: ID, seq: "0" });
  });

  it("CLOSE code bounds (1000..65535, optional)", () => {
    ok(CLOSE_HEADER_SCHEMA, { id: ID });
    ok(CLOSE_HEADER_SCHEMA, { id: ID, code: 1000 });
    ok(CLOSE_HEADER_SCHEMA, { id: ID, code: 4999 });
    bad(CLOSE_HEADER_SCHEMA, { id: ID, code: 999 });
    bad(CLOSE_HEADER_SCHEMA, { id: ID, code: 65536 });
  });
});

describe("classifySchemaFailure", () => {
  const TYPE_REQ = 0x04;

  it("out-of-enum string method -> forbidden_method with id", () => {
    expect(classifySchemaFailure(TYPE_REQ, { ...baseReq(), method: "TRACE" })).toEqual({
      code: "forbidden_method",
      id: ID,
    });
  });

  it("non-string method -> protocol_error", () => {
    expect(classifySchemaFailure(TYPE_REQ, { ...baseReq(), method: 42 })).toEqual({
      code: "protocol_error",
      id: ID,
    });
  });

  it("forbidden headers detected case-insensitively -> forbidden_header", () => {
    for (const name of ["authorization", "Authorization", "PROXY-AUTHORIZATION", "Cookie", "HOST", "content-type"]) {
      expect(classifySchemaFailure(TYPE_REQ, { ...baseReq(), headers: { [name]: "x" } })).toEqual({
        code: "forbidden_header",
        id: ID,
      });
    }
  });

  it("everything else (unknown field, bad path, missing field, non-REQ frames) -> protocol_error", () => {
    expect(classifySchemaFailure(TYPE_REQ, { ...baseReq(), extra: 1 })).toEqual({
      code: "protocol_error",
      id: ID,
    });
    expect(classifySchemaFailure(TYPE_REQ, { ...baseReq(), path: "//x" })).toEqual({
      code: "protocol_error",
      id: ID,
    });
    expect(classifySchemaFailure(0x06, { id: ID, status: "x" })).toEqual({ code: "protocol_error", id: ID });
    expect(classifySchemaFailure(TYPE_REQ, "not-an-object")).toEqual({ code: "protocol_error" });
    expect(classifySchemaFailure(TYPE_REQ, {})).toEqual({ code: "protocol_error" }); // 无 id 可定位
  });
});
