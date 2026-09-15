// web-server 单测（shell spec「UI 服务与 token 门禁」）：
// - token 一次性消费（?token= 兑换会话 cookie；重复使用被拒；无 token 无会话
//   只得指引页；cookie 承载后续请求与 ws 升级）；
// - SPA 回退（未知路径回 index.html；dist 缺席指引页）；
// - 畸形 ws 帧隔离（真 ws 客户端发垃圾帧：仅该连接断开，进程存活，后续正常
//   RPC 不受影响）；
// - orpc 端到端（真 server + RPCLink client 调多个契约过程断言输出）；
// - notify 通道（/ws/notify 收到 webserver.notify 推送）。

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import type { RpcContract } from "../../../src/shared/rpc-contract.ts";
import { WebServer } from "../../../src/app/web-server.ts";
import { createRpcRouter } from "../../../src/app/rpc-router.ts";
import { EngineHost } from "../../../src/app/engine-host.ts";
import type { FabricFactory } from "../../../src/consumer/providers.ts";

let base: string;
let server: WebServer;
let port: number;
let host: EngineHost;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "aifly-web-"));
  // 预置 models.dev 禁用（presets.list 免网络）+ webui dist fixture
  mkdirSync(join(base, ".aifly"), { recursive: true });
  writeFileSync(
    join(base, ".aifly", "settings.json"),
    JSON.stringify({ theme: "dark", modelsDevEnabled: false, relayUrls: null }),
  );
  const webuiDir = join(base, "webui-dist");
  mkdirSync(join(webuiDir, "assets"), { recursive: true });
  writeFileSync(join(webuiDir, "index.html"), "<html><body>ai-fly webui fixture</body></html>");
  writeFileSync(join(webuiDir, "assets", "app.js"), "console.log('fixture');");

  host = new EngineHost({
    home: base,
    providerDataDir: join(base, "provider"),
    consumersRoot: join(base, "consumers"),
    fabricFactory: {} as FabricFactory, // 免真实 SDK
  });
  const router = createRpcRouter({ host, home: base });
  server = new WebServer({ webuiDir, router });
  port = await server.start(0);
});

afterEach(async () => {
  await server.stop({ graceMs: 200 }).catch(() => undefined);
  await host.stop();
  rmSync(base, { recursive: true, force: true });
});

function httpGet(path: string, headers: Record<string, string> = {}): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  setCookie: string[];
}> {
  const { get } = require_node_http();
  return new Promise((resolve, reject) => {
    const req = get(
      { host: "127.0.0.1", port, path, headers },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            setCookie: res.headers["set-cookie"] ?? [],
          }),
        );
      },
    );
    req.on("error", reject);
  });
}

// node:http 的惰性小桥（测试文件顶部统一 import 亦可；此处集中一处）
import * as nodeHttp from "node:http";
function require_node_http(): typeof nodeHttp {
  return nodeHttp;
}

