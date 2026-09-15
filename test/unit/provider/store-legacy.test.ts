// ProviderStore legacy（pre-v2）版本门禁单测（hooks-lifecycle 2.2）：
// - 进入：version 缺失 / ≠2（数字 1、字符串 "2"）→ legacy 模式（空视图 +
//   legacy 元数据，不抛错）；非法 JSON / services 非数组 / 顶层非对象维持 corrupt；
// - 按名移除：原始条目过滤原子写回（同名全删、revision+1、meta/alias/未知
//   字段对象级透传、groups/keys 不丢）；
// - 清空重建：原始 services 清空 → 干净 v2 空库（groups/keys 不保留）退出
//   legacy，此后写操作恢复；
// - 写入保护矩阵：服务 add/setEnabled、分组 add/setServices/setLimits/remove、
//   keys.issue/revoke、setAlias 一律 legacy_readonly；removeService 未知名
//   not-found；错误映射 INVALID_STATE（src/app/errors.ts）。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderStore, StoreError, STORE_VERSION } from "../../../src/provider/store.ts";
import { legacyStoreNotice } from "../../../src/provider/serve.ts";
import { toDomainError } from "../../../src/app/errors.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aifly-store-legacy-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** v1 形状文件（无 version；带 meta.alias/groups/keys/未知字段以验透传）。 */
function writeV1File(over: Record<string, unknown> = {}): void {
  const file = {
    revision: 7,
    meta: { alias: "old-box" },
    services: [
      { serviceId: "s1", name: "alpha", upstream: "http://127.0.0.1:9001", defaultPort: 29001 },
      { serviceId: "s2", name: "beta", upstream: "http://127.0.0.1:9002", defaultPort: 29002 },
      { serviceId: "s2b", name: "beta", upstream: "http://127.0.0.1:9012", defaultPort: 29012 },
      { serviceId: "s3", name: "gamma", upstream: "http://127.0.0.1:9003", defaultPort: 29003 },
    ],
    groups: [{ name: "g", serviceIds: ["s1"] }],
    keys: [{ keyId: "k1", group: "g", hash: "a".repeat(64), createdAt: 1 }],
    futureField: { keep: "me" },
    ...over,
  };
  writeFileSync(ProviderStore.filePath(dir), JSON.stringify(file, null, 2));
}

function readFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(ProviderStore.filePath(dir), "utf8")) as Record<string, unknown>;
}

describe("legacy 进入（版本门禁）", () => {
  it("v1 文件（无 version）：空视图 + legacy 名册 + revision 透传；不抛错", () => {
    writeV1File();
    const store = ProviderStore.open(dir);
    expect(store.legacy).toEqual({ serviceNames: ["alpha", "beta", "gamma"] });
    expect(store.listServices()).toEqual([]);
    expect(store.listGroups()).toEqual([]);
    expect(store.listKeys()).toEqual([]);
    expect(store.revision).toBe(7);
    // 空视图上的只读查询照常工作
    expect(store.getServiceByName("alpha")).toBeUndefined();
    expect(store.verifyKey("whatever")).toEqual({ status: "invalid" });
  });

  it("version ≠2（数字 1 / 字符串 \"2\"）同样进入 legacy", () => {
    writeV1File({ version: 1 });
    expect(ProviderStore.open(dir).legacy?.serviceNames).toHaveLength(3);
    writeV1File({ version: "2" });
    expect(ProviderStore.open(dir).legacy?.serviceNames).toHaveLength(3);
  });

  it("version = 2：正常加载（非 legacy）", () => {
    const store = ProviderStore.open(dir);
    store.addService({ name: "fresh", upstream: "http://127.0.0.1:9100", match: [{ type: "exact", value: "f" }] });
    expect(ProviderStore.open(dir).legacy).toBeNull();
    expect(ProviderStore.open(dir).listServices()).toHaveLength(1);
  });

  it("真损坏维持 corrupt：非法 JSON / services 非数组 / 顶层非对象", () => {
    writeFileSync(ProviderStore.filePath(dir), "{ not json");
    expect(() => ProviderStore.open(dir)).toThrow(StoreError);
    writeV1File({ services: "nope" });
    try {
      ProviderStore.open(dir);
      expect.unreachable();
    } catch (err) {
      expect((err as StoreError).code).toBe("corrupt");
    }
    writeFileSync(ProviderStore.filePath(dir), JSON.stringify([1, 2, 3]));
    try {
      ProviderStore.open(dir);
      expect.unreachable();
    } catch (err) {
      expect((err as StoreError).code).toBe("corrupt");
    }
  });

  it("非对象/无名条目不进名册（无法按名匹配的条目在移除写回时保留）", () => {
    writeV1File({ services: ["garbage", { serviceId: "x" }, { serviceId: "y", name: "" }, { serviceId: "z", name: "named" }] });
    const store = ProviderStore.open(dir);
    expect(store.legacy).toEqual({ serviceNames: ["named"] });
    store.removeService("named");
    const file = readFile();
    expect(file.services).toEqual(["garbage", { serviceId: "x" }, { serviceId: "y", name: "" }]);
  });
});

