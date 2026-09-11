// consumer/join 单测：aifly1. 链接解码矩阵（schema 自带、坏链接报错）、importLink
// 判定矩阵（新设备兑换/老设备跳过兑换/失败清理不留半初始化）、joinDevice（staging
// 归位/已入网保身份/名册识别提供者）、addKey（未入网指引/入环/格式校验）、preview
// 零网络（经 CLI 命令入口验证不触 SDK）。

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomZ32 } from "../../../src/wire/z32.ts";
import type { ServiceEntry } from "../../../src/wire/frames.ts";
import { CliError } from "../../../src/cli/errors.ts";
import {
  KEY_PREFIX,
  addKey,
  assertKeyFormat,
  decodeShareLink,
  formatLinkPreview,
  importLink,
  joinDevice,
  type LinkPayload,
} from "../../../src/consumer/join.ts";
import { fabricDir, keyringDir, loadKeyring, saveKeyring, type Keyring } from "../../../src/consumer/store.ts";
import type { FabricFactory, FabricLike, FabricMember } from "../../../src/consumer/providers.ts";
import * as importCommand from "../../../src/cli/commands/consumer/import.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aifly-consumer-join-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function epId(): string {
  return randomZ32(32);
}

function keyText(): string {
  return KEY_PREFIX + randomZ32(32);
}

function svc(serviceId: string, name: string, defaultPort: number): ServiceEntry {
  return { serviceId, name, match: [{ type: "suffix", value: ".local" }], defaultPort };
}

function payloadOf(overrides: Partial<LinkPayload> = {}): LinkPayload {
  return {
    v: 1,
    invite: "dweb1.invitetoken123",
    key: keyText(),
    keyId: randomZ32(8),
    provider: { alias: "home-box", endpointId: epId(), relayUrls: ["http://192.168.1.9:8787"] },
    group: "friends",
    services: [svc(randomZ32(8), "ollama", 11434), svc(randomZ32(8), "qwen", 8787)],
    ...overrides,
  };
}

