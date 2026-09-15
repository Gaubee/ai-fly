// 分享链接单测：构成（aifly1.<base64url(json)>）、离线 decode/preview、前置检查
// （组非空 / relay 警告 + 稳定入口指引）、脱敏（payload 无 env 变量名）、TTL 值域。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertDurationRange, parseDurationMs } from "../../../src/cli/args.ts";
import { CliError } from "../../../src/cli/errors.ts";
import { ProviderStore } from "../../../src/provider/store.ts";
import {
  buildShareLink,
  decodeShareLink,
  encodeShareLink,
  LinkError,
  previewShareLink,
  SHARE_LINK_OUTDATED_MESSAGE,
  SHARE_LINK_PREFIX,
  SHARE_TTL_MAX_MS,
  SHARE_TTL_MIN_MS,
  STABLE_ENTRY_HINT,
  type ShareLinkPayload,
} from "../../../src/provider/link.ts";

let dir: string;
let store: ProviderStore;
let serviceId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aifly-link-"));
  store = ProviderStore.open(dir);
  const svc = store.addService({
    name: "ollama",
    upstream: "http://127.0.0.1:11434",
    match: [{ type: "suffix", value: ".local" }],
    // hooks-lifecycle v2：$env 引用落 headers.set（detail 投影掩码语义不变）。
    headers: { set: { authorization: "$env:ZAI_KEY" } },
  });
  serviceId = svc.serviceId;
  store.addGroup("friends", ["ollama"]);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("链接构成与编码", () => {
  it("aifly1.<base64url(json)>：构成字段齐全（v/invite/key/keyId/provider/group/services）", () => {
    const result = buildShareLink({
      store,
      group: "friends",
      invite: "dweb1.testtoken",
      endpointId: "ep-123",
      relayUrls: ["http://relay.test:8787"],
    });
    expect(result.link.startsWith(SHARE_LINK_PREFIX)).toBe(true);
    const payload = decodeShareLink(result.link);
    expect(payload.v).toBe(1);
    expect(payload.invite).toBe("dweb1.testtoken");
    expect(payload.key).toMatch(/^sk-aifly-/);
    expect(payload.keyId).toBe(result.keyId);
    expect(payload.provider).toEqual({
      alias: "provider",
      endpointId: "ep-123",
      relayUrls: ["http://relay.test:8787"],
    });
    expect(payload.group).toBe("friends");
    expect(payload.services).toHaveLength(1);
    expect(payload.services[0]?.serviceId).toBe(serviceId);
    expect(payload.services[0]?.detail?.upstream).toBe("http://127.0.0.1:11434/");
  });

  it("每次 share 签发新钥（原文不可再现；旧钥不受影响）", () => {
    const first = buildShareLink({ store, group: "friends", invite: "dweb1.a", endpointId: "ep" });
    const second = buildShareLink({ store, group: "friends", invite: "dweb1.b", endpointId: "ep" });
    expect(first.keyId).not.toBe(second.keyId);
    expect(store.verifyKey(first.payload.key)).toMatchObject({ status: "valid" });
    expect(store.verifyKey(second.payload.key)).toMatchObject({ status: "valid" });
  });

  it("encode/decode 往返（自包含，无需联网）", () => {
    const result = buildShareLink({ store, group: "friends", invite: "dweb1.x", endpointId: "ep" });
    expect(decodeShareLink(encodeShareLink(result.payload))).toEqual(result.payload);
  });

  it("敏感信息不入链：无 env 变量名、无其它分组引用", () => {
    const result = buildShareLink({ store, group: "friends", invite: "dweb1.x", endpointId: "ep" });
    const json = JSON.stringify(result.payload);
    expect(json).not.toContain("ZAI_KEY");
    expect(json).not.toContain("$env");
    // v2 投影瘦身：store v1 过渡期的 headerSet 改写不再进 detail（头字段已迁出 rewrite 槽）
    expect(result.payload.services[0]?.detail?.rewrite).toEqual({});
  });

  it("分享 payload 携带 v2 四槽条目（encode/decode 往返保持形状）", () => {
    const payload: ShareLinkPayload = {
      v: 1,
      invite: "dweb1.x",
      key: "sk-aifly-aaaaaaaa",
      keyId: "k1",
      provider: { alias: "box", endpointId: "ep-12345678", relayUrls: [] },
      group: "friends",
      services: [
        {
          serviceId: "svc1",
          name: "api",
          match: [{ type: "suffix", value: ".local" }],
          defaultPort: 11434,
          detail: {
            upstream: "https://api.upstream/v1",
            match: [{ type: "exact", value: "api.example.com" }],
            rewrite: {},
            auth: { secret: "\u25cf", bearer: true },
            headers: {
              remove: ["x-drop"],
              set: { "x-a": "\u25cf", "x-literal": "keep-me" },
              script: { name: "\u25cf" },
            },
            request: { script: "\u25cf" },
            response: { script: "\u25cf" },
          },
        },
      ],
    };
    const decoded = decodeShareLink(encodeShareLink(payload));
    expect(decoded).toEqual(payload);
  });

  it("旧格式链接（v1 条目形状）-> 明确报「分享链接格式已过期」", () => {
    const v1 = {
      v: 1,
      invite: "dweb1.invitetoken123",
      key: "sk-aifly-aaaaaaaa",
      keyId: "k1",
      provider: { alias: "box", endpointId: "ep-12345678", relayUrls: [] },
      group: "friends",
      services: [
        {
          serviceId: "svc1",
          name: "api",
          match: [{ type: "suffix", value: ".local" }],
          defaultPort: 11434,
          hooks: "env", // v1 顶层 hooks（v2 退役）
          detail: {
            upstream: "https://api.upstream/v1",
            match: [],
            rewrite: {
              host: "api.upstream",
              prefix: "/v1",
              headerSet: [{ name: "authorization", value: "\u25cf" }], // v1 头改写披露
            },
          },
        },
      ],
    };
    expect(() => decodeShareLink(encodeShareLink(v1 as never))).toThrow(SHARE_LINK_OUTDATED_MESSAGE);
  });
});