describe("legacy 按名移除（唯一写路径）", () => {
  it("按名移除：同名条目全删、名册刷新、revision+1（watcher 判变）", () => {
    writeV1File();
    const store = ProviderStore.open(dir);
    store.removeService("beta");
    expect(store.legacy).toEqual({ serviceNames: ["alpha", "gamma"] });
    expect(store.revision).toBe(8);
    const file = readFile();
    expect((file.services as Array<{ name: string }>).map((s) => s.name)).toEqual(["alpha", "gamma"]);
    // 重开进程名册一致
    expect(ProviderStore.open(dir).legacy).toEqual({ serviceNames: ["alpha", "gamma"] });
  });

  it("其余字段语义保留：meta/alias/groups/keys/未知字段对象级透传", () => {
    writeV1File();
    const store = ProviderStore.open(dir);
    store.removeService("alpha");
    const file = readFile();
    expect(file.meta).toEqual({ alias: "old-box" });
    expect(file.groups).toEqual([{ name: "g", serviceIds: ["s1"] }]);
    expect(file.keys).toEqual([{ keyId: "k1", group: "g", hash: "a".repeat(64), createdAt: 1 }]);
    expect(file.futureField).toEqual({ keep: "me" });
    expect(file.revision).toBe(8);
  });

  it("未知服务名 → not-found", () => {
    writeV1File();
    const store = ProviderStore.open(dir);
    try {
      store.removeService("nope");
      expect.unreachable();
    } catch (err) {
      expect((err as StoreError).code).toBe("not-found");
    }
  });

  it("清空重建：最后一个名移除 → 干净 v2 空库（groups/keys 不保留，meta 语义保留——tasks 8.2）退出 legacy", () => {
    writeV1File({ services: [{ serviceId: "only", name: "solo", upstream: "http://127.0.0.1:1", defaultPort: 2 }] });
    const store = ProviderStore.open(dir);
    store.removeService("solo");
    expect(store.legacy).toBeNull();
    expect(store.revision).toBe(8);
    expect(readFile()).toEqual({
      version: STORE_VERSION,
      revision: 8,
      meta: { alias: "old-box" },
      services: [],
      groups: [],
      keys: [],
    });
    // 重建产物必须是合法 v2——重新 open 不判 corrupt（meta:null 曾会写出非法形状）
    expect(ProviderStore.open(dir).legacy).toBeNull();
    // 退出 legacy 后写操作恢复
    const added = store.addService({ name: "fresh", upstream: "http://127.0.0.1:9100", match: [{ type: "exact", value: "f" }] });
    expect(added.name).toBe("fresh");
    expect(ProviderStore.open(dir).listServices()).toHaveLength(1);
  });

  it("清空重建：非法 meta（null / 字符串）丢弃，不写进干净 v2", () => {
    for (const bad of [null, "alias"]) {
      writeV1File({ meta: bad, services: [{ serviceId: "only", name: "solo", upstream: "http://127.0.0.1:1", defaultPort: 2 }] });
      const store = ProviderStore.open(dir);
      store.removeService("solo");
      expect(readFile()).toEqual({ version: STORE_VERSION, revision: 8, services: [], groups: [], keys: [] });
      expect(ProviderStore.open(dir).legacy).toBeNull();
    }
  });

  it("空 services 的 v1 文件：open 即重建干净 v2（无死角），合法 meta 保留", () => {
    writeV1File({ services: [] });
    const store = ProviderStore.open(dir);
    expect(store.legacy).toBeNull(); // 不进 legacy——名册为空时无移除退出路径
    expect(readFile()).toEqual({
      version: STORE_VERSION, revision: 8, meta: { alias: "old-box" }, services: [], groups: [], keys: [],
    });
    expect(store.addService({ name: "fresh", upstream: "http://127.0.0.1:9100", match: [{ type: "exact", value: "f" }] }).name).toBe("fresh");
  });
});

describe("legacy 写入保护矩阵（store 单点门禁）", () => {
  it("服务/分组/keys/alias 写方法一律 legacy_readonly", () => {
    writeV1File();
    const store = ProviderStore.open(dir);
    const expectLegacyReadonly = (fn: () => unknown): void => {
      try {
        fn();
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(StoreError);
        expect((err as StoreError).code).toBe("legacy_readonly");
      }
    };
    expectLegacyReadonly(() =>
      store.addService({ name: "new", upstream: "http://127.0.0.1:9100", match: [{ type: "exact", value: "n" }] }),
    );
    expectLegacyReadonly(() => store.setServiceEnabled("s1", false));
    expectLegacyReadonly(() => store.addGroup("g2", []));
    expectLegacyReadonly(() => store.setGroupServices("g", []));
    expectLegacyReadonly(() => store.setGroupLimits("g", { dailyRequests: 5 }));
    expectLegacyReadonly(() => store.removeGroup("g"));
    expectLegacyReadonly(() => store.issueKey("g"));
    expectLegacyReadonly(() => store.revokeKey("k1"));
    expectLegacyReadonly(() => store.setAlias("new-alias"));
    // 文件未被改写（全部拒绝路径零写入）
    expect((readFile() as { revision: number }).revision).toBe(7);
  });

  it("legacy_readonly → RPC INVALID_STATE（errors.ts 映射）", () => {
    writeV1File();
    const store = ProviderStore.open(dir);
    try {
      store.addService({ name: "new", upstream: "http://127.0.0.1:9100", match: [{ type: "exact", value: "n" }] });
      expect.unreachable();
    } catch (err) {
      const mapped = toDomainError(err);
      expect(mapped.code).toBe("INVALID_STATE");
      // 用户面文案可见（提示移除/重建路径）
      expect(mapped.message).toContain("legacy");
    }
  });

  it("serve 启动 NOTICE（纯函数）：点名数据目录、失效数量与移除路径；英文 ASCII", () => {
    const notice = legacyStoreNotice("/tmp/aifly/provider", ["a", "b"]);
    expect(notice).toContain("/tmp/aifly/provider/services.json");
    expect(notice).toContain("legacy (pre-v2)");
    expect(notice).toContain("2 service(s) are inactive");
    expect(notice).toContain("service remove <name>");
    expect(notice).toContain("no automatic migration");
    for (const ch of notice) expect(ch.codePointAt(0)!).toBeLessThan(128);
  });
});
