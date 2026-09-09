// consumer/store 单测：钥环合并幂等（重复 keyId 更新/多钥并存/裸密钥占位回填）、
// forget 整环删除、目录全量替换（新增/删除/relay 变更/端口修剪）、setPort、前缀/
// 别名定位、0600/0700 权限与原子写落盘。

import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomZ32 } from "../../../src/wire/z32.ts";
import type { ServiceEntry } from "../../../src/wire/frames.ts";
import { CliError } from "../../../src/cli/errors.ts";
import {
  addKeyToRing,
  applyCatalog,
  fabricDir,
  findKeyringDir,
  keyringDir,
  listKeyrings,
  loadKeyring,
  mergeImportView,
  reconcileKeyMetadata,
  removeKeyring,
  saveKeyring,
  setPort,
  updateServices,
  upsertKey,
  type Keyring,
} from "../../../src/consumer/store.ts";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "aifly-consumer-store-"));
}

function endpointId(): string {
  return randomZ32(32); // 52 字符 z32（与 fabric EndpointId 同形态）
}

function service(serviceId: string, name: string, port: number): ServiceEntry {
  return {
    serviceId,
    name,
    match: [{ type: "suffix", value: ".local" }],
    defaultPort: port,
  };
}

function ringOf(ep: string, alias = "prov"): Keyring {
  return { alias, endpointId: ep, relayUrls: ["http://r1"], keys: [], services: [], ports: {} };
}

let root: string;

