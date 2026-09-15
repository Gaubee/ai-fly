// consumer/store 单测：钥环合并幂等（重复 keyId 更新/多钥并存/裸密钥占位回填）、
// forget 整环删除、目录全量替换（新增/删除/relay 变更/端口修剪）、setPort、前缀/
// 别名定位、0600/0700 权限与原子写落盘。

import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  setProviderEnabled,
  setServiceEnabled,
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
  return { alias, endpointId: ep, relayUrls: ["http://r1"], keys: [], services: [], ports: {}, actualPorts: {}, disabledServices: [], disabled: false };
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

  it("disabledServices 跨目录同步保留（不复活），目录消失条目修剪", () => {
    const ep = endpointId();
    let ring = ringOf(ep);
    ring.services = [service("svc-a", "a", 1), service("svc-gone", "gone", 2)];
    ring.disabledServices = ["svc-a", "svc-gone"];
    const next = applyCatalog(ring, {
      relayUrls: [],
      // 目录全量替换：svc-a 条目仍在（内容更新）、svc-gone 消失、svc-new 新增
      services: [service("svc-a", "a2", 1), service("svc-new", "new", 3)],
    });
    expect(next.disabledServices).toEqual(["svc-a"]); // 停用记录不被同步复活/清除
    expect(next.services.map((s) => s.serviceId)).toContain("svc-a"); // 条目本身仍随同步更新
  });

  it("mergeImportView 新建骨架携带 disabledServices 空集合", () => {
    const ep = endpointId();
    const { ring } = mergeImportView(
      undefined,
      { alias: "prov", endpointId: ep, relayUrls: [], services: [service("s", "s", 1)] },
      { keyId: "k", key: "sk-aifly-k1", group: "g" },
    );
    expect(ring.disabledServices).toEqual([]);
  });
});

describe("setServiceEnabled（停用/启用写路径）", () => {
  it("stop 落盘、重复 stop 幂等、start 恢复、未知服务报错", () => {
    const ep = endpointId();
    const base = { ...ringOf(ep), services: [service("svc-a", "a", 1)] };
    saveKeyring(root, base);

    const stopped = setServiceEnabled(root, ep, "svc-a", false);
    expect(stopped.changed).toBe(true);
    expect(stopped.ring.disabledServices).toEqual(["svc-a"]);
    expect(loadKeyring(root, ep)?.disabledServices).toEqual(["svc-a"]);

    const again = setServiceEnabled(root, ep, "svc-a", false);
    expect(again.changed).toBe(false); // 幂等，不重复追加

    const started = setServiceEnabled(root, ep, "svc-a", true);
    expect(started.changed).toBe(true);
    expect(started.ring.disabledServices).toEqual([]);
    expect(loadKeyring(root, ep)?.disabledServices).toEqual([]);

    expect(() => setServiceEnabled(root, ep, "svc-unknown", false)).toThrow(CliError);
    expect(() => setServiceEnabled(root, "no-such-provider", "svc-a", false)).toThrow(CliError);
  });
});