function encodeLink(payload: LinkPayload): string {
  return `aifly1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

/** fake Fabric：记录调用，可编程 members 与失败。 */
function fakeFabric(opts: { me?: string; members?: FabricMember[]; failJoin?: boolean; failOpen?: boolean }): {
  fabric: FabricLike;
} {
  const me = opts.me ?? epId();
  return {
    fabric: {
      endpointId: me,
      connect: async () => undefined,
      disconnect: async () => undefined,
      send: async () => undefined,
      linkStatus: async () => "direct",
      on: () => () => undefined,
      members: async () => opts.members ?? [],
      shutdown: async () => undefined,
    },
  };
}

interface FakeFactory extends FabricFactory {
  opens: string[];
  joins: Array<{ dataDir: string; token: string }>;
  onJoin: ((dataDir: string) => FabricLike) | undefined;
  onOpen: ((dataDir: string) => FabricLike) | undefined;
}

function fakeFactory(): FakeFactory {
  const f: FakeFactory = {
    opens: [],
    joins: [],
    onJoin: undefined,
    onOpen: undefined,
    open: async (opts) => {
      f.opens.push(opts.dataDir);
      return f.onOpen !== undefined ? f.onOpen(opts.dataDir) : fakeFabric({}).fabric;
    },
    joinWithToken: async (opts, token) => {
      f.joins.push({ dataDir: opts.dataDir, token });
      return f.onJoin !== undefined ? f.onJoin(opts.dataDir) : fakeFabric({}).fabric;
    },
  };
  return f;
}

// ---------------------------------------------------------------------------
// 链接解码
// ---------------------------------------------------------------------------

describe("decodeShareLink", () => {
  it("合法链接解码（字段完整、服务视图含 defaultPort）", () => {
    const payload = payloadOf();
    const decoded = decodeShareLink(encodeLink(payload));
    expect(decoded.provider.alias).toBe("home-box");
    expect(decoded.services.map((s) => s.defaultPort)).toEqual([11434, 8787]);
  });

  it("坏前缀 / 坏 base64url / 坏 JSON / schema 违例 各自报 CliError", () => {
    expect(() => decodeShareLink("dweb1.whatever")).toThrow(CliError);
    expect(() => decodeShareLink("aifly1.!!!not-base64!!!")).toThrow(CliError);
    expect(() => decodeShareLink(`aifly1.${Buffer.from("not json").toString("base64url")}`)).toThrow(CliError);
    const badKey = payloadOf({ key: "not-a-fly-key" });
    expect(() => decodeShareLink(encodeLink(badKey))).toThrow(/key/);
    const badInvite = payloadOf({ invite: "wrongprefix.x" });
    expect(() => decodeShareLink(encodeLink(badInvite))).toThrow(/invite/);
    const badVersion = { ...payloadOf(), v: 2 } as unknown as LinkPayload;
    expect(() => decodeShareLink(encodeLink(badVersion))).toThrow(CliError);
  });

  it("preview 摘要含别名/分组/端口与“链接即凭证”提示", () => {
    const lines = formatLinkPreview(payloadOf());
    expect(lines.join("\n")).toContain("home-box");
    expect(lines.join("\n")).toContain("friends");
    expect(lines.join("\n")).toContain("11434");
    expect(lines.join("\n")).toContain("treat it like a password");
  });
});

// ---------------------------------------------------------------------------
// importLink 判定矩阵
// ---------------------------------------------------------------------------

describe("importLink", () => {
  it("新设备：joinWithToken 兑换（dataDir 指向 <ep8>/fabric）+ 入环 + 服务种子", async () => {
    const payload = payloadOf();
    const factory = fakeFactory();
    const result = await importLink(encodeLink(payload), { consumersRoot: root, fabric: factory });
    expect(result.redeemed).toBe(true);
    expect(factory.joins).toHaveLength(1);
    expect(factory.joins[0]!.dataDir).toBe(fabricDir(root, payload.provider.endpointId));
    expect(factory.joins[0]!.token).toBe(payload.invite);
    expect(factory.opens).toEqual([]);
    const ring = loadKeyring(root, payload.provider.endpointId);
    expect(ring?.keys).toEqual([{ keyId: payload.keyId, key: payload.key, group: "friends" }]);
    expect(ring?.services.map((s) => s.defaultPort).sort((a, b) => a - b)).toEqual([8787, 11434]);
    expect(ring?.relayUrls).toEqual(payload.provider.relayUrls);
  });

  it("老设备：有 fabric 目录 → open 校验、零兑换，密钥直接入环（多钥并存）", async () => {
    const payload = payloadOf();
    const existing: Keyring = {
      alias: "old-alias",
      endpointId: payload.provider.endpointId,
      relayUrls: [],
      keys: [{ keyId: "kid-old", key: keyText(), group: "old-group" }],
      services: [svc("svc-old", "oldsvc", 3000)],
      ports: {},
      actualPorts: {},
    };
    saveKeyring(root, existing);
    mkdirSync(fabricDir(root, payload.provider.endpointId), { recursive: true }); // fabric 身份已存在
    const factory = fakeFactory();
    const result = await importLink(encodeLink(payload), { consumersRoot: root, fabric: factory });
    expect(result.redeemed).toBe(false);
    expect(factory.joins).toEqual([]);
    expect(factory.opens).toEqual([fabricDir(root, payload.provider.endpointId)]);
    const ring = loadKeyring(root, payload.provider.endpointId);
    expect(ring?.keys.map((k) => k.keyId).sort()).toEqual(["kid-old", payload.keyId].sort());
    expect(ring?.services.map((s) => s.serviceId).sort()).toEqual(["svc-old", payload.services[0]!.serviceId, payload.services[1]!.serviceId].sort());
  });

  it("新设备兑换失败：整体回收新建目录，不留半初始化状态", async () => {
    const payload = payloadOf();
    const factory = fakeFactory();
    factory.onJoin = () => {
      throw new Error("issuer offline");
    };
    await expect(importLink(encodeLink(payload), { consumersRoot: root, fabric: factory })).rejects.toThrow(CliError);
    expect(existsSync(keyringDir(root, payload.provider.endpointId))).toBe(false);
  });

  it("老设备 open 失败：报错且既有钥环不动", async () => {
    const payload = payloadOf();
    const existing: Keyring = {
      alias: "a",
      endpointId: payload.provider.endpointId,
      relayUrls: [],
      keys: [],
      services: [],
      ports: {},
      actualPorts: {},
    };
    saveKeyring(root, existing);
    mkdirSync(fabricDir(root, payload.provider.endpointId), { recursive: true });
    const factory = fakeFactory();
    factory.onOpen = () => {
      throw new Error("corrupt identity");
    };
    await expect(importLink(encodeLink(payload), { consumersRoot: root, fabric: factory })).rejects.toThrow(/corrupt identity/);
    expect(loadKeyring(root, payload.provider.endpointId)).toEqual(existing);
  });
});

// ---------------------------------------------------------------------------
// joinDevice（令牌入网）
// ---------------------------------------------------------------------------

describe("joinDevice", () => {
  it("staging 兑换 → 归位 <ep8>/fabric + 空钥环骨架（alias 取名册 displayName）", async () => {
    const providerEp = epId();
    const factory = fakeFactory();
    factory.onJoin = () =>
      fakeFabric({
        me: "me" + "0".repeat(50),
        members: [
          { endpointId: providerEp, displayName: "home-box", sinceMs: 1 },
          { endpointId: "me" + "0".repeat(50), sinceMs: 2 },
        ],
      }).fabric;
    const result = await joinDevice("dweb1.token-x", root, { fabric: factory });
    expect(result.alreadyJoined).toBe(false);
    expect(result.ring.alias).toBe("home-box");
    expect(result.ring.endpointId).toBe(providerEp);
    expect(existsSync(fabricDir(root, providerEp))).toBe(true);
    expect(loadKeyring(root, providerEp)?.keys).toEqual([]);
    // staging 不残留
    const leftovers = rootEntries().filter((n) => n.startsWith(".join-staging"));
    expect(leftovers).toEqual([]);
  });

  it("已入网：保留既有身份与钥环，丢弃 staging（token 已消耗如实提示）", async () => {
    const providerEp = epId();
    const existing: Keyring = { alias: "kept", endpointId: providerEp, relayUrls: [], keys: [{ keyId: "k", key: keyText(), group: "g" }], services: [], ports: {}, actualPorts: {} };
    saveKeyring(root, existing);
    mkdirSync(fabricDir(root, providerEp), { recursive: true });
    const factory = fakeFactory();
    factory.onJoin = () =>
      fakeFabric({
        me: "me" + "0".repeat(50),
        members: [
          { endpointId: providerEp, displayName: "home-box", sinceMs: 1 },
          { endpointId: "me" + "0".repeat(50), sinceMs: 9 },
        ],
      }).fabric;
    const result = await joinDevice("dweb1.token-x", root, { fabric: factory });
    expect(result.alreadyJoined).toBe(true);
    expect(result.ring.alias).toBe("kept");
    expect(result.ring.keys).toHaveLength(1);
    expect(rootEntries().filter((n) => n.startsWith(".join-staging"))).toEqual([]);
  });

  it("兑换失败：无残留目录", async () => {
    const factory = fakeFactory();
    factory.onJoin = () => {
      throw new Error("invite expired");
    };
    await expect(joinDevice("dweb1.bad", root, { fabric: factory })).rejects.toThrow(/invite expired/);
    expect(rootEntries()).toEqual([]);
  });

  it("非 dweb1 令牌立即报错（不触 Fabric）", async () => {
    const factory = fakeFactory();
    await expect(joinDevice("sk-aifly-oops", root, { fabric: factory })).rejects.toThrow(CliError);
    expect(factory.joins).toHaveLength(0);
  });
});

function rootEntries(): string[] {
  return readdirSync(root);
}

// ---------------------------------------------------------------------------
// addKey（裸密钥入环）
// ---------------------------------------------------------------------------

describe("addKey", () => {
  it("未入网提供者：报错并指引先 join/import", () => {
    expect(() => addKey(keyText(), "nobody", root)).toThrow(/ai-fly join/);
  });

  it("已入网：入环生效（幂等），keyId/group 留待 AUTH_OK 回填", () => {
    const ep = epId();
    saveKeyring(root, { alias: "p", endpointId: ep, relayUrls: [], keys: [], services: [], ports: {}, actualPorts: {} });
    mkdirSync(fabricDir(root, ep), { recursive: true });
    const key = keyText();
    const r1 = addKey(key, ep, root);
    expect(r1.added).toBe(true);
    expect(r1.ring.keys).toEqual([{ keyId: "", key, group: "" }]);
    const r2 = addKey(key, ep.slice(0, 8), root); // 前缀定位 + 幂等
    expect(r2.added).toBe(false);
    expect(loadKeyring(root, ep)?.keys).toHaveLength(1);
  });

  it("格式校验：前缀与 z32(32B) 严格", () => {
    expect(() => assertKeyFormat("sk-aifly-short")).toThrow(CliError);
    expect(() => assertKeyFormat("wrongprefix" + randomZ32(32))).toThrow(CliError);
    expect(() => assertKeyFormat(KEY_PREFIX + "0")).toThrow(CliError);
    expect(() => assertKeyFormat(keyText())).not.toThrow();
  });

  it("别名定位同样生效", () => {
    const ep = epId();
    saveKeyring(root, { alias: "byname", endpointId: ep, relayUrls: [], keys: [], services: [], ports: {}, actualPorts: {} });
    mkdirSync(fabricDir(root, ep), { recursive: true });
    expect(addKey(keyText(), "byname", root).added).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// --preview 零网络（CLI 命令入口；不触 SDK/无目录副作用）
// ---------------------------------------------------------------------------

describe("import --preview（CLI）", () => {
  it("离线解析打印摘要，退出码 0，不创建任何文件", async () => {
    const payload = payloadOf();
    const lines: string[] = [];
    const code = await importCommand.run([encodeLink(payload), "--preview"], {
      homedir: root,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("home-box");
    expect(lines.join("\n")).toContain("friends");
    expect(lines.join("\n")).toContain("11434");
    expect(lines.join("\n")).toContain("8787");
    expect(rootEntries()).toEqual([]); // 零副作用（consumers 根在 root/.aifly/consumers）
  });

  it("坏链接退出码 1（CliError 由上层捕获的路径在测试里直接断言抛出）", async () => {
    await expect(importCommand.run(["aifly1.!!!", "--preview"], { homedir: root, out: () => undefined })).rejects.toThrow(CliError);
  });
});
