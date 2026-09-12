// 引擎装配单测（FakeFabric 类型桩 + FabricWireAdapter，零原生 SDK）：peer-connected
// 建会话 -> AUTH（AUTH_OK 目录含脱敏 detail）-> REQ 全链路（$env 注入上游）->
// unknown_service 防枚举 -> 并发限额 rate_limited -> ABORT 回 aborted -> 撤钥 refresh
// 剔除 / 全撤断会话（CLI 写盘 + reloadStore 路径）-> AUTH_ERR 断连 -> 横幅空 $env 警告。

import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FRAME_TYPE } from "../../../src/wire/frames.ts";
import type { AuthOkHeader } from "../../../src/wire/frames.ts";
import { FabricWireAdapter } from "../../../src/wire/fabric-adapter.ts";
import { WireSession, type InboundFrame } from "../../../src/wire/mux.ts";
import { ProviderEngine } from "../../../src/provider/engine.ts";
import { ProviderStore } from "../../../src/provider/store.ts";
import { SecretsStore } from "../../../src/provider/secrets.ts";
import { composeStartupBanner, findEmptyEnvRefs } from "../../../src/provider/serve.ts";
import { FakeFabric } from "./fake-fabric.ts";

const ENC = new TextEncoder();
const PROVIDER_EP = "provider-ep-z32-1";
const CONSUMER_EP = "consumer-ep-z32-1";

let dir: string;
let store: ProviderStore;
let serviceId: string;
let keyFriends: { keyId: string; key: string };
let keyMates: { keyId: string; key: string };
let engine: ProviderEngine;
let fabricPair: ReturnType<typeof FakeFabric.pair>;
let consumer: WireSession;
let consumerEvents: InboundFrame[];
let consumerDisconnects: Array<string | undefined>;
let mockServer: Server;
let mockPort: number;
const upstreamBodies: string[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aifly-engine-"));
  // mock 上游
  const handler: RequestListener = (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      upstreamBodies.push(Buffer.concat(chunks).toString());
      if (req.url === "/stall") return; // 永不响应（并发限额用）
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization ?? null }));
    });
  };
  mockServer = createServer(handler);
  await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  mockPort = (mockServer.address() as AddressInfo).port;

  store = ProviderStore.open(dir);
  const svc = store.addService({
    name: "api",
    upstream: `http://127.0.0.1:${mockPort}`,
    match: [{ type: "suffix", value: ".local" }],
    rewrite: { headerSet: { authorization: { hook: "authHeader", args: { var: "TEST_UPSTREAM_KEY" } } } },
  });
  serviceId = svc.serviceId;
  store.addGroup("friends", ["api"], { maxConcurrency: 1 });
  store.addGroup("mates", ["api"]);
  keyFriends = store.issueKey("friends");
  keyMates = store.issueKey("mates");

  fabricPair = FakeFabric.pair(PROVIDER_EP, CONSUMER_EP);
  engine = new ProviderEngine({
    fabric: fabricPair.provider,
    store,
    dataDir: dir,
    opts: {
      env: { TEST_UPSTREAM_KEY: "sk-env-injected" },
      // $secret 解析走真实密钥库（无内存态：测试内 set/remove 即刻生效）。
      secrets: (name) => SecretsStore.open(dir).get(name),
      timeouts: { connectMs: 1_000, firstByteMs: 30_000, stallMs: 30_000, pingMs: 60_000 },
    },
  });
  await engine.start();

  consumerEvents = [];
  consumerDisconnects = [];
  const adapter = new FabricWireAdapter(fabricPair.consumer, PROVIDER_EP);
  consumer = new WireSession({
    role: "consumer",
    transport: adapter,
    hooks: {
      onFrame: (f) => consumerEvents.push(f),
      onDisconnect: (r) => consumerDisconnects.push(r),
    },
  });
});

