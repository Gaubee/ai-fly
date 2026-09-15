// detail 脱敏披露单测（hooks-lifecycle v2 四槽）：auth 槽整值掩码 ●（secret 名/
// script 绑定/literal 值均不出网）、headers.set 引用型字面量（$env:/$secret:）掩码
// 而纯字面量原样、headers.script/request/response 脚本绑定掩码（无名称与 args）、
// bearer 开关可见、upstream/match/remove 原样、host/prefix 披露形态、ASCII 展示形。

import { describe, expect, it } from "vitest";
import { buildServiceDetail, buildServiceEntry, detailDisplayLines, ENV_VALUE_MASK } from "../../../src/provider/detail.ts";
import { SERVICE_DETAIL_SCHEMA } from "../../../src/wire/frames.ts";
import type { ServiceEntrySource } from "../../../src/provider/detail.ts";

const base: ServiceEntrySource = {
  serviceId: "svc123",
  name: "ollama",
  match: [
    { type: "exact", value: "ollama.local" },
    { type: "suffix", value: ".home.arpa" },
    { type: "regex", value: "^llm\\." },
  ],
  upstream: "http://127.0.0.1:11434",
  rewrite: {
    host: "internal.alias",
    pathPrefixStrip: "/ollama",
    pathPrefixAppend: "/api",
  },
  defaultPort: 11434,
};

describe("detail 披露脱敏（v2 四槽）", () => {
  it("auth.secret：整值掩码 ●，密钥名不出现", () => {
    const detail = buildServiceDetail({ ...base, auth: { secret: "openai-key", bearer: true } });
    expect(detail.auth).toEqual({ secret: ENV_VALUE_MASK, bearer: true });
    const json = JSON.stringify(detail);
    expect(json).not.toContain("openai-key");
  });

  it("auth.script：绑定掩码，脚本名与 args 都不出现", () => {
    const detail = buildServiceDetail({ ...base, auth: { script: "codex", args: { path: "~/.codex/auth.json" } } });
    expect(detail.auth).toEqual({ script: ENV_VALUE_MASK });
    const json = JSON.stringify(detail);
    expect(json).not.toContain("codex");
    expect(json).not.toContain("auth.json");
  });

  it("auth.literal：整值掩码（字面量即凭证语义），原值不出现", () => {
    const detail = buildServiceDetail({ ...base, auth: { literal: "sk-literal-secret", bearer: false } });
    expect(detail.auth).toEqual({ literal: ENV_VALUE_MASK, bearer: false });
    expect(JSON.stringify(detail)).not.toContain("sk-literal-secret");
  });

  it("headers.set：$env/$secret 引用整体掩码（名与值都不出），纯字面量原样", () => {
    const detail = buildServiceDetail({
      ...base,
      headers: {
        set: { authorization: "$env:ZAI_KEY", "x-via-secret": "$secret:openai", "x-literal": "keep-me" },
      },
    });
    expect(detail.headers?.set).toEqual({
      authorization: ENV_VALUE_MASK,
      "x-via-secret": ENV_VALUE_MASK,
      "x-literal": "keep-me",
    });
    const json = JSON.stringify(detail);
    expect(json).not.toContain("ZAI_KEY");
    expect(json).not.toContain("$env");
    expect(json).not.toContain("openai");
    expect(json).not.toContain("$secret");
  });

  it("headers.remove 原样披露；headers.script 绑定掩码（无名称与 args）", () => {
    const detail = buildServiceDetail({
      ...base,
      headers: { remove: ["x-drop"], script: { name: "hdr", args: { mode: "strict" } } },
    });
    expect(detail.headers?.remove).toEqual(["x-drop"]);
    expect(detail.headers?.script).toEqual({ name: ENV_VALUE_MASK });
    expect(JSON.stringify(detail)).not.toContain("hdr");
    expect(JSON.stringify(detail)).not.toContain("strict");
  });

  it("request/response 槽：绑定掩码，脚本名与 args 不出现", () => {
    const detail = buildServiceDetail({
      ...base,
      request: { script: "relay", args: { base: "http://x" } },
      response: { script: "transform" },
    });
    expect(detail.request).toEqual({ script: ENV_VALUE_MASK });
    expect(detail.response).toEqual({ script: ENV_VALUE_MASK });
    const json = JSON.stringify(detail);
    expect(json).not.toContain("relay");
    expect(json).not.toContain("transform");
    expect(json).not.toContain("http://x");
  });

  it("host 与 prefix 披露；无重写配置时 rewrite 为空对象（wire schema 必填对象）", () => {
    const detail = buildServiceDetail(base);
    expect(detail.rewrite?.host).toBe("internal.alias");
    expect(detail.rewrite?.prefix).toBe("strip:/ollama append:/api");
    const plain = buildServiceDetail({ ...base, rewrite: undefined });
    expect(plain.rewrite).toEqual({});
  });

  it("upstream 与 match 全集原样", () => {
    const detail = buildServiceDetail(base);
    expect(detail.upstream).toBe("http://127.0.0.1:11434");
    expect(detail.match).toEqual(base.match);
  });

  it("投影形状通过 wire SERVICE_DETAIL_SCHEMA（严格 v2）", () => {
    const detail = buildServiceDetail({
      ...base,
      auth: { secret: "s" },
      headers: { remove: ["x-drop"], set: { "x-a": "v" }, script: { name: "h" } },
      request: { script: "r" },
      response: { script: "t" },
    });
    expect(SERVICE_DETAIL_SCHEMA.safeParse(detail).success).toBe(true);
  });

  it("ServiceEntry 含脱敏 detail 与 defaultPort", () => {
    const entry = buildServiceEntry({ ...base, auth: { literal: "sk-very-secret" } });
    expect(entry.serviceId).toBe("svc123");
    expect(entry.name).toBe("ollama");
    expect(entry.defaultPort).toBe(11434);
    expect(SERVICE_DETAIL_SCHEMA.safeParse(entry.detail).success).toBe(true);
    expect(JSON.stringify(entry)).not.toContain("sk-very-secret");
  });

  it("ASCII 展示形：掩码位 -> <hidden>（终端文案码位 < 128）", () => {
    const lines = detailDisplayLines(
      buildServiceDetail({
        ...base,
        auth: { secret: "s", bearer: false },
        headers: { set: { authorization: "$env:K", "x-literal": "keep-me" }, remove: ["x-drop"] },
        request: { script: "r" },
        response: { script: "t" },
      }),
    ).join("\n");
    expect(lines).toContain("auth: secret <hidden> (bearer off)");
    expect(lines).toContain("header-set: authorization: <hidden>");
    expect(lines).toContain("header-set: x-literal: keep-me");
    expect(lines).toContain("header-remove: x-drop");
    expect(lines).toContain("request: script <hidden>");
    expect(lines).toContain("response: script <hidden>");
    for (const ch of lines) expect(ch.codePointAt(0)!).toBeLessThan(128);
  });
});