describe("decode / preview（离线解析）", () => {
  it("畸形输入：前缀错 / base64 坏 / JSON 坏 / schema 不符 -> LinkError", () => {
    expect(() => decodeShareLink("dweb1.whatever")).toThrow(LinkError);
    expect(() => decodeShareLink("aifly1.!!!not-base64!!!")).toThrow(LinkError);
    expect(() => decodeShareLink("aifly1.YWJj")).toThrow(LinkError); // "abc" 非 JSON 对象
    const badPayload = { v: 2, invite: "x", key: "k12345678", keyId: "k", provider: { alias: "a", endpointId: "e", relayUrls: [] }, group: "g", services: [] };
    expect(() => decodeShareLink(encodeShareLink(badPayload as never))).toThrow(LinkError);
  });

  it("preview：别名/分组/服务/默认端口，且不触网", () => {
    const result = buildShareLink({ store, group: "friends", invite: "dweb1.x", endpointId: "ep-1", alias: "box" });
    const preview = previewShareLink(result.link);
    expect(preview.alias).toBe("box");
    expect(preview.group).toBe("friends");
    expect(preview.endpointId).toBe("ep-1");
    expect(preview.keyId).toBe(result.keyId);
    expect(preview.services).toEqual([{ serviceId, name: "ollama", defaultPort: 11434, matchCount: 1 }]);
  });
});

describe("前置检查", () => {
  it("分组不存在 -> 报错不签发", () => {
    expect(() =>
      buildShareLink({ store, group: "nope", invite: "dweb1.x", endpointId: "ep" }),
    ).toThrow(/not found/);
  });

  it("空分组（无服务）-> 报错，链接无意义", () => {
    store.addGroup("empty", []);
    expect(() =>
      buildShareLink({ store, group: "empty", invite: "dweb1.x", endpointId: "ep" }),
    ).toThrow(/no services/);
    // 未签发新钥
    expect(store.listKeys().some((k) => k.group === "empty")).toBe(false);
  });

  it("relay 未配置 -> 警告 + 稳定入口部署指引", () => {
    const result = buildShareLink({ store, group: "friends", invite: "dweb1.x", endpointId: "ep", relayUrls: [] });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(STABLE_ENTRY_HINT.slice(0, 20));
    expect(result.payload.provider.relayUrls).toEqual([]);
  });

  it("relay 配置齐备 -> 无警告", () => {
    const result = buildShareLink({ store, group: "friends", invite: "dweb1.x", endpointId: "ep", relayUrls: ["http://r:1"] });
    expect(result.warnings).toEqual([]);
  });
});

describe("TTL 值域（1s..30d，复用时长解析约定）", () => {
  it("合法：45m / 1s / 30d", () => {
    assertDurationRange(parseDurationMs("45m", "ttl"), SHARE_TTL_MIN_MS, SHARE_TTL_MAX_MS, "ttl", "1s..30d");
    assertDurationRange(parseDurationMs("1s", "ttl"), SHARE_TTL_MIN_MS, SHARE_TTL_MAX_MS, "ttl", "1s..30d");
    assertDurationRange(parseDurationMs("30d", "ttl"), SHARE_TTL_MIN_MS, SHARE_TTL_MAX_MS, "ttl", "1s..30d");
  });

  it("越界：500ms / 31d -> CliError", () => {
    expect(() =>
      assertDurationRange(parseDurationMs("500ms", "ttl"), SHARE_TTL_MIN_MS, SHARE_TTL_MAX_MS, "ttl", "1s..30d"),
    ).toThrow(CliError);
    expect(() =>
      assertDurationRange(parseDurationMs("31d", "ttl"), SHARE_TTL_MIN_MS, SHARE_TTL_MAX_MS, "ttl", "1s..30d"),
    ).toThrow(CliError);
  });
});