beforeEach(() => {
  root = tmpRoot();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("keyring 持久化", () => {
  it("0600 文件 / 0700 目录、内容往返", () => {
    const ep = endpointId();
    const ring = ringOf(ep);
    saveKeyring(root, ring);
    const dir = keyringDir(root, ep);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const p = join(dir, "keyring.json");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(loadKeyring(root, ep)).toEqual(ring);
    // 无 tmp 残留（原子写）
    expect(readdirSync(dir).filter((f) => f.startsWith(".keyring"))).toEqual([]);
  });

  it("重复 save 覆盖同一路径", () => {
    const ep = endpointId();
    saveKeyring(root, ringOf(ep));
    const r2 = { ...ringOf(ep, "alias2"), keys: [{ keyId: "k1", key: "sk-aifly-aaaaaaaa", group: "g1" }] };
    saveKeyring(root, r2);
    expect(loadKeyring(root, ep)).toEqual(r2);
  });
});

describe("upsertKey 合并幂等", () => {
  it("重复 keyId 原位更新而非追加", () => {
    const ring = ringOf(endpointId());
    const a = upsertKey(ring, { keyId: "kid1", key: "sk-aifly-k1", group: "g1" });
    expect(a.added).toBe(true);
    const b = upsertKey(a.ring, { keyId: "kid1", key: "sk-aifly-rotated", group: "g1" });
    expect(b.added).toBe(false);
    expect(b.ring.keys).toHaveLength(1);
    expect(b.ring.keys[0]).toEqual({ keyId: "kid1", key: "sk-aifly-rotated", group: "g1" });
  });

  it("多枚密钥并存（不同 keyId）", () => {
    let ring = ringOf(endpointId());
    ring = upsertKey(ring, { keyId: "kid1", key: "sk-aifly-k1", group: "g1" }).ring;
    ring = upsertKey(ring, { keyId: "kid2", key: "sk-aifly-k2", group: "g2" }).ring;
    expect(ring.keys.map((k) => k.keyId)).toEqual(["kid1", "kid2"]);
  });

  it("裸密钥（keyId 空）按 key 原文去重", () => {
    let ring = ringOf(endpointId());
    ring = upsertKey(ring, { keyId: "", key: "sk-aifly-bare", group: "" }).ring;
    const again = upsertKey(ring, { keyId: "", key: "sk-aifly-bare", group: "" });
    expect(again.added).toBe(false);
    expect(again.ring.keys).toHaveLength(1);
  });

  it("AUTH_OK groups 回填裸密钥元数据（单枚未知时精确配对）", () => {
    let ring = ringOf(endpointId());
    ring = upsertKey(ring, { keyId: "known", key: "sk-aifly-known", group: "g1" }).ring;
    ring = upsertKey(ring, { keyId: "", key: "sk-aifly-bare", group: "" }).ring;
    const filled = reconcileKeyMetadata(ring, [
      { keyId: "known", group: "g1" },
      { keyId: "fresh", group: "g9" },
    ]);
    expect(filled.keys.find((k) => k.key === "sk-aifly-bare")).toEqual({ keyId: "fresh", key: "sk-aifly-bare", group: "g9" });
  });

  it("数量不齐时保守不动", () => {
    const ring = ringOf(endpointId());
    const r = upsertKey(ring, { keyId: "", key: "sk-aifly-bare", group: "" }).ring;
    const unchanged = reconcileKeyMetadata(r, [
      { keyId: "a", group: "g" },
      { keyId: "b", group: "g" },
    ]);
    expect(unchanged.keys[0]).toEqual({ keyId: "", key: "sk-aifly-bare", group: "" });
  });
});

describe("mergeImportView / applyCatalog", () => {
  it("import 视图按 serviceId 并入，不丢其它分组服务", () => {
    const ep = endpointId();
    const s1 = service("svc-a", "ollama", 11434);
    const base = { ...ringOf(ep), services: [s1] };
    const s2 = service("svc-b", "qwen", 8787);
    const { ring } = mergeImportView(
      base,
      { alias: "prov", endpointId: ep, relayUrls: ["http://r9"], services: [s2, { ...s1, name: "ollama-v2" }] },
      { keyId: "kid2", key: "sk-aifly-k2", group: "g2" },
    );
    expect(ring.services.map((s) => s.serviceId).sort()).toEqual(["svc-a", "svc-b"]);
    expect(ring.services.find((s) => s.serviceId === "svc-a")?.name).toBe("ollama-v2"); // 链接版本胜出
    expect(ring.relayUrls).toEqual(["http://r9"]);
    expect(ring.keys).toHaveLength(1);
  });

  it("目录刷新全量替换：新增/删除/relay 变更/端口修剪", () => {
    const ep = endpointId();
    let ring = ringOf(ep);
    ring.services = [service("svc-a", "a", 1), service("svc-del", "del", 2)];
    ring.ports = { "svc-a": 1234, "svc-del": 5678 };
    const next = applyCatalog(ring, {
      relayUrls: ["http://new-relay"],
      services: [service("svc-a", "a2", 1), service("svc-new", "new", 3)],
    });
    expect(next.services.map((s) => s.serviceId).sort()).toEqual(["svc-a", "svc-new"]);
    expect(next.relayUrls).toEqual(["http://new-relay"]);
    expect(next.ports).toEqual({ "svc-a": 1234 }); // 被删服务端口记录移除
  });

  it("updateServices 落盘并可回读（含 alias 更新）", () => {
    const ep = endpointId();
    saveKeyring(root, ringOf(ep));
    const next = updateServices(root, ep, { alias: "prov2", relayUrls: [], services: [service("svc-x", "x", 9)] });
    expect(next.alias).toBe("prov2");
    expect(loadKeyring(root, ep)?.services[0]?.serviceId).toBe("svc-x");
  });
});

describe("定位与删除", () => {
  it("完整 endpointId / 8 字符前缀 / 别名定位", () => {
    const ep = endpointId();
    saveKeyring(root, { ...ringOf(ep, "myprov"), keys: [{ keyId: "k", key: "sk-aifly-x1", group: "g" }] });
    expect(loadKeyring(root, ep)?.alias).toBe("myprov");
    expect(loadKeyring(root, ep.slice(0, 8))?.alias).toBe("myprov");
    expect(loadKeyring(root, "myprov")?.alias).toBe("myprov");
    expect(loadKeyring(root, "zzzzzzzz")).toBeUndefined();
  });

  it("同 8 字符前缀的两个提供者共享目录（后写覆盖——设计即如此，前缀引用指向最终环）", () => {
    const a = endpointId();
    const b = a.slice(0, 8) + randomZ32(24); // 与 a 共享前 8 字符 → 同一目录
    saveKeyring(root, ringOf(a, "first"));
    saveKeyring(root, ringOf(b, "second"));
    const loaded = loadKeyring(root, a.slice(0, 8));
    expect(loaded?.alias).toBe("second"); // 后写覆盖
    expect(existsSync(keyringDir(root, a))).toBe(true); // 目录只有一个
  });

  it("forget 整环删除（钥环 + fabric 目录），未知引用报错", () => {
    const ep = endpointId();
    saveKeyring(root, ringOf(ep));
    mkdirSync(fabricDir(root, ep), { recursive: true });
    const removed = removeKeyring(root, ep.slice(0, 8));
    expect(removed.ring.endpointId).toBe(ep);
    expect(existsSync(keyringDir(root, ep))).toBe(false);
    expect(() => removeKeyring(root, ep)).toThrow(CliError);
  });

  it("listKeyrings 跳过损坏目录并告警", () => {
    const ep = endpointId();
    saveKeyring(root, ringOf(ep));
    mkdirSync(join(root, "badbad99"), { recursive: true });
    writeFileSync(join(root, "badbad99", "keyring.json"), "{not json");
    const { rings, warnings } = listKeyrings(root);
    expect(rings).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });
});

describe("setPort / addKeyToRing IO 包装", () => {
  it("setPort 校验服务归属并持久化", () => {
    const ep = endpointId();
    saveKeyring(root, { ...ringOf(ep), services: [service("svc-a", "a", 11434)] });
    const next = setPort(root, ep, "svc-a", 25000);
    expect(next.ports["svc-a"]).toBe(25000);
    expect(() => setPort(root, ep, "svc-nope", 1)).toThrow(CliError);
  });

  it("addKeyToRing 幂等（同 keyId 更新）", () => {
    const ep = endpointId();
    saveKeyring(root, ringOf(ep));
    const a = addKeyToRing(root, ep, { keyId: "kid", key: "sk-aifly-k1", group: "g" });
    expect(a.added).toBe(true);
    const b = addKeyToRing(root, ep, { keyId: "kid", key: "sk-aifly-k2", group: "g" });
    expect(b.added).toBe(false);
    expect(loadKeyring(root, ep)?.keys).toEqual([{ keyId: "kid", key: "sk-aifly-k2", group: "g" }]);
  });
});
