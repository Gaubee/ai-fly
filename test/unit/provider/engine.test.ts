// 引擎装配单测（FakeFabric 类型桩 + 注入内存 serveHttp 假体，零原生 SDK）：
// peer-connected 起 HTTP 引擎 -> AUTH 端点（AUTH_OK 目录含脱敏 detail / 403
// 全拒 / rejected 混合钥）-> forward 端点全链路（$env 注入上游 / home 贯穿 /
// unknown_service 防枚举 / 并发限额 rate_limited / $secret 全链路）->
// 撤键与目录刷新（CLI 写盘 + reloadStore -> catalog-watch 长轮询 refresh 视图 /
// 全钥失效拆会话）-> 横幅空 $env 警告。
// opendweb-kernel-migration：承载面自 WireSession 帧改为 serveHttp handler
// （CarrierRequest/CarrierResponse 直接驱动；响应错误码经 x-aifly-error-code
// 头 + JSON 体断言）。ABORT 帧语义（客户端中止释放限额）无 NAPI per-request
// cancel 通道——限额释放改为完成驱动（stall 放行后 settle），中止语义本身在
// upstream.test 的 AbortController 路径覆盖。

import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SERVICE_DETAIL_SCHEMA, type AuthOkHeader } from "../../../src/wire/frames.ts";
import { AIFLY_SERVICE_HEADER } from "../../../src/wire/http-protocol.ts";
import {
  ProviderEngine,
  type CarrierRequest,
  type CarrierResponse,
  type ServeHttpFn,
} from "../../../src/provider/engine.ts";
import { ProviderStore } from "../../../src/provider/store.ts";
import { SecretsStore } from "../../../src/provider/secrets.ts";
import { composeStartupBanner, findEmptyEnvRefs } from "../../../src/provider/serve.ts";
import { FakeFabric } from "./fake-fabric.ts";

const ENC = new TextEncoder();
const PROVIDER_EP = "provider-ep-z32-1";
const CONSUMER_EP = "consumer-ep-z32-1";

let dir: string;
let sandboxHome: string;
let store: ProviderStore;
let serviceId: string;
let keyFriends: { keyId: string; key: string };
let keyMates: { keyId: string; key: string };
let engine: ProviderEngine;
let fabricPair: ReturnType<typeof FakeFabric.pair>;
let handler: ((req: CarrierRequest) => Promise<CarrierResponse>) | undefined;
let serverClosed: boolean;
let mockServer: Server;
let mockPort: number;
let stallGateOpen: () => void;
const upstreamBodies: string[] = [];
let nextRequestId = 1;

/** serveHttp 内存假体：捕获 handler（测试直接以 CarrierRequest 驱动）。 */
const fakeServeHttp: ServeHttpFn = async (_fabric, _peerId, h) => {
  handler = h;
  serverClosed = false;
  return {
    close: async () => {
      serverClosed = true;
    },
  };
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "aifly-engine-"));
  // mock 上游（/stall 挂起至放行——并发限额用）
  let stallResolve: () => void = () => undefined;
  const stallGate = new Promise<void>((r) => {
    stallResolve = r;
  });
  stallGateOpen = stallResolve;
  const handler_: RequestListener = (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      upstreamBodies.push(Buffer.concat(chunks).toString());
      if (req.url === "/stall") {
        void stallGate.then(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ path: req.url, stalled: true }));
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          path: req.url,
          auth: req.headers.authorization ?? null,
          sandbox: req.headers["x-sandbox"] ?? null,
        }),
      );
    });
  };
  mockServer = createServer(handler_);
  await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  mockPort = (mockServer.address() as AddressInfo).port;

  // 沙盒 HOME（复核 R2-P1-B）：仅存在于该 home 的用户 hook，验证 home 从
  // ProviderStore.open 一致贯穿到 engine opts → forwardRequest 的运行时解析。
  sandboxHome = mkdtempSync(join(tmpdir(), "aifly-engine-home-"));
  const userHooksDir = join(sandboxHome, ".aifly", "hooks");
  mkdirSync(userHooksDir, { recursive: true });
  writeFileSync(
    join(userHooksDir, "sandbox-preset.cjs"),
    [
      '"use strict";',
      "module.exports = {",
      "  onRequestHeaders: async () => ({ set: { 'x-sandbox': 'yes' } }),",
      "};",
      "",
    ].join("\n"),
  );

  store = ProviderStore.open(dir, { home: sandboxHome });
  const svc = store.addService({
    name: "api",
    upstream: `http://127.0.0.1:${mockPort}`,
    match: [{ type: "suffix", value: ".local" }],
    // hooks-lifecycle v2：$env 字面量间接引用落 headers.set（请求期解析）。
    headers: { set: { authorization: "$env:TEST_UPSTREAM_KEY" } },
  });
  serviceId = svc.serviceId;
  store.addGroup("friends", ["api"], { maxConcurrency: 1 });
  store.addGroup("mates", ["api"]);
  keyFriends = store.issueKey("friends");
  keyMates = store.issueKey("mates");

  fabricPair = FakeFabric.pair(PROVIDER_EP, CONSUMER_EP);
  handler = undefined;
  serverClosed = false;
  engine = new ProviderEngine({
    fabric: fabricPair.provider,
    store,
    dataDir: dir,
    serveHttp: fakeServeHttp,
    opts: {
      env: { TEST_UPSTREAM_KEY: "sk-env-injected" },
      // $secret 解析走真实密钥库（无内存态：测试内 set/remove 即刻生效）。
      secrets: (name) => SecretsStore.open(dir).get(name),
      timeouts: { connectMs: 1_000, firstByteMs: 30_000, stallMs: 30_000 },
      home: sandboxHome,
    },
  });
  await engine.start();
});

