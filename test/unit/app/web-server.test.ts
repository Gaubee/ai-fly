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
    expect(presets.curated.length).toBeGreaterThanOrEqual(18);
    expect(presets.modelsDev).toEqual([]); // settings 关闭 → 空长尾
    expect(presets.modelsDevError).toContain("disabled");

    const settings = await client.system.settings.get({});
    expect(settings.theme).toBe("dark");

    // 预设 → 服务（展开走 services.add 同一校验路径）
    const applied = await client.presets.applyAsService({ presetId: "openai" });
    expect(applied.service.name).toBe("openai");
    expect(applied.service.upstream).toBe("https://api.openai.com/v1");
    expect(applied.service.defaultPort).toBe(4300);
    expect(applied.service.match).toEqual([{ type: "suffix", value: "api.openai.com" }]);
    expect(applied.service.rewrite).toEqual({
      headerSet: { authorization: "$env:OPENAI_API_KEY" },
    });
    expect(applied.envHint).toContain("OPENAI_API_KEY");

    // secretName 优先于 keyEnv：rewrite 写 $secret:<name>，不给 envHint
    const viaSecret = await client.presets.applyAsService({
      presetId: "openai",
      name: "openai-via-secret",
      secretName: "openai-main",
    });
    expect(viaSecret.service.rewrite).toEqual({
      headerSet: { authorization: "$secret:openai-main" },
    });
    expect(viaSecret.envHint).toBeUndefined();

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
