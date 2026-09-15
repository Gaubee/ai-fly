// SecretsStore 单测（m3 SECRETS 4.1）：往返（set/get/list/remove + 重开恢复）、
// 值只落密钥库文件（0600）且 list 投影无值、目录 0700、原子写无 tmp 残留、
// 名称/值校验、未知名 remove -> not-found、损坏文件 -> corrupt、跨实例写读一致
// （无内存态：RPC 实例写、daemon 实例读即刻可见）。

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretsStore } from "../../../src/provider/secrets.ts";
import { StoreError } from "../../../src/provider/store.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aifly-secrets-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SecretsStore 往返", () => {
  it("set → get/list → remove → 空；list 只含名称与时间戳", () => {
    const store = SecretsStore.open(dir);
    const first = store.set("openai", "Bearer sk-1");
    expect(first).toMatchObject({ name: "openai" });
    expect(first.createdAt).toBeGreaterThan(0);

    store.set("anthropic.main", "sk-ant-2");
    const listed = store.list();
    expect(listed.map((s) => s.name)).toEqual(["anthropic.main", "openai"]);
    expect(JSON.stringify(listed)).not.toContain("sk-1");
    expect(JSON.stringify(listed)).not.toContain("sk-ant-2");

    expect(store.get("openai")).toBe("Bearer sk-1");
    expect(store.get("nope")).toBeUndefined();

    store.remove("openai");
    expect(store.list().map((s) => s.name)).toEqual(["anthropic.main"]);
    expect(store.get("openai")).toBeUndefined();
  });

  it("覆写保留 createdAt、更新 updatedAt", async () => {
    const store = SecretsStore.open(dir);
    const a = store.set("k", "v1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = store.set("k", "v2");
    expect(b.createdAt).toBe(a.createdAt);
    expect(b.updatedAt).toBeGreaterThanOrEqual(a.updatedAt);
    expect(store.get("k")).toBe("v2");
    expect(store.list()).toHaveLength(1);
  });

  it("重开恢复（无内存态；另一实例写入即刻可见）", () => {
    const writer = SecretsStore.open(dir);
    writer.set("openai", "Bearer sk-1");
    const reader = SecretsStore.open(dir);
    expect(reader.get("openai")).toBe("Bearer sk-1");
    // 跨实例写读一致：daemon 读实例看到 RPC 写实例的新增/删除。
    writer.set("later", "v");
    expect(reader.get("later")).toBe("v");
    writer.remove("later");
    expect(reader.get("later")).toBeUndefined();
  });

  it("remove 未知名 -> StoreError(not-found)", () => {
    const store = SecretsStore.open(dir);
    expect(() => store.remove("ghost")).toThrow(StoreError);
    try {
      store.remove("ghost");
      expect.unreachable();
    } catch (err) {
      expect((err as StoreError).code).toBe("not-found");
    }
  });

  it("名称与值校验 -> StoreError(invalid)", () => {
    const store = SecretsStore.open(dir);
    for (const bad of ["", "UPPER", "1 space", "中文", "-lead"]) {
      expect(() => store.set(bad, "v"), `name: ${JSON.stringify(bad)}`).toThrow(StoreError);
    }
    expect(() => store.set("ok", "")).toThrow(StoreError);
    expect(() => store.set("ok", "x".repeat(8193))).toThrow(StoreError);
    // 边界合法形态
    expect(() => store.set("a1._-ok", "Bearer x")).not.toThrow();
  });
});

describe("SecretsStore 持久化形态", () => {
  it("文件 0600、目录 0700、内容为 v1 声明格式", () => {
    const store = SecretsStore.open(dir);
    store.set("openai", "Bearer sk-1");
    const path = SecretsStore.filePath(dir);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
      secrets: Record<string, { value: string; createdAt: number; updatedAt: number }>;
    };
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.secrets)).toEqual(["openai"]);
    expect(parsed.secrets.openai!.value).toBe("Bearer sk-1");
  });

  it("原子写：无 tmp 残留", () => {
    const store = SecretsStore.open(dir);
    store.set("a", "1");
    store.set("b", "2");
    store.remove("a");
    const names = readdirSync(dir).filter((n) => n.startsWith("secrets.json"));
    expect(names).toEqual(["secrets.json"]);
  });

  it("损坏文件 -> StoreError(corrupt)；损坏不破坏既有错误码语义", () => {
    SecretsStore.open(dir).set("a", "1");
    const path = SecretsStore.filePath(dir);
    writeFileSync(path, "{ not json", { mode: 0o600 });
    const store = SecretsStore.open(dir);
    for (const op of [
      () => store.list(),
      () => store.get("a"),
      () => store.set("b", "2"),
      () => store.remove("a"),
    ]) {
      try {
        op();
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(StoreError);
        expect((err as StoreError).code).toBe("corrupt");
      }
    }
  });

  it("文件缺失 = 空库（不落盘直到首次写）", () => {
    const store = SecretsStore.open(dir);
    expect(store.list()).toEqual([]);
    expect(existsSync(SecretsStore.filePath(dir))).toBe(false);
  });

  it("bearerPrefix 退役（hooks-lifecycle 5.2）：值为原样存储，resolve 不做前缀加工", () => {
    const store = SecretsStore.open(dir);
    store.set("std", "sk-1");
    store.set("prefilled", "Bearer sk-3");
    // 原样语义：裸 key 与完整头值都按存储值返回——Bearer 前缀由服务 auth 槽拼。
    expect(store.resolve("std")).toEqual({ headerValue: "sk-1" });
    expect(store.get("std")).toBe("sk-1");
    expect(store.resolve("prefilled")).toEqual({ headerValue: "Bearer sk-3" });
    // 清单不再携带 bearerPrefix 字段。
    const listed = store.list();
    expect(listed.find((s) => s.name === "std")).toMatchObject({ name: "std" });
    expect(Object.keys(listed[0]!)).toEqual(["name", "createdAt", "updatedAt"]);
  });

  it("旧文件含 bearerPrefix 字段 -> 加载剥离（zod strip 语义）；下次写入落成新形状", () => {
    writeFileSync(
      SecretsStore.filePath(dir),
      JSON.stringify({
        version: 1,
        secrets: {
          legacy: { value: "sk-old", createdAt: 1, updatedAt: 1, bearerPrefix: false },
          raw: { value: "sk-raw", createdAt: 1, updatedAt: 1, bearerPrefix: true },
        },
      }),
    );
    const store = SecretsStore.open(dir);
    // 读入即剥离：resolve 原样、list 无 bearerPrefix。
    expect(store.resolve("legacy")).toEqual({ headerValue: "sk-old" });
    expect(store.resolve("raw")).toEqual({ headerValue: "sk-raw" });
    expect(JSON.stringify(store.list())).not.toContain("bearerPrefix");
    // 触发一次写（覆写）后文件不再含该字段。
    store.set("legacy", "sk-new");
    const onDisk = readFileSync(SecretsStore.filePath(dir), "utf8");
    expect(onDisk).not.toContain("bearerPrefix");
    expect(JSON.parse(onDisk).secrets.legacy).toEqual({ value: "sk-new", createdAt: 1, updatedAt: expect.any(Number) });
  });
});