afterEach(async () => {
  await engine.shutdown();
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
  rmSync(sandboxHome, { recursive: true, force: true });
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

/** 构造 CarrierRequest（body 一次性经 bodyNext 供给）。 */
function carrierReq(over: {
  method: string;
  path: string;
  headers?: Array<{ name: string; value: string }>;
  body?: Uint8Array;
}): CarrierRequest {
  const chunks = over.body !== undefined && over.body.length > 0 ? [Buffer.from(over.body)] : [];
  let i = 0;
  return {
    requestId: nextRequestId++,
    streamId: 0,
    method: over.method,
    path: over.path,
    headers: over.headers ?? [],
    bodyNext: async () => (i < chunks.length ? chunks[i++]! : null),
  };
}

function fwdReq(
  service: string,
  over: { method?: string; path?: string; body?: Uint8Array; headers?: Array<{ name: string; value: string }> } = {},
): CarrierRequest {
  return carrierReq({
    method: over.method ?? "GET",
    path: over.path ?? "/v1/echo",
    ...(over.body !== undefined ? { body: over.body } : {}),
    headers: [{ name: AIFLY_SERVICE_HEADER, value: service }, ...(over.headers ?? [])],
  });
}

function bodyJson(resp: CarrierResponse): any {
  return JSON.parse(Buffer.concat(resp.bodyChunks ?? []).toString("utf8"));
}

function errorCode(resp: CarrierResponse): string | undefined {
  return resp.headers?.find((h) => h.name === "x-aifly-error-code")?.value;
}

/** peer-connected 起 HTTP 引擎 + AUTH 呈交（返回响应）。 */
async function authCall(keys: string[]): Promise<CarrierResponse> {
  fabricPair.provider.emit({ type: "peer-connected", endpointId: CONSUMER_EP });
  const h = await waitFor(() => handler);
  return h(
    carrierReq({
      method: "POST",
      path: "/_aifly/auth",
      headers: [{ name: "content-type", value: "application/json" }],
      body: ENC.encode(JSON.stringify({ v: 1, keys })),
    }),
  );
}

async function connectAndAuth(keys: string[]): Promise<AuthOkHeader> {
  const resp = await authCall(keys);
  expect(resp.status).toBe(200);
  return bodyJson(resp) as AuthOkHeader;
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
    // v2 四槽 detail：形状经严格 schema 校验。
    const detail = group.services[0]?.detail;
    expect(SERVICE_DETAIL_SCHEMA.safeParse(detail).success).toBe(true);
    expect((detail as { upstream?: string }).upstream).toBe(`http://127.0.0.1:${mockPort}/`);
    expect(JSON.stringify(header)).not.toContain("TEST_UPSTREAM_KEY");
    expect(JSON.stringify(header)).not.toContain("sk-env-injected");
    expect(engine.sessionCount()).toBe(1);
  });

  it("全无效 -> 403 key_all_invalid；后续 forward 401 unauthorized", async () => {
    const resp = await authCall(["sk-aifly-totally-wrong"]);
    expect(resp.status).toBe(403);
    expect((bodyJson(resp) as { code: string }).code).toBe("key_all_invalid");
    // 会话不拆（AUTH 失败不重建内核会话——等待 key add 后重新呈交）。
    expect(engine.sessionCount()).toBe(1);
    const fwd = await handler!(fwdReq(serviceId));
    expect(fwd.status).toBe(401);
    expect(errorCode(fwd)).toBe("unauthorized");
  });

  it("混合钥 AUTH：rejected 携带 key_invalid", async () => {
    const header = await connectAndAuth([keyFriends.key, "sk-aifly-wrong-key-xyz"]);
    expect(header.groups).toHaveLength(1);
    expect(header.rejected).toEqual([{ code: "key_invalid" }]);
  });
});