afterEach(async () => {
  await engine.shutdown();
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor<T>(probe: () => T | undefined, ms = 3_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor: timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function of(type: number, id?: string): InboundFrame[] {
  return consumerEvents.filter(
    (f) => f.type === type && (id === undefined || (f.header as { id?: string }).id === id),
  );
}

function bodyOf(f: InboundFrame): Buffer {
  return Buffer.from((f as { body?: Uint8Array }).body ?? new Uint8Array(0));
}

async function connectAndAuth(keys: string[]): Promise<AuthOkHeader> {
  fabricPair.provider.emit({ type: "peer-connected", endpointId: CONSUMER_EP });
  await consumer.send(FRAME_TYPE.AUTH, { v: 1, keys });
  const frame = await waitFor(() => of(FRAME_TYPE.AUTH_OK)[0]);
  consumer.markAuthed(); // 使用方在收到并接受 AUTH_OK 后置位（§4 同语义）
  return frame.header as unknown as AuthOkHeader;
}

describe("AUTH 与目录", () => {
  it("AUTH_OK：别名/relayUrls/分组视图（含 limits 与脱敏 detail）", async () => {
    const header = await connectAndAuth([keyFriends.key]);
    expect(header.alias).toBe("provider");
    expect(header.relayUrls).toEqual(["http://relay.example.test:8787"]);
    expect(header.groups).toHaveLength(1);
    const group = header.groups[0]!;
    expect(group.group).toBe("friends");
    expect(group.limits).toEqual({ maxConcurrency: 1 });
    expect(group.services[0]?.serviceId).toBe(serviceId);
    const masked = group.services[0]?.detail?.rewrite?.headerSet?.find((h) => h.name === "authorization");
    expect(masked?.value).toBe("\u25cf");
    expect(JSON.stringify(header)).not.toContain("TEST_UPSTREAM_KEY");
    expect(engine.sessionCount()).toBe(1);
  });

  it("全无效 -> AUTH_ERR(key_all_invalid) 即断（引擎侧即刻清理会话）", async () => {
    fabricPair.provider.emit({ type: "peer-connected", endpointId: CONSUMER_EP });
    await consumer.send(FRAME_TYPE.AUTH, { v: 1, keys: ["sk-aifly-totally-wrong"] });
    await waitFor(() => of(FRAME_TYPE.AUTH_ERR)[0]);
    expect((of(FRAME_TYPE.AUTH_ERR)[0]!.header as { code: string }).code).toBe("key_all_invalid");
    // 断连语义：引擎即刻关闭该会话（消费者侧断连感知在真实 fabric 传输层生效）。
    await waitFor(() => (engine.sessionCount() === 0 ? true : undefined));
    expect(engine.sessionCount()).toBe(0);
  });

  it("混合钥 AUTH：rejected 携带 key_invalid", async () => {
    const header = await connectAndAuth([keyFriends.key, "sk-aifly-wrong-key-xyz"]);
    expect(header.groups).toHaveLength(1);
    expect(header.rejected).toEqual([{ code: "key_invalid" }]);
  });
});

describe("REQ 全链路", () => {
  it("授权服务：上游收到重写后请求与 $env 凭据；响应按序回送", async () => {
    await connectAndAuth([keyFriends.key]);
    const body = ENC.encode('{"q":"hi"}');
    await consumer.send(
      FRAME_TYPE.REQ,
      { v: 1, id: "r1", serviceId, method: "POST", path: "/v1/echo", contentType: "application/json", bodyLen: body.length },
      body,
    );
    await waitFor(() => of(FRAME_TYPE.RESP_END, "r1")[0]);
    const meta = of(FRAME_TYPE.RESP_META, "r1")[0]!.header as { status: number; contentType: string };
    expect(meta.status).toBe(200);
    expect(meta.contentType).toBe("application/json");
    const chunks = of(FRAME_TYPE.RESP_CHUNK, "r1");
    const payload = JSON.parse(Buffer.concat(chunks.map((f) => bodyOf(f))).toString()) as { path: string; auth: string | null };
    expect(payload.path).toBe("/v1/echo");
    expect(payload.auth).toBe("sk-env-injected");
    expect(upstreamBodies[0]).toBe('{"q":"hi"}');
  });

  it("未授权/未知 serviceId 统一 unknown_service（防枚举）", async () => {
    await connectAndAuth([keyFriends.key]);
    await consumer.send(FRAME_TYPE.REQ, { v: 1, id: "r2", serviceId: "nope", method: "GET", path: "/x", bodyLen: 0 });
    const err = await waitFor(() => of(FRAME_TYPE.ERROR, "r2")[0]);
    expect((err.header as { code: string }).code).toBe("unknown_service");
    await consumer.send(FRAME_TYPE.REQ, { v: 1, id: "r3", serviceId: "svc-others-group", method: "GET", path: "/x", bodyLen: 0 });
    const err2 = await waitFor(() => of(FRAME_TYPE.ERROR, "r3")[0]);
    expect((err2.header as { code: string }).code).toBe("unknown_service");
  });

  it("并发限额 1：第二在途请求立即 rate_limited；ABORT 释放后恢复受理", async () => {
    await connectAndAuth([keyFriends.key]);
    await consumer.send(FRAME_TYPE.REQ, { v: 1, id: "s1", serviceId, method: "GET", path: "/stall", bodyLen: 0 });
    await waitFor(() => (engine.limits.inflightCount("friends") >= 1 ? true : undefined));
    await consumer.send(FRAME_TYPE.REQ, { v: 1, id: "s2", serviceId, method: "GET", path: "/v1/echo", bodyLen: 0 });
    const err = await waitFor(() => of(FRAME_TYPE.ERROR, "s2")[0]);
    expect((err.header as { code: string }).code).toBe("rate_limited");
    // 中止在途请求 -> 释放并发 -> 新请求可受理
    await consumer.send(FRAME_TYPE.ABORT, { id: "s1" });
    await waitFor(() => of(FRAME_TYPE.ERROR, "s1")[0]);
    expect((of(FRAME_TYPE.ERROR, "s1")[0]!.header as { code: string }).code).toBe("aborted");
    await waitFor(() => (engine.limits.inflightCount("friends") === 0 ? true : undefined));
    await consumer.send(FRAME_TYPE.REQ, { v: 1, id: "s3", serviceId, method: "GET", path: "/v1/echo", bodyLen: 0 });
    await waitFor(() => of(FRAME_TYPE.RESP_END, "s3")[0]);
  });

  it("分片正文（REQ_BODY 续帧）重组后派发", async () => {
    await connectAndAuth([keyMates.key]);
    const part1 = ENC.encode("abcdef");
    await consumer.send(
      FRAME_TYPE.REQ,
      { v: 1, id: "m1", serviceId, method: "POST", path: "/v1/echo", contentType: "text/plain", bodyLen: 10 },
      new Uint8Array(0),
    );
    await consumer.send(FRAME_TYPE.REQ_BODY, { id: "m1", seq: 0, end: false }, part1);
    await consumer.send(FRAME_TYPE.REQ_BODY, { id: "m1", seq: 1, end: true }, ENC.encode("ghij"));
    await waitFor(() => of(FRAME_TYPE.RESP_END, "m1")[0]);
    expect(upstreamBodies[upstreamBodies.length - 1]).toBe("abcdefghij");
  });

  it("$secret 全链路：命中注入密钥库完整头值；删除后同请求 secret_missing（信息不含名字）", async () => {
    const secrets = SecretsStore.open(dir);
    const secService = store.addService({
      name: "sec-api",
      upstream: `http://127.0.0.1:${mockPort}`,
      match: [{ type: "suffix", value: ".local" }],
      rewrite: { headerSet: { authorization: { hook: "authHeader", args: { name: "test-key" } } } },
    });
    store.addGroup("secret-holders", ["sec-api"]);
    const keySecret = store.issueKey("secret-holders");
    secrets.set("test-key", "Bearer sk-lib-42");

    await connectAndAuth([keySecret.key]);
    await consumer.send(
      FRAME_TYPE.REQ,
      { v: 1, id: "sec1", serviceId: secService.serviceId, method: "GET", path: "/v1/echo", bodyLen: 0 },
    );
    await waitFor(() => of(FRAME_TYPE.RESP_END, "sec1")[0]);
    const chunks = of(FRAME_TYPE.RESP_CHUNK, "sec1");
    const payload = JSON.parse(Buffer.concat(chunks.map((f) => bodyOf(f))).toString()) as {
      auth: string | null;
    };
    expect(payload.auth).toBe("Bearer sk-lib-42");

    // 删除密钥 -> 同一服务的后续请求被拒（不回退空值、名字不出网）。
    secrets.remove("test-key");
    await consumer.send(
      FRAME_TYPE.REQ,
      { v: 1, id: "sec2", serviceId: secService.serviceId, method: "GET", path: "/v1/echo", bodyLen: 0 },
    );
    const err = await waitFor(() => of(FRAME_TYPE.ERROR, "sec2")[0]);
    const header = err.header as { code: string; message: string };
    expect(header.code).toBe("secret_missing");
    expect(JSON.stringify(header)).not.toContain("test-key");
    expect(JSON.stringify(header)).not.toContain("sk-lib-42");
  });
});

describe("撤钥与目录刷新（CLI 写盘 -> reloadStore）", () => {
  it("双钥在线撤一钥：refresh AUTH_OK 剔除被撤组，会话不断", async () => {
    await connectAndAuth([keyFriends.key, keyMates.key]);
    expect(of(FRAME_TYPE.AUTH_OK)).toHaveLength(1);
    // 另一进程（CLI）写盘
    const cliStore = ProviderStore.open(dir);
    cliStore.revokeKey(keyFriends.keyId);
    await engine.reloadStore();
    await waitFor(() => (of(FRAME_TYPE.AUTH_OK).length >= 2 ? true : undefined));
    const refresh = of(FRAME_TYPE.AUTH_OK)[1]!.header as AuthOkHeader;
    expect(refresh.refresh).toBe(true);
    expect(refresh.groups.map((g) => g.group)).toEqual(["mates"]); // friends 剔除
    expect(consumerDisconnects).toEqual([]);
    // 被撤服务仍可经余钥组访问
    await consumer.send(FRAME_TYPE.REQ, { v: 1, id: "x1", serviceId, method: "GET", path: "/v1/echo", bodyLen: 0 });
    await waitFor(() => of(FRAME_TYPE.RESP_END, "x1")[0]);
  });

  it("仅剩钥也被撤：引擎断开会话（无余钥语义）", async () => {
    await connectAndAuth([keyFriends.key]);
    const cliStore = ProviderStore.open(dir);
    cliStore.revokeKey(keyFriends.keyId);
    await engine.reloadStore();
    await waitFor(() => (engine.sessionCount() === 0 ? true : undefined));
    expect(engine.sessionCount()).toBe(0);
  });

  it("服务变更推送：向组新增服务进入 refresh 视图（全量替换语义）", async () => {
    await connectAndAuth([keyMates.key]);
    const first = of(FRAME_TYPE.AUTH_OK)[0]!.header as AuthOkHeader;
    expect(first.groups[0]!.services).toHaveLength(1);
    const cliStore = ProviderStore.open(dir);
    const svc2 = cliStore.addService({
      name: "extra",
      upstream: `http://127.0.0.1:${mockPort}`,
      match: [{ type: "exact", value: "extra.local" }],
    });
    cliStore.setGroupServices("mates", ["api", "extra"]);
    await engine.reloadStore();
    await waitFor(() => (of(FRAME_TYPE.AUTH_OK).length >= 2 ? true : undefined));
    const refresh = of(FRAME_TYPE.AUTH_OK)[1]!.header as AuthOkHeader;
    expect(refresh.refresh).toBe(true);
    expect(refresh.groups[0]!.services.map((s) => s.serviceId).sort()).toEqual(
      [serviceId, svc2.serviceId].sort(),
    );
  });
});

describe("横幅与空 $env 警告（纯函数）", () => {
  it("findEmptyEnvRefs：已声明但空/未设置的变量被点名；已设置不警告", () => {
    const services = [
      {
        ...store.getService(serviceId)!,
        rewrite: { headerSet: { a: { hook: "authHeader", args: { var: "SET_VAR" } }, b: { hook: "authHeader", args: { var: "EMPTY_VAR" } }, c: { hook: "authHeader", args: { var: "UNSET_VAR" } } } },
      },
    ];
    const refs = findEmptyEnvRefs(services, { SET_VAR: "x", EMPTY_VAR: "" });
    expect(refs).toEqual([{ service: "api", vars: ["EMPTY_VAR", "UNSET_VAR"] }]);
  });

  it("composeStartupBanner：英文 ASCII + 关键字段 + WARNING 行", () => {
    const banner = composeStartupBanner({
      endpointId: "ep-1",
      fabricIdHex: "abcd",
      dataDir: "/tmp/x",
      alias: "box",
      serviceCount: 2,
      groupCount: 1,
      activeKeyCount: 3,
      revokedKeyCount: 1,
      relayMode: "custom",
      relayUrls: ["http://relay:8787"],
      emptyEnvRefs: [{ service: "api", vars: ["MY_KEY"] }],
    });
    expect(banner).toContain("EndpointId : ep-1");
    expect(banner).toContain("FabricId   : abcd");
    expect(banner).toContain("Services   : 2");
    expect(banner).toContain("WARNING: $env variable 'MY_KEY' referenced by service 'api' is empty or unset");
    for (const ch of banner) expect(ch.codePointAt(0)!).toBeLessThan(128);
  });
});
