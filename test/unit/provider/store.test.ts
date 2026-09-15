// ProviderStore 单测：services.json 往返（重启恢复）、密钥哈希不可逆（原文不落盘、
// 常数时间校验可复验）、defaultPort 规则（<1024 强制显式）、危险/非法正则拒绝、
// CRUD 与加载校验（zod）。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderStore, StoreError } from "../../../src/provider/store.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aifly-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedBasic(): { store: ProviderStore; serviceId: string; keyId: string; key: string } {
  const store = ProviderStore.open(dir);
  const svc = store.addService({
    name: "ollama",
    upstream: "http://127.0.0.1:11434",
    match: [{ type: "suffix", value: ".local" }],
    // hooks-lifecycle v2：头改写落 headers 槽（$env 间接引用 + 字面量 + remove）。
    headers: {
      set: { authorization: "$env:UPSTREAM_KEY", "x-literal": "abc" },
      remove: ["x-drop"],
    },
  });
  store.addGroup("friends", ["ollama"]);
  const issued = store.issueKey("friends");
  return { store, serviceId: svc.serviceId, keyId: issued.keyId, key: issued.key };
}

describe("ProviderStore 服务/分组/密钥往返", () => {
  it("添加后重启进程完整恢复（服务/分组/密钥；v2 version 标记）", () => {
    const seeded = seedBasic();
    const reopened = ProviderStore.open(dir);
    const svc = reopened.getService(seeded.serviceId);
    expect(svc?.name).toBe("ollama");
    expect(svc?.upstream).toBe("http://127.0.0.1:11434/");
    expect(svc?.defaultPort).toBe(11434);
    expect(svc?.headers?.set).toEqual({ authorization: "$env:UPSTREAM_KEY", "x-literal": "abc" });
    expect(svc?.headers?.remove).toEqual(["x-drop"]);
    expect(reopened.legacy).toBeNull();
    // 文件带 version: 2（版本门禁判据）
    const raw = JSON.parse(readFileSync(ProviderStore.filePath(dir), "utf8")) as { version?: number };
    expect(raw.version).toBe(2);
    const group = reopened.getGroup("friends");
    expect(group?.serviceIds).toEqual([seeded.serviceId]);
    // 密钥记录存在（哈希），且校验仍通过
    expect(reopened.listKeys()).toHaveLength(1);
    expect(reopened.verifyKey(seeded.key)).toMatchObject({ status: "valid", keyId: seeded.keyId, group: "friends" });
  });

  it("生命周期四槽 v2 往返（auth 三族 / headers / request / response）", () => {
    const store = ProviderStore.open(dir);
    const svc = store.addService({
      name: "slots",
      upstream: "https://api.example.com",
      match: [{ type: "suffix", value: "api.example.com" }],
      defaultPort: 8443,
      auth: { secret: "openai-main", bearer: false },
      headers: {
        remove: ["X-Drop", "x-drop"],
        set: { "X-Custom": "literal", authorization: "$secret:openai-main" },
        script: { name: "hdr", args: { mode: "strict" } },
      },
      request: { script: "relay", args: { base: "http://x" } },
      response: { script: "transform" },
      rewrite: { host: "internal.alias", pathPrefixStrip: "/a" },
    });
    const reopened = ProviderStore.open(dir);
    const restored = reopened.getService(svc.serviceId);
    expect(restored?.auth).toEqual({ secret: "openai-main", bearer: false });
    expect(restored?.headers).toEqual({
      remove: ["x-drop"],
      set: { "x-custom": "literal", authorization: "$secret:openai-main" },
      script: { name: "hdr", args: { mode: "strict" } },
    });
    expect(restored?.request).toEqual({ script: "relay", args: { base: "http://x" } });
    expect(restored?.response).toEqual({ script: "transform" });
    expect(restored?.rewrite).toEqual({ host: "internal.alias", pathPrefixStrip: "/a" });
  });

  it("四槽非法形状拒绝（store invalid）", () => {
    const store = ProviderStore.open(dir);
    expect(() =>
      store.addService({
        name: "bad-auth",
        upstream: "http://127.0.0.1:9000",
        match: [{ type: "exact", value: "a" }],
        // 非法 auth 槽（双族并存；zod strict union 拒绝）
        auth: { secret: "a", script: "b" },
      }),
    ).toThrow(StoreError);
    expect(() =>
      store.addService({
        name: "bad-headers",
        upstream: "http://127.0.0.1:9000",
        match: [{ type: "exact", value: "a" }],
        // @ts-expect-error set 值非 string
        headers: { set: { a: 123 } },
      }),
    ).toThrow(StoreError);
    expect(() =>
      store.addService({
        name: "bad-script",
        upstream: "http://127.0.0.1:9000",
        match: [{ type: "exact", value: "a" }],
        // @ts-expect-error request 槽缺 script 名
        request: {},
      }),
    ).toThrow(StoreError);
  });

  it("key 原文随库可复制（Owner 裁决 2026-09-13：随时可取，取代旧不可逆语义）", () => {
    const seeded = seedBasic();
    const raw = readFileSync(ProviderStore.filePath(dir), "utf8");
    expect(raw).toContain(seeded.key); // 原文落库（本机个人工具，与密钥库明文同威胁模型）
    expect(raw).toMatch(/"hash": "[0-9a-f]{64}"/); // 哈希仍在（验证面不变）
    const listed = seeded.store.listKeys();
    for (const k of listed) {
      expect(k.key).toBe(seeded.key);
      expect(k.name).toBe("default");
    }
    expect(seeded.store.getKeyMaterial(listed[0]!.keyId)).toBe(seeded.key);
    // 错误原文 -> invalid（验证不受原文落库影响）
    expect(seeded.store.verifyKey("sk-aifly-wrongwrongwrongwrongwrongwrongwrong")).toEqual({ status: "invalid" });
  });

  it("密钥格式：sk-aifly- 前缀 + 52 字符 z32 体", () => {
    const store = ProviderStore.open(dir);
    store.addService({ name: "s", upstream: "http://127.0.0.1:9000", match: [{ type: "exact", value: "a.local" }] });
    store.addGroup("g", ["s"]);
    const { key } = store.issueKey("g");
    expect(key).toMatch(/^sk-aifly-[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/);
  });

  it("撤钥即刻生效：verifyKey -> revoked；再次 revoke 幂等", () => {
    const seeded = seedBasic();
    seeded.store.revokeKey(seeded.keyId);
    expect(seeded.store.verifyKey(seeded.key)).toMatchObject({ status: "revoked" });
    const again = seeded.store.revokeKey(seeded.keyId);
    expect(again.revokedAt).toBeTypeOf("number");
    expect(() => seeded.store.revokeKey("nope")).toThrow(StoreError);
  });

  it("重开进程后撤销状态保留", () => {
    const seeded = seedBasic();
    seeded.store.revokeKey(seeded.keyId);
    expect(ProviderStore.open(dir).verifyKey(seeded.key)).toMatchObject({ status: "revoked" });
  });
});

describe("defaultPort 规则（上游端口 <1024 强制显式）", () => {
  it("https 默认端口 443 未声明 defaultPort -> 拒绝", () => {
    const store = ProviderStore.open(dir);
    expect(() =>
      store.addService({ name: "api", upstream: "https://api.example.com", match: [{ type: "exact", value: "api.example.com" }] }),
    ).toThrow(/privileged/);
  });

  it("显式 defaultPort 后接受", () => {
    const store = ProviderStore.open(dir);
    const svc = store.addService({
      name: "api",
      upstream: "https://api.example.com",
      match: [{ type: "exact", value: "api.example.com" }],
      defaultPort: 8443,
    });
    expect(svc.defaultPort).toBe(8443);
  });

  it("http 80 端口同样强制显式；高位端口缺省继承", () => {
    const store = ProviderStore.open(dir);
    expect(() =>
      store.addService({ name: "web", upstream: "http://example.com", match: [{ type: "exact", value: "example.com" }] }),
    ).toThrow(/privileged/);
    const high = store.addService({
      name: "hi",
      upstream: "http://127.0.0.1:11434",
      match: [{ type: "suffix", value: ".local" }],
    });
    expect(high.defaultPort).toBe(11434);
  });
});

describe("正则保存期编译检查", () => {
  it("语法非法正则被拒且既有服务不受影响", () => {
    const store = ProviderStore.open(dir);
    store.addService({ name: "ok", upstream: "http://127.0.0.1:9000", match: [{ type: "exact", value: "x" }] });
    expect(() =>
      store.addService({ name: "bad", upstream: "http://127.0.0.1:9001", match: [{ type: "regex", value: "[unclosed" }] }),
    ).toThrow(/invalid regex/);
    expect(store.getServiceByName("ok")).toBeDefined();
    expect(store.getServiceByName("bad")).toBeUndefined();
  });

  it("语法合法的灾难性正则接受（match 无执行面，无 ReDoS 暴露）", () => {
    const store = ProviderStore.open(dir);
    const svc = store.addService({
      name: "cat",
      upstream: "http://127.0.0.1:9002",
      match: [{ type: "regex", value: "(a+)+$" }],
    });
    expect(svc.match[0]?.value).toBe("(a+)+$");
  });
});

describe("CRUD 与加载校验", () => {
  it("重名服务 / 重名分组 / 未知服务引用被拒", () => {
    const store = ProviderStore.open(dir);
    store.addService({ name: "dup", upstream: "http://127.0.0.1:9000", match: [{ type: "exact", value: "d" }] });
    expect(() =>
      store.addService({ name: "dup", upstream: "http://127.0.0.1:9001", match: [{ type: "exact", value: "d" }] }),
    ).toThrow(StoreError);
    store.addGroup("g", ["dup"]);
    expect(() => store.addGroup("g", [])).toThrow(StoreError);
    expect(() => store.addGroup("h", ["nope"])).toThrow(StoreError);
  });

  it("removeService 同步清出分组引用", () => {
    const seeded = seedBasic();
    seeded.store.removeService("ollama");
    const reopened = ProviderStore.open(dir);
    expect(reopened.getGroup("friends")?.serviceIds).toEqual([]);
    expect(reopened.listServices()).toHaveLength(0);
  });

  it("损坏文件（非法 JSON / schema 不符）-> StoreError(corrupt)", () => {
    seedBasic();
    writeFileSync(ProviderStore.filePath(dir), "{ not json", { mode: 0o600 });
    expect(() => ProviderStore.open(dir)).toThrow(StoreError);
    writeFileSync(ProviderStore.filePath(dir), JSON.stringify({ revision: 1, services: "nope" }), { mode: 0o600 });
    expect(() => ProviderStore.open(dir)).toThrow(StoreError);
  });

  it("upstream 校验：非 http(s) scheme / userinfo / query 被拒", () => {
    const store = ProviderStore.open(dir);
    for (const bad of ["ftp://x", "http://u:p@host", "http://host/?q=1", "http://host/#f"]) {
      expect(() =>
        store.addService({ name: `svc-${bad}`, upstream: bad, match: [{ type: "exact", value: "x" }] }),
      ).toThrow(StoreError);
    }
  });

  it("alias 持久化", () => {
    const store = ProviderStore.open(dir);
    store.setAlias("my-box");
    expect(ProviderStore.open(dir).alias).toBe("my-box");
  });

describe("服务停用开关（service-lifecycle）", () => {
  it("setServiceEnabled：落盘、幂等、未知服务报错；旧文件缺省 enabled=true", () => {
    const { store, serviceId } = seedBasic();
    expect(store.getService(serviceId)?.enabled).toBe(true);

    expect(store.setServiceEnabled(serviceId, false).changed).toBe(true);
    expect(store.getService(serviceId)?.enabled).toBe(false);
    // 幂等
    expect(store.setServiceEnabled(serviceId, false).changed).toBe(false);
    // 重启往返（落盘持久）
    const reopened = ProviderStore.open(dir);
    expect(reopened.getService(serviceId)?.enabled).toBe(false);
    expect(reopened.setServiceEnabled(serviceId, true).changed).toBe(true);

    try {
      store.setServiceEnabled("no-such", false);
      expect.unreachable();
    } catch (err) {
      expect((err as StoreError).code).toBe("not-found");
    }
  });

  it("groupServices 排除停用服务（目录/分享链接视图传导）", () => {
    const store = ProviderStore.open(dir);
    const a = store.addService({ name: "a", upstream: "http://127.0.0.1:9001", match: [{ type: "suffix", value: ".a.test" }] });
    store.addService({ name: "b", upstream: "http://127.0.0.1:9002", match: [{ type: "suffix", value: ".b.test" }] });
    store.addGroup("g", ["a", "b"]);
    expect(store.groupServices("g").map((s) => s.name).sort()).toEqual(["a", "b"]);

    store.setServiceEnabled(a.serviceId, false);
    expect(store.groupServices("g").map((s) => s.name)).toEqual(["b"]);

    store.setServiceEnabled(a.serviceId, true);
    expect(store.groupServices("g").map((s) => s.name).sort()).toEqual(["a", "b"]);
  });

  it("addService 尊重 enabled 输入（编辑重建保留停用态）", () => {
    const store = ProviderStore.open(dir);
    const a = store.addService({ name: "paused", upstream: "http://127.0.0.1:9010", match: [{ type: "suffix", value: ".p.test" }], enabled: false });
    expect(a.enabled).toBe(false);
    expect(store.getService(a.serviceId)?.enabled).toBe(false);
  });

  it("旧版 services.json（无 version 字段）进入 legacy 模式而非加载（详细矩阵见 store-legacy.test.ts）", () => {
    const legacy = {
      revision: 1,
      services: [
        { serviceId: "legacy1", name: "old", match: [{ type: "suffix", value: ".old.test" }], upstream: "http://127.0.0.1:9003", defaultPort: 29003 },
      ],
      groups: [],
      keys: [],
    };
    writeFileSync(join(dir, "services.json"), JSON.stringify(legacy));
    const store = ProviderStore.open(dir);
    // 空视图 + legacy 元数据（enabled 缺省语义随 v1 加载路径一并退役）。
    expect(store.legacy).toEqual({ serviceNames: ["old"] });
    expect(store.getService("legacy1")).toBeUndefined();
  });
});

describe("分组管理（Owner 2026-09-10：对齐 keys）", () => {
  it("setGroupLimits 更新与清除限额", () => {
    const store = ProviderStore.open(dir);
    store.addService({ name: "s1", upstream: "http://127.0.0.1:1", match: [{ type: "suffix", value: ".a.test" }], defaultPort: 21001 });
    store.addGroup("g", ["s1"], { maxConcurrency: 2 });
    expect(store.setGroupLimits("g", { dailyRequests: 5 }).limits).toEqual({ dailyRequests: 5 });
    expect(store.setGroupLimits("g", undefined).limits).toBeUndefined();
  });

  it("removeGroup：有未撤销密钥拒绝（conflict），撤销后可删", () => {
    const store = ProviderStore.open(dir);
    store.addService({ name: "s1", upstream: "http://127.0.0.1:1", match: [{ type: "suffix", value: ".a.test" }], defaultPort: 21001 });
    store.addGroup("g", ["s1"]);
    store.issueKey("g");
    try {
      store.removeGroup("g");
      expect.unreachable();
    } catch (err) {
      expect((err as StoreError).code).toBe("conflict");
    }
    const key = store.listKeys().find((k) => k.group === "g")!;
    store.revokeKey(key.keyId);
    store.removeGroup("g");
    expect(store.listGroups().find((g) => g.name === "g")).toBeUndefined();
  });
});
});

describe("路由表（M3-r4）", () => {
  it("routes 随服务落库并完整恢复", () => {
    const store = ProviderStore.open(dir);
    store.addService({
      name: "deepseek",
      upstream: "https://api.deepseek.com",
      match: [{ type: "suffix", value: "api.deepseek.com" }],
      defaultPort: 4300,
      routes: [
        { forms: ["openai-chat", "openai-responses"], localPrefix: "/v1", upstreamPrefix: "/v1" },
        { forms: ["anthropic"], localPrefix: "/anthropic", upstreamPrefix: "/anthropic" },
      ],
    });
    const reopened = ProviderStore.open(dir);
    const svc = reopened.listServices().find((s) => s.name === "deepseek");
    expect(svc?.routes).toEqual([
      { forms: ["openai-chat", "openai-responses"], localPrefix: "/v1", upstreamPrefix: "/v1" },
      { forms: ["anthropic"], localPrefix: "/anthropic", upstreamPrefix: "/anthropic" },
    ]);
  });

  it("from/to 规范化：补前导斜杠、剥尾斜杠、localPrefix 缺省按 forms 派生", () => {
    const store = ProviderStore.open(dir);
    const svc = store.addService({
      name: "agg",
      upstream: "https://aiapi.com",
      match: [{ type: "suffix", value: "aiapi.com" }],
      defaultPort: 4300,
      routes: [
        { forms: [], localPrefix: "v1/", upstreamPrefix: "deep/" },
        { forms: ["anthropic"], upstreamPrefix: "/anthropic/" },
        { forms: ["openai-chat"], upstreamPrefix: "/" },
      ],
    });
    expect(svc.routes).toEqual([
      // 通用行（forms 空）：from/to 双侧归一；localPrefix 显式给出时原样规范化
      { forms: [], localPrefix: "/v1", upstreamPrefix: "/deep" },
      // localPrefix 缺省：按首个 form 的规范前缀（anthropic -> /anthropic）
      { forms: ["anthropic"], localPrefix: "/anthropic", upstreamPrefix: "/anthropic" },
      // localPrefix 缺省：openai-chat -> /v1；to 全斜杠归一为根 ""
      { forms: ["openai-chat"], localPrefix: "/v1", upstreamPrefix: "" },
    ]);
  });

  it("空路由表等价于未声明（存 undefined）", () => {
    const store = ProviderStore.open(dir);
    const svc = store.addService({
      name: "noroute",
      upstream: "https://y.test",
      match: [{ type: "suffix", value: "y.test" }],
      defaultPort: 4300,
      routes: [],
    });
    expect(svc.routes).toBeUndefined();
  });
});

describe("pattern 模式路由（M3-r7）", () => {
  it("合法 pattern 行落库并完整恢复", () => {
    const store = ProviderStore.open(dir);
    store.addService({
      name: "pat",
      upstream: "https://agg.test",
      match: [{ type: "suffix", value: "agg.test" }],
      defaultPort: 4300,
      routes: [{ forms: [], mode: "pattern", matchPattern: "/v1/:ver/*", template: "/relay/{+0}" }],
    });
    const reopened = ProviderStore.open(dir);
    const svc = reopened.listServices().find((s) => s.name === "pat");
    expect(svc?.routes).toEqual([{ forms: [], mode: "pattern", matchPattern: "/v1/:ver/*", template: "/relay/{+0}" }]);
  });

  it("非法 URLPattern / 非法模板写入期拒绝（invalid）", () => {
    const store = ProviderStore.open(dir);
    expect(() =>
      store.addService({
        name: "bad1",
        upstream: "https://x.test",
        match: [{ type: "suffix", value: "x.test" }],
        defaultPort: 4300,
        routes: [{ forms: [], mode: "pattern", matchPattern: "([)", template: "/x" }],
      }),
    ).toThrowError(StoreError);
    expect(() =>
      store.addService({
        name: "bad2",
        upstream: "https://x.test",
        match: [{ type: "suffix", value: "x.test" }],
        defaultPort: 4300,
        routes: [{ forms: [], mode: "pattern", matchPattern: "/x", template: "/a/{unclosed" }],
      }),
    ).toThrowError(StoreError);
    expect(() =>
      store.addService({
        name: "bad3",
        upstream: "https://x.test",
        match: [{ type: "suffix", value: "x.test" }],
        defaultPort: 4300,
        routes: [{ forms: [], mode: "pattern", matchPattern: "/x" }],
      }),
    ).toThrowError(StoreError); // pattern 行缺 template
  });
});