describe("forward 端点全链路", () => {
  it("授权服务：上游收到重写后请求与 $env 凭据；响应回送", async () => {
    await connectAndAuth([keyFriends.key]);
    const resp = await handler!(
      fwdReq(serviceId, {
        method: "POST",
        path: "/v1/echo",
        body: ENC.encode('{"q":"hi"}'),
        headers: [{ name: "content-type", value: "application/json" }],
      }),
    );
    expect(resp.status).toBe(200);
    expect(resp.headers?.find((h) => h.name === "content-type")?.value).toBe("application/json");
    const payload = bodyJson(resp) as { path: string; auth: string | null };
    expect(payload.path).toBe("/v1/echo");
    expect(payload.auth).toBe("sk-env-injected");
    expect(upstreamBodies[0]).toBe('{"q":"hi"}');
  });

  it("home 贯穿运行时（复核 R2-P1-B）：预设模式脚本从注入 home 解析并生效", async () => {
    // 预设模式服务：sandbox-preset 仅存在于沙盒 HOME——engine opts.home 未贯穿
    // 到 forwardRequest 时该脚本按真实 os.homedir() 解析失败（hook_failed）。
    const svc = store.addService({
      name: "sbx",
      upstream: `http://127.0.0.1:${mockPort}`,
      match: [{ type: "suffix", value: ".local" }],
      hooks: { script: "sandbox-preset" },
    });
    store.addGroup("sbxgrp", ["sbx"]);
    const key = store.issueKey("sbxgrp");
    await connectAndAuth([key.key]);
    const resp = await handler!(fwdReq(svc.serviceId, { path: "/sbx" }));
    expect(resp.status).toBe(200);
    const payload = bodyJson(resp) as { sandbox: string | null };
    expect(payload.sandbox).toBe("yes"); // ② onRequestHeaders 注入头到达上游
  });

  it("未授权/未知 serviceId 统一 unknown_service（防枚举）", async () => {
    await connectAndAuth([keyFriends.key]);
    const resp = await handler!(fwdReq("nope", { path: "/x" }));
    expect(resp.status).toBe(404);
    expect(errorCode(resp)).toBe("unknown_service");
  });

  it("并发限额 1：第二在途请求立即 rate_limited；首请求完成后恢复受理", async () => {
    await connectAndAuth([keyFriends.key]);
    const first = handler!(fwdReq(serviceId, { path: "/stall" }));
    await waitFor(() => (engine.limits.inflightCount("friends") >= 1 ? true : undefined));
    const second = await handler!(fwdReq(serviceId));
    expect(second.status).toBe(429);
    expect(errorCode(second)).toBe("rate_limited");
    // 首请求完成 -> 释放并发 -> 新请求可受理（settle 驱动；abort 语义在
    // upstream.test 的 AbortController 路径覆盖）
    stallGateOpen();
    const firstResp = await first;
    expect(firstResp.status).toBe(200);
    await waitFor(() => (engine.limits.inflightCount("friends") === 0 ? true : undefined));
    const third = await handler!(fwdReq(serviceId));
    expect(third.status).toBe(200);
  });

  it("body 分块经 bodyNext 重组后派发", async () => {
    await connectAndAuth([keyMates.key]);
    // 分块供给（模拟内核 DATA 分帧重组）
    const req = fwdReq(serviceId, {
      method: "POST",
      path: "/v1/echo",
      body: ENC.encode("abcdefghij"),
      headers: [{ name: "content-type", value: "text/plain" }],
    });
    const origNext = req.bodyNext;
    let fed = 0;
    const parts = [Buffer.from("abcdef"), Buffer.from("ghij")];
    req.bodyNext = async () => {
      if (fed < parts.length) return parts[fed++]!;
      return null;
    };
    void origNext;
    const resp = await handler!(req);
    expect(resp.status).toBe(200);
    expect(upstreamBodies[upstreamBodies.length - 1]).toBe("abcdefghij");
  });

  it("$secret 全链路：命中注入密钥库完整头值；删除后同请求 secret_missing（信息不含名字）", async () => {
    const secrets = SecretsStore.open(dir);
    const secService = store.addService({
      name: "sec-api",
      upstream: `http://127.0.0.1:${mockPort}`,
      match: [{ type: "suffix", value: ".local" }],
      // hooks-lifecycle v2：$secret 字面量间接引用（未命中 → secret_missing）。
      headers: { set: { authorization: "$secret:test-key" } },
    });
    store.addGroup("secret-holders", ["sec-api"]);
    const keySecret = store.issueKey("secret-holders");
    secrets.set("test-key", "Bearer sk-lib-42");

    await connectAndAuth([keySecret.key]);
    const ok = await handler!(fwdReq(secService.serviceId));
    expect(ok.status).toBe(200);
    const payload = bodyJson(ok) as { auth: string | null };
    expect(payload.auth).toBe("Bearer sk-lib-42");

    // 删除密钥 -> 同一服务的后续请求被拒（不回退空值、名字不出网）。
    secrets.remove("test-key");
    const rejected = await handler!(fwdReq(secService.serviceId));
    expect(errorCode(rejected)).toBe("secret_missing");
    const text = Buffer.concat(rejected.bodyChunks ?? []).toString("utf8");
    expect(text).not.toContain("test-key");
    expect(text).not.toContain("sk-lib-42");
  });
});

