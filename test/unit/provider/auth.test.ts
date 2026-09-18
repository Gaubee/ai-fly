// AUTH 决策单测（auth.ts 纯逻辑 + 会话表）：多钥一次授权（分组视图含 detail/limits）、
// 全无效 AUTH_ERR、单钥无效计入 rejected（key_invalid/key_revoked）、重复 AUTH、
// 撤钥处置（余钥 refresh 剔除 / 无余钥断开）。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderStore } from "../../../src/provider/store.ts";
import {
  authDirectoryFromStore,
  buildAuthOk,
  evaluateKeyring,
  handleAuthFrame,
  KeySessionIndex,
  type AuthSessionBinding,
} from "../../../src/provider/auth.ts";

let dir: string;
let store: ProviderStore;
let keyA: { keyId: string; key: string };
let keyB: { keyId: string; key: string };
let keyC: { keyId: string; key: string }; // 同组第二钥

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aifly-auth-"));
  store = ProviderStore.open(dir);
  store.addService({ name: "ollama", upstream: "http://127.0.0.1:11434", match: [{ type: "suffix", value: ".local" }] });
  store.addService({ name: "web", upstream: "http://127.0.0.1:8080", match: [{ type: "suffix", value: ".home" }] });
  store.addGroup("alpha", ["ollama"], { maxConcurrency: 3, dailyRequests: 100 });
  store.addGroup("beta", ["web"]);
  keyA = store.issueKey("alpha");
  keyB = store.issueKey("beta");
  keyC = store.issueKey("alpha");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function dirOf(relayUrls: string[] = ["http://relay.test:8787"]) {
  return authDirectoryFromStore(store, { relayUrls });
}

describe("handleAuthFrame 矩阵", () => {
  it("多钥一次授权：AUTH_OK 含两组视图（limits + services 含 detail）", () => {
    const decision = handleAuthFrame({ v: 1, keys: [keyA.key, keyB.key] }, dirOf());
    expect(decision.kind).toBe("ok");
    if (decision.kind !== "ok") return;
    expect(decision.header.alias).toBe("provider");
    expect(decision.header.relayUrls).toEqual(["http://relay.test:8787"]);
    expect(decision.header.groups).toHaveLength(2);
    const alpha = decision.header.groups.find((g) => g.group === "alpha");
    expect(alpha?.limits).toEqual({ maxConcurrency: 3, dailyRequests: 100 });
    expect(alpha?.services[0]?.name).toBe("ollama");
    // 帧级目录条目的 detail 宽松承载（二阶段在消费侧严格解析）；此处取形状断言。
    expect((alpha?.services[0]?.detail as { upstream?: string } | undefined)?.upstream).toBe("http://127.0.0.1:11434/");
    expect(decision.header.rejected).toBeUndefined();
    expect(decision.valid.map((v) => v.keyId).sort()).toEqual([keyA.keyId, keyB.keyId].sort());
  });

  it("同组多钥：每钥一个 groups 条目", () => {
    const decision = handleAuthFrame({ v: 1, keys: [keyA.key, keyC.key] }, dirOf());
    expect(decision.kind === "ok" && decision.header.groups).toHaveLength(2);
    expect(decision.kind === "ok" && decision.header.groups.every((g) => g.group === "alpha")).toBe(true);
  });

  it("混合无效钥：AUTH_OK + rejected 计数（key_invalid）", () => {
    const decision = handleAuthFrame({ v: 1, keys: [keyA.key, "sk-aifly-garbage"] }, dirOf());
    expect(decision.kind).toBe("ok");
    if (decision.kind !== "ok") return;
    expect(decision.header.rejected).toEqual([{ code: "key_invalid" }]);
    expect(decision.header.groups).toHaveLength(1);
  });

  it("撤钥后计入 rejected（key_revoked）", () => {
    store.revokeKey(keyA.keyId);
    const decision = handleAuthFrame({ v: 1, keys: [keyA.key] }, dirOf());
    expect(decision.kind).toBe("err"); // 唯一钥被撤 -> 全无效
    const mixed = handleAuthFrame({ v: 1, keys: [keyA.key, keyB.key] }, dirOf());
    expect(mixed.kind === "ok" && mixed.header.rejected).toEqual([{ code: "key_revoked" }]);
  });

  it("全无效 -> AUTH_ERR(key_all_invalid)", () => {
    const decision = handleAuthFrame({ v: 1, keys: ["sk-aifly-nope1", "sk-aifly-nope2"] }, dirOf());
    expect(decision).toMatchObject({ kind: "err" });
    if (decision.kind !== "err") return;
    expect(decision.header.code).toBe("key_all_invalid");
    expect(decision.header.v).toBe(1);
  });

  it("重复呈交同一钥去重", () => {
    const { valid, rejected } = evaluateKeyring([keyA.key, keyA.key, keyA.key], dirOf());
    expect(valid).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it("relayUrls 随目录同步进 AUTH_OK", () => {
    const header = buildAuthOk([{ keyId: keyA.keyId, group: "alpha" }], dirOf(["http://new-relay:1"]), {});
    expect(header.relayUrls).toEqual(["http://new-relay:1"]);
    const refreshed = buildAuthOk([{ keyId: keyA.keyId, group: "alpha" }], dirOf(), { refresh: true });
    expect(refreshed.refresh).toBe(true);
  });
});

describe("KeySessionIndex + 撤钥处置", () => {
  interface FakeBinding extends AuthSessionBinding {
    keys: string[];
    keyIds: ReadonlySet<string>;
    pushed: unknown[];
    disconnected: string[];
  }

  function binding(keys: string[], keyIds: string[]): FakeBinding {
    const b: FakeBinding = {
      keys,
      keyIds: new Set(keyIds),
      pushed: [],
      disconnected: [],
      pushRefresh: async (header) => {
        b.pushed.push(header);
      },
      disconnect: (reason) => {
        b.disconnected.push(reason);
      },
    };
    return b;
  }

  it("index 按 keyId 定位持钥会话；track 覆盖旧授权（重复 AUTH）", () => {
    const index = new KeySessionIndex();
    const ab = binding([keyA.key, keyB.key], [keyA.keyId, keyB.keyId]);
    index.track(ab);
    expect(index.sessionsWithKey(keyA.keyId)).toEqual([ab]);
    // 重复 AUTH 后只剩 B
    ab.keyIds = new Set([keyB.keyId]);
    index.track(ab);
    expect(index.sessionsWithKey(keyA.keyId)).toEqual([]);
    expect(index.sessionsWithKey(keyB.keyId)).toEqual([ab]);
  });









});