describe("setProviderEnabled（环级停用，提供方级）", () => {
  it("落盘、幂等、未知报错；applyCatalog 保留环级开关（目录同步不覆盖）", () => {
    const ep = endpointId();
    let ring = { ...ringOf(ep), services: [service("svc-a", "a", 1), service("svc-b", "b", 2)] };
    ring.disabledServices = ["svc-b"];
    saveKeyring(root, ring);

    const stopped = setProviderEnabled(root, ep, false);
    expect(stopped.changed).toBe(true);
    expect(stopped.ring.disabled).toBe(true);
    expect(stopped.ring.disabledServices).toEqual(["svc-b"]); // 单服务停用保持（叠加语义）
    expect(loadKeyring(root, ep)?.disabled).toBe(true);

    const again = setProviderEnabled(root, ep, false);
    expect(again.changed).toBe(false);

    // 目录全量替换（AUTH_OK）不覆盖环级开关
    const synced = applyCatalog(loadKeyring(root, ep)!, { relayUrls: [], services: [service("svc-a", "a2", 1), service("svc-b", "b2", 2)] });
    expect(synced.disabled).toBe(true);
    expect(synced.disabledServices).toEqual(["svc-b"]); // 单服务停用集合原样保留（均存活）

    const started = setProviderEnabled(root, ep, true);
    expect(started.changed).toBe(true);
    expect(started.ring.disabled).toBe(false);
    expect(started.ring.disabledServices).toEqual(["svc-b"]); // 环恢复不触碰单服务停用（叠加）
    expect(loadKeyring(root, ep)?.disabled).toBe(false);

    expect(() => setProviderEnabled(root, "no-such-provider", false)).toThrow(CliError);
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

describe("陈旧服务条目逐条过滤（hooks-lifecycle v2 自愈）", () => {
  const v2Entry = (serviceId: string, port: number) => ({
    serviceId,
    name: serviceId,
    match: [{ type: "suffix", value: ".local" }],
    defaultPort: port,
  });
  /** v1 时期形状：顶层 hooks + detail.rewrite.headerSet（v2 均退役）。 */
  const v1Entry = (serviceId: string) => ({
    serviceId,
    name: serviceId,
    match: [{ type: "suffix", value: ".local" }],
    defaultPort: 11434,
    hooks: "env",
    detail: { upstream: "https://u.example", match: [], rewrite: { headerSet: [{ name: "authorization", value: "\u25cf" }] } },
  });

  function writeRawKeyring(ep: string, services: unknown[]): void {
    const dir = keyringDir(root, ep);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "keyring.json"),
      JSON.stringify({
        alias: "prov",
        endpointId: ep,
        relayUrls: ["http://r1"],
        keys: [{ keyId: "kid", key: "sk-aifly-keep-me-000001", group: "g" }],
        services,
        ports: {},
        disabledServices: [],
        disabled: false,
      }),
    );
  }

  function rawServices(ep: string): Array<{ serviceId: string }> {
    const p = join(keyringDir(root, ep), "keyring.json");
    return (JSON.parse(readFileSync(p, "utf8")) as { services: Array<{ serviceId: string }> }).services;
  }

  it("部分坏：陈旧条目丢弃、合法条目/密钥/记录保留、原子写回清理文件", () => {
    const ep = endpointId();
    writeRawKeyring(ep, [v2Entry("svc-good", 11434), v1Entry("svc-old")]);
    const ring = loadKeyring(root, ep)!;
    expect(ring.services.map((s) => s.serviceId)).toEqual(["svc-good"]);
    expect(ring.keys).toEqual([{ keyId: "kid", key: "sk-aifly-keep-me-000001", group: "g" }]);
    expect(ring.endpointId).toBe(ep); // 提供者记录保留
    expect(rawServices(ep).map((s) => s.serviceId)).toEqual(["svc-good"]); // 写回清理
    expect(loadKeyring(root, ep)!.services).toHaveLength(1); // 幂等（无残留 tmp）
    expect(readdirSync(keyringDir(root, ep)).filter((f) => f.startsWith(".keyring"))).toEqual([]);
  });

  it("全坏：服务视图清空，提供者记录与密钥保留", () => {
    const ep = endpointId();
    writeRawKeyring(ep, [v1Entry("a"), v1Entry("b")]);
    const ring = loadKeyring(root, ep)!;
    expect(ring.services).toEqual([]);
    expect(ring.keys).toHaveLength(1);
    expect(rawServices(ep)).toEqual([]);
  });

  it("写回失败（目录只读）：仅日志、不阻断内存视图", () => {
    const ep = endpointId();
    writeRawKeyring(ep, [v1Entry("a")]);
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    chmodSync(keyringDir(root, ep), 0o500);
    try {
      const ring = loadKeyring(root, ep)!; // 不抛
      expect(ring.services).toEqual([]);
      expect(ring.keys).toHaveLength(1);
    } finally {
      chmodSync(keyringDir(root, ep), 0o700);
      spy.mockRestore();
    }
    expect(errors.length).toBeGreaterThan(0); // 有日志证据
  });

  it("文件级 JSON 非法维持既有语义（定位跳过损坏目录、listKeyrings 告警，不进入过滤路径）", () => {
    const ep = endpointId();
    mkdirSync(keyringDir(root, ep), { recursive: true });
    writeFileSync(join(keyringDir(root, ep), "keyring.json"), "{not json");
    expect(loadKeyring(root, ep)).toBeUndefined(); // findKeyringDir 跳过损坏目录（既有语义）
    const { rings, warnings } = listKeyrings(root);
    expect(rings).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });

  it("services 非数组维持整体校验失败语义（定位跳过 + listKeyrings 告警）", () => {
    const ep = endpointId();
    mkdirSync(keyringDir(root, ep), { recursive: true });
    writeFileSync(
      join(keyringDir(root, ep), "keyring.json"),
      JSON.stringify({ alias: "prov", endpointId: ep, relayUrls: [], keys: [], services: { a: 1 }, ports: {} }),
    );
    expect(loadKeyring(root, ep)).toBeUndefined();
    const { warnings } = listKeyrings(root);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("failed validation");
  });

  it("下轮目录同步全量重建（applyCatalog 覆盖被丢弃视图）", () => {
    const ep = endpointId();
    writeRawKeyring(ep, [v1Entry("a")]);
    const ring = loadKeyring(root, ep)!;
    expect(ring.services).toEqual([]);
    const rebuilt = applyCatalog(ring, { relayUrls: ["http://fresh"], services: [service("svc-new", "new", 1)] });
    expect(rebuilt.services.map((s) => s.serviceId)).toEqual(["svc-new"]);
    expect(rebuilt.relayUrls).toEqual(["http://fresh"]);
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