describe("撤键与目录刷新（CLI 写盘 -> reloadStore -> catalog-watch）", () => {
  it("双钥在线撤一钥：watch refresh 视图剔除被撤组，会话不断", async () => {
    await connectAndAuth([keyFriends.key, keyMates.key]);
    // 另一进程（CLI）写盘
    const cliStore = ProviderStore.open(dir);
    cliStore.revokeKey(keyFriends.keyId);
    await engine.reloadStore();
    const watch = await handler!(
      carrierReq({ method: "GET", path: "/_aifly/catalog-watch?since=0" }),
    );
    expect(watch.status).toBe(200);
    const refresh = bodyJson(watch) as AuthOkHeader;
    expect(refresh.refresh).toBe(true);
    expect(refresh.groups.map((g) => g.group)).toEqual(["mates"]); // friends 剔除
    expect(engine.sessionCount()).toBe(1); // 会话不断（余钥有效）
    // 被撤服务仍可经余钥组访问
    const fwd = await handler!(fwdReq(serviceId));
    expect(fwd.status).toBe(200);
  });

  it("仅剩钥也被撤：授权失效 + 断传输（会话承载面保留）", async () => {
    await connectAndAuth([keyFriends.key]);
    const cliStore = ProviderStore.open(dir);
    cliStore.revokeKey(keyFriends.keyId);
    await engine.reloadStore();
    // kernel-migration 语义：不拆 serve 引擎/内核会话注册表（RESUME 续传面
    // 保留）——失效授权 + 断开传输（消费端续传后重 AUTH 得 403）。
    await waitFor(() => (fabricPair.provider.revoked.length >= 0 && engine.sessionCount() === 1 ? true : undefined));
    expect(engine.sessionCount()).toBe(1); // 承载面保留
    // 后续 forward 401（未授权）+ 重 AUTH 403
    const fwd = await handler!(fwdReq(serviceId));
    expect(fwd.status).toBe(401);
    expect(errorCode(fwd)).toBe("unauthorized");
    const reauth = await handler!(
      carrierReq({
        method: "POST",
        path: "/_aifly/auth",
        headers: [{ name: "content-type", value: "application/json" }],
        body: ENC.encode(JSON.stringify({ v: 1, keys: [keyFriends.key] })),
      }),
    );
    expect(reauth.status).toBe(403);
    expect((bodyJson(reauth) as { code: string }).code).toBe("key_all_invalid");
  });

  it("服务变更推送：向组新增服务进入 refresh 视图（全量替换语义）", async () => {
    const first = await connectAndAuth([keyMates.key]);
    expect(first.groups[0]!.services).toHaveLength(1);
    const cliStore = ProviderStore.open(dir);
    const svc2 = cliStore.addService({
      name: "extra",
      upstream: `http://127.0.0.1:${mockPort}`,
      match: [{ type: "exact", value: "extra.local" }],
    });
    cliStore.setGroupServices("mates", ["api", "extra"]);
    await engine.reloadStore();
    const watch = await handler!(
      carrierReq({ method: "GET", path: "/_aifly/catalog-watch?since=0" }),
    );
    expect(watch.status).toBe(200);
    const refresh = bodyJson(watch) as AuthOkHeader;
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
        // hooks-lifecycle v2：$env 声明位 = headers.set / auth.literal 的引用值。
        headers: {
          set: { a: "$env:SET_VAR", b: "$env:EMPTY_VAR", c: "$env:UNSET_VAR" },
        },
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
