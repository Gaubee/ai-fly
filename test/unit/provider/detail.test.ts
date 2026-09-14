// detail 脱敏披露单测：$env 头值输出 ●（变量名与值均不出现）、literal 原样、
// upstream 与 match 全集原样、prefix/host 披露形态、ASCII 展示形。

import { describe, expect, it } from "vitest";
import { buildServiceDetail, buildServiceEntry, detailDisplayLines, ENV_VALUE_MASK } from "../../../src/provider/detail.ts";
import type { ServiceConfig } from "../../../src/provider/store.ts";

const service: ServiceConfig = {
  serviceId: "svc123",
  name: "ollama",
  match: [
    { type: "exact", value: "ollama.local" },
    { type: "suffix", value: ".home.arpa" },
    { type: "regex", value: "^llm\\." },
  ],
  upstream: "http://127.0.0.1:11434",
  rewrite: {
    hostHeader: "internal.alias",
    pathPrefixStrip: "/ollama",
    pathPrefixAppend: "/api",
    headerSet: { authorization: "$env:ZAI_KEY", "x-literal": "keep-me" },
    headerRemove: ["x-drop"],
  },
  defaultPort: 11434,
  enabled: true,
};

describe("detail 披露脱敏", () => {
  const detail = buildServiceDetail(service);
  const json = JSON.stringify(detail);

  it("$env 头值显示为 ●，变量名与值都不出现", () => {
    const masked = detail.rewrite?.headerSet?.find((h) => h.name === "authorization");
    expect(masked?.value).toBe(ENV_VALUE_MASK);
    expect(json).not.toContain("ZAI_KEY");
    expect(json).not.toContain("$env");
    expect(json).not.toContain("UPSTREAM");
  });

  it("literal 值原样披露；upstream 原样；match 全集", () => {
    expect(detail.rewrite?.headerSet).toContainEqual({ name: "x-literal", value: "keep-me" });
    expect(detail.upstream).toBe("http://127.0.0.1:11434");
    expect(detail.match).toEqual(service.match);
  });

  it("host 与 prefix 披露", () => {
    expect(detail.rewrite?.host).toBe("internal.alias");
    expect(detail.rewrite?.prefix).toBe("strip:/ollama append:/api");
  });

  it("无重写配置时 rewrite 为空对象（wire schema 必填对象）", () => {
    const plain = buildServiceDetail({ ...service, rewrite: undefined });
    expect(plain.rewrite).toEqual({});
  });

  it("ServiceEntry 含脱敏 detail 与 defaultPort", () => {
    const entry = buildServiceEntry(service);
    expect(entry.serviceId).toBe("svc123");
    expect(entry.name).toBe("ollama");
    expect(entry.defaultPort).toBe(11434);
    expect(JSON.stringify(entry)).not.toContain("ZAI_KEY");
  });

  it("ASCII 展示形：● -> <hidden>（$env 与 $secret 同形；终端文案码位 < 128）", () => {
    const lines = detailDisplayLines(buildServiceDetail(service)).join("\n");
    expect(lines).toContain("header-set: authorization: <hidden>");
    expect(lines).toContain("header-set: x-literal: keep-me");
    for (const ch of lines) expect(ch.codePointAt(0)!).toBeLessThan(128);
  });

  it("$secret 引用同样 ● 掩码（名称不出现）", () => {
    const withSecret = buildServiceDetail({
      ...service,
      rewrite: {
        headerSet: { authorization: "$secret:openai", "x-literal": "keep-me" },
      },
    });
    const masked = withSecret.rewrite?.headerSet?.find((h) => h.name === "authorization");
    expect(masked?.value).toBe(ENV_VALUE_MASK);
    const json = JSON.stringify(withSecret);
    expect(json).not.toContain("openai");
    expect(json).not.toContain("$secret");
  });
});