function openWs(path: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}${path}`);
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function waitClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.once("close", (code) => resolve(code));
  });
}

/** 用一次性 token 建立 rpc client（等价 webview 首连路径）。 */
async function connectRpcClient(token?: string): Promise<{
  client: ContractRouterClient<RpcContract>;
  ws: WebSocket;
}> {
  const t = token ?? server.issueUiToken();
  const ws = openWs(`/ws/rpc?token=${encodeURIComponent(t)}`);
  await waitOpen(ws);
  // node 端 ws 包与 RPCLink 期望的 DOM WebSocket 形状仅 addEventListener 重载
  // 有差异——运行时鸭子类型兼容（webui 里用浏览器 WebSocket 无此差异）。
  const client = createORPCClient<ContractRouterClient<RpcContract>>(
    new RPCLink({ websocket: ws as unknown as never }),
  );
  return { client, ws };
}

// ---------------------------------------------------------------------------
// token 门禁
// ---------------------------------------------------------------------------

describe("token gate", () => {
  it("exchanges a one-time token for a session cookie and serves the SPA", async () => {
    const token = server.issueUiToken();
    const first = await httpGet(`/?token=${encodeURIComponent(token)}`);
    expect(first.status).toBe(303);
    expect(first.headers["location"]).toBe("/");
    expect(first.setCookie.length).toBeGreaterThan(0);
    const cookie = first.setCookie[0]!.split(";")[0]!;

    const second = await httpGet("/", { cookie });
    expect(second.status).toBe(200);
    expect(second.body).toContain("ai-fly webui fixture");

    // SPA 回退：未知路径回 index.html
    const fallback = await httpGet("/some/deep/route", { cookie });
    expect(fallback.status).toBe(200);
    expect(fallback.body).toContain("ai-fly webui fixture");

    // 静态资源
    const asset = await httpGet("/assets/app.js", { cookie });
    expect(asset.status).toBe(200);
    expect(asset.body).toContain("fixture");
  });

  it("rejects token reuse (one-time consumption)", async () => {
    const token = server.issueUiToken();
    const first = await httpGet(`/?token=${encodeURIComponent(token)}`);
    expect(first.status).toBe(303);
    const replay = await httpGet(`/?token=${encodeURIComponent(token)}`);
    expect(replay.status).toBe(200);
    expect(replay.body).toContain("invalid or was already used");
  });

  it("serves only the guidance page to tokenless local browsers", async () => {
    const response = await httpGet("/");
    expect(response.status).toBe(200);
    expect(response.body).toContain("desktop app");
    expect(response.body).not.toContain("ai-fly webui fixture");
  });

  it("rejects ws upgrade without token or session (401)", async () => {
    const ws = openWs("/ws/rpc");
    const closed = new Promise<(number | undefined)>((resolve) => ws.once("unexpected-response", (_req, res) => resolve(res.statusCode)).once("error", () => resolve(undefined)));
    expect(await closed).toBe(401);
  });

  it("rejects ws upgrade with a consumed token", async () => {
    const token = server.issueUiToken();
    await httpGet(`/?token=${encodeURIComponent(token)}`); // 兑换掉
    const ws = openWs(`/ws/rpc?token=${encodeURIComponent(token)}`);
    const closed = new Promise<(number | undefined)>((resolve) =>
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode)).once("error", () => resolve(undefined)),
    );
    expect(await closed).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 畸形帧隔离 + orpc 端到端
// ---------------------------------------------------------------------------

describe("orpc over ws", () => {
  it("serves contract procedures end to end", async () => {
    const { client, ws } = await connectRpcClient();

    const channels = await client.system.notifyChannels({});
    expect(channels.rpcPath).toBe("/ws/rpc");
    expect(channels.notifyPath).toBe("/ws/notify");
    expect(channels).toEqual({ rpcPath: "/ws/rpc", notifyPath: "/ws/notify" });

    const before = await client.provider.services.list({});
    expect(before.services).toEqual([]);

    const added = await client.provider.services.add({
      name: "openai-main",
      upstream: "https://api.openai.com/v1",
      match: [{ type: "suffix", value: "api.openai.com" }],
      defaultPort: 4300,
    });
    expect(added.service.name).toBe("openai-main");


    const presets = await client.presets.list({});
    expect(presets.curated.length).toBeGreaterThanOrEqual(3);
    expect(presets.modelsDev).toEqual([]); // settings 关闭 → 空长尾
    expect(presets.modelsDevError).toContain("disabled");

    const settings = await client.system.settings.get({});
    expect(settings.theme).toBe("dark");

    // 预设 → 服务（展开走 services.add 同一校验路径；hooks-lifecycle v2：keyEnv
    // → auth.literal 的 $env 间接引用）
    const applied = await client.presets.applyAsService({ presetId: "openai" });
    expect(applied.service.name).toBe("openai");
    // M3-r4：openai 预设 base 去掉 /v1（路由模型接管版本段），href 规范化带尾斜杠
    expect(applied.service.upstream).toBe("https://api.openai.com/");
    expect(applied.service.defaultPort).toBe(4300);
    expect(applied.service.match).toEqual([{ type: "suffix", value: "api.openai.com" }]);
    expect(applied.service.auth).toEqual({ literal: "$env:OPENAI_API_KEY" });
    expect(applied.service.rewrite).toBeUndefined();
    expect(applied.service.routes).toEqual([
      { forms: ["openai-chat", "openai-responses"], localPrefix: "/v1", upstreamPrefix: "/v1" },
    ]);
    expect(applied.envHint).toContain("OPENAI_API_KEY");

    // secretName 优先于 keyEnv：auth 落 secret 引用，不给 envHint
    const viaSecret = await client.presets.applyAsService({
      presetId: "openai",
      name: "openai-via-secret",
      secretName: "openai-main",
    });
    expect(viaSecret.service.auth).toEqual({ secret: "openai-main" });
    expect(viaSecret.envHint).toBeUndefined();

    // codex 预设（rust-fetch-sidecar）：走预设模式——hooks 整段绑定（脚本自带
    // ①②③ 阶段导出），不再装配 auth 槽；无 keyEnv 故无 envHint
    const viaCodex = await client.presets.applyAsService({ presetId: "codex", name: "codex-main" });
    expect(viaCodex.service.hooks).toEqual({ script: "codex" });
    expect(viaCodex.service.auth).toBeUndefined();
    expect(viaCodex.service.upstream).toBe("https://chatgpt.com/");
    expect(viaCodex.envHint).toBeUndefined();

    // 写手两段式（preview → confirm → apply）
    const writerPreview = await client.writers.preview({ agent: "codex", target: { port: 8787 } });
    expect(writerPreview.path).toContain(join(base, ".codex", "config.toml"));
    expect(writerPreview.diff).toContain("+base_url =");
    const written = await client.writers.apply({
      agent: "codex",
      target: { port: 8787 },
      confirmToken: writerPreview.confirmToken,
    });
    expect(written.written).toBe(true);
    // 令牌重放（已应用）被拒
    await expect(
      client.writers.apply({
        agent: "codex",
        target: { port: 8787 },
        confirmToken: writerPreview.confirmToken,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });

    ws.close();
  });

  it("maps engine validation errors through the DomainError boundary", async () => {
    const { client, ws } = await connectRpcClient();
    await client.provider.services.add({
      name: "dupe",
      upstream: "https://api.example.com:8443",
      match: [{ type: "suffix", value: "api.example.com" }],
    });
    await expect(
      client.provider.services.add({
        name: "dupe",
        upstream: "https://api.example.com:8443",
        match: [{ type: "suffix", value: "api.example.com" }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    ws.close();
  });

  it("legacy (pre-v2) store face: status exposes legacy, list returns shells, writes rejected, secrets unaffected", async () => {
    // 预置 v1 services.json（无 version 字段）——engine-host 打开即进入 legacy 态
    mkdirSync(join(base, "provider"), { recursive: true });
    writeFileSync(
      join(base, "provider", "services.json"),
      JSON.stringify({
        revision: 3,
        services: [
          { serviceId: "old1", name: "stale-alpha", match: [], upstream: "http://127.0.0.1:9001", defaultPort: 29001 },
          { serviceId: "old2", name: "stale-beta", match: [], upstream: "http://127.0.0.1:9002", defaultPort: 29002 },
        ],
        groups: [],
        keys: [],
      }),
    );
    const { client, ws } = await connectRpcClient();

    const status = await client.provider.status({});
    expect(status.legacy).toEqual({ serviceNames: ["stale-alpha", "stale-beta"] });
    expect(status.services).toBe(0); // 空视图计数

    const listed = await client.provider.services.list({});
    expect(listed.services).toEqual([
      { name: "stale-alpha", legacy: true },
      { name: "stale-beta", legacy: true },
    ]);

    // services/groups/keys 写操作经 store 单点门禁 → INVALID_STATE
    await expect(
      client.provider.services.add({
        name: "new",
        upstream: "https://api.example.com:8443",
        match: [{ type: "suffix", value: "api.example.com" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(client.provider.groups.add({ name: "g", serviceNames: [] })).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    await expect(client.provider.keys.issue({ group: "g" })).rejects.toMatchObject({ code: "INVALID_STATE" });

    // share.create 门禁前置（复核 R1-F6）：INVALID_STATE 且不发起 invite——
    // handler 在 requireProviderDaemon/fabric.invite 之前拒绝，provider daemon
    // 未运行时同样命中本门禁（若门禁缺失则会以 daemon 缺席类错误先行暴露）。
    await expect(
      client.provider.share.create({ group: "g", ttlMs: 60_000 }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });

    // secrets.json 为独立文件：不受 legacy 门禁
    const secret = await client.provider.secrets.set({ name: "kk", value: "sk-xyz" });
    expect(secret.secret.name).toBe("kk");

    // services.remove 按名可用（legacy 唯一写路径）且名册刷新
    await client.provider.services.remove({ name: "stale-alpha" });
    const after = await client.provider.services.list({});
    expect(after.services).toEqual([{ name: "stale-beta", legacy: true }]);
    ws.close();
  });

  it("lifecycle preset mode (rust-fetch-sidecar): hooks binding round-trip, mutual exclusion, no-stage rejection", async () => {
    const { client, ws } = await connectRpcClient();

    // 预设模式：内建 codex 脚本（现含 ①②③ 三个阶段导出）可整段绑定
    const added = await client.provider.services.add({
      name: "preset-svc",
      upstream: "https://chatgpt.com",
      match: [{ type: "suffix", value: "chatgpt.com" }],
      defaultPort: 4306,
      hooks: { script: "codex" },
    });
    expect(added.service.hooks).toEqual({ script: "codex" });
    const got = await client.provider.services.get({ name: "preset-svc" });
    expect(got.hooks).toEqual({ script: "codex" });

    // 互斥：hooks + auth → INVALID_INPUT（store 层裁决经统一边界映射）
    await expect(
      client.provider.services.add({
        name: "clash",
        upstream: "https://api.example.com:8443",
        match: [{ type: "suffix", value: "api.example.com" }],
        hooks: { script: "codex" },
        auth: { secret: "lib" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    // 无阶段导出的脚本 → INVALID_INPUT（入口校验）
    await expect(
      client.provider.services.add({
        name: "no-stage",
        upstream: "https://api.example.com:8443",
        match: [{ type: "suffix", value: "api.example.com" }],
        hooks: { script: "definitely-not-a-script" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await client.provider.services.remove({ name: "preset-svc" });
    ws.close();
  });

  it("preset mode home threading (复核 R2-P1-B): sandbox user hook saves via services.add", async () => {
    const { client, ws } = await connectRpcClient();

    // 沙盒 HOME 下安装一个仅存在于该 home 的用户 hook（导出 ② 阶段函数）
    const userHooksDir = join(base, ".aifly", "hooks");
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

    // 复现口径：RPC preflight（rpc-router 注入 home）通过后，store.addService 的
    // 阶段导出校验曾回退真实 os.homedir() 而拒绝同一脚本——home 贯穿后应落库成功。
    const added = await client.provider.services.add({
      name: "sandbox-preset-svc",
      upstream: "https://api.example.com:8443",
      match: [{ type: "suffix", value: "api.example.com" }],
      defaultPort: 4307,
      hooks: { script: "sandbox-preset" },
    });
    expect(added.service.hooks).toEqual({ script: "sandbox-preset" });

    // 磁盘往返（新开 store 视图同注入 home）：hooks 绑定保持
    const got = await client.provider.services.get({ name: "sandbox-preset-svc" });
    expect(got.hooks).toEqual({ script: "sandbox-preset" });

    // 反例仍在：该沙盒 home 下不存在的脚本名照旧被拒
    await expect(
      client.provider.services.add({
        name: "ghost",
        upstream: "https://api.example.com:8443",
        match: [{ type: "suffix", value: "api.example.com" }],
        hooks: { script: "sandbox-ghost" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    await client.provider.services.remove({ name: "sandbox-preset-svc" });
    ws.close();
  });

  it("hooks-lifecycle 5.1/5.2 contract face: hooks.list stages-only, secrets.list exact shape, services.test auth draft", async () => {
    const { client, ws } = await connectRpcClient();

    // hooks.list：stages-only（codex R6 裁决）——输出无 fns 字段；旧导出名脚本
    // stages 为空数组仍列出（供管理面提示重写）。
    const hooks = await client.provider.hooks.list({});
    expect(hooks.hooks.length).toBeGreaterThan(0);
    for (const h of hooks.hooks) {
      expect(Object.keys(h).sort()).toEqual(["name", "source", "stages"]);
      for (const stage of h.stages) {
        expect([
          "onRequestBearerAuthentication",
          "onRequestHeaders",
          "onRequest",
          "onResponse",
        ]).toContain(stage);
      }
    }
    const anyScript = hooks.hooks[0]!;
    expect(typeof anyScript.name).toBe("string");

    // secrets.list 精确形状：{secrets:[{name,createdAt,updatedAt}], count}——值与
    // bearerPrefix 绝不出现；set 输入不再接受 bearerPrefix。
    await client.provider.secrets.set({ name: "k1", value: "sk-raw" });
    const secrets = await client.provider.secrets.list({});
    expect(secrets.count).toBe(1);
    expect(Object.keys(secrets).sort()).toEqual(["count", "secrets"]);
    expect(Object.keys(secrets.secrets[0]!).sort()).toEqual(["createdAt", "name", "updatedAt"]);
    expect(JSON.stringify(secrets)).not.toContain("sk-raw");
    expect(JSON.stringify(secrets)).not.toContain("bearerPrefix");
    await expect(
      // strictObject 输入：bearerPrefix 已退役——传入即校验失败（码面经 orpc 输入
      // 校验层，非 DomainError 边界；此处只锁「拒绝」事实）
      client.provider.secrets.set({ name: "k2", value: "v", bearerPrefix: true } as never),
    ).rejects.toBeTruthy();

    // services.test：auth 槽草稿输入（secret 引用 + bearer 默认拼）。
    const seenReqs: Array<{ url: string; authorization: string | null }> = [];
    const upstream = nodeHttp.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seenReqs.push({ url: req.url ?? "/", authorization: req.headers.authorization ?? null });
        if (req.url === "/v1/models") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: [{ id: "mock-mini" }] }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    try {
      const upstreamBase = `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}`;
      const ok = await client.provider.services.test({
        upstream: upstreamBase,
        auth: { secret: "k1" },
      });
      expect(ok.ok).toBe(true);
      expect(ok.model).toBe("mock-mini"); // /models 探测档
      const posted = seenReqs.find((r) => r.url === "/v1/chat/completions")!;
      expect(posted.authorization).toBe("Bearer sk-raw"); // 裸值 + auth 槽默认 bearer
      // bearer:false 按原样注入
      const raw = await client.provider.services.test({
        upstream: upstreamBase,
        auth: { secret: "k1", bearer: false },
        model: "mock-mini",
      });
      expect(raw.ok).toBe(true);
      expect(seenReqs.at(-1)!.authorization).toBe("sk-raw");
      // 草稿引用缺失密钥 → 结果级失败（不抛）
      const missing = await client.provider.services.test({
        upstream: upstreamBase,
        auth: { secret: "ghost" },
        model: "mock-mini",
      });
      expect(missing.ok).toBe(false);
      expect(missing.error).toBe("secret not found");
      // secretName 单字段形态已退役：输入校验拒绝
      await expect(
        client.provider.services.test({ upstream: upstreamBase, secretName: "k1" } as never),
      ).rejects.toBeTruthy();
    } finally {
      upstream.close();
    }
    ws.close();
  });

  it("isolates malformed frames: only that socket dies, the process and later RPCs survive", async () => {
    const good1 = await connectRpcClient();

    // 畸形帧 1：非 JSON 文本帧
    const bad1 = openWs(`/ws/rpc?token=${encodeURIComponent(server.issueUiToken())}`);
    await waitOpen(bad1);
    bad1.send("this is not an orpc frame");
    await waitClose(bad1);

    // 畸形帧 2：结构是 JSON 但形状非法（oRPC 反序列化路径）
    const bad2 = openWs(`/ws/rpc?token=${encodeURIComponent(server.issueUiToken())}`);
    await waitOpen(bad2);
    bad2.send(JSON.stringify({ jsonrpc: "2.0", method: "bogus", params: [1, 2, 3] }));
    await waitClose(bad2);

    // 既有连接与新建连接照常工作（进程未被击穿）
    const channels = await good1.client.system.notifyChannels({});
    expect(channels.rpcPath).toBe("/ws/rpc");
    good1.ws.close();

    const good2 = await connectRpcClient();
    const status = await good2.client.provider.status({});
    expect(status.running).toBe(false);
    good2.ws.close();
  });
});

// ---------------------------------------------------------------------------
// notify 通道
// ---------------------------------------------------------------------------

describe("notify channel", () => {
  it("pushes JSON events to /ws/notify subscribers", async () => {
    const ws = openWs(`/ws/notify?token=${encodeURIComponent(server.issueUiToken())}`);
    await waitOpen(ws);
    const received = new Promise<string>((resolve) => ws.once("message", (data) => resolve(data.toString("utf8"))));
    server.notify({ type: "provider-daemon", payload: { running: true } });
    const raw = await received;
    const parsed = JSON.parse(raw) as { type: string; payload: Record<string, unknown> };
    expect(parsed.type).toBe("provider-daemon");
    expect(parsed.payload).toEqual({ running: true });
    ws.close();
  });

  it("supports in-process subscribe/unsubscribe", () => {
    const seen: string[] = [];
    const unsubscribe = server.subscribe((event) => seen.push(event.type));
    server.notify({ type: "consumer-gateway", payload: {} });
    unsubscribe();
    server.notify({ type: "ignored-after-unsubscribe", payload: {} });
    expect(seen).toEqual(["consumer-gateway"]);
  });
});

// ---------------------------------------------------------------------------
// dist 缺席指引页
// ---------------------------------------------------------------------------

describe("missing webui dist", () => {
  it("serves a build guidance page", async () => {
    const emptyBase = mkdtempSync(join(tmpdir(), "aifly-web-empty-"));
    try {
      const router = createRpcRouter({
        host: new EngineHost({ home: emptyBase, providerDataDir: join(emptyBase, "p"), consumersRoot: join(emptyBase, "c"), fabricFactory: {} as FabricFactory }),
        home: emptyBase,
      });
      const bare = new WebServer({ webuiDir: join(emptyBase, "does-not-exist"), router });
      const barePort = await bare.start(0);
      try {
        const token = bare.issueUiToken();
        const first = await fetch(`http://127.0.0.1:${barePort}/?token=${encodeURIComponent(token)}`, { redirect: "manual" });
        expect(first.status).toBe(303);
        const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
        const second = await fetch(`http://127.0.0.1:${barePort}/`, { headers: { cookie } });
        const body = await second.text();
        expect(body).toContain("pnpm -r build");
      } finally {
        await bare.stop({ graceMs: 200 });
      }
    } finally {
      rmSync(emptyBase, { recursive: true, force: true });
    }
  });
});
