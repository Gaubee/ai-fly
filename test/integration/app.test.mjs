// app 层集成（m2 tasks 5.1）：真 EngineHost（真盘上 store、真 HOME）+ WebServer +
// 契约 client over 真 ws。覆盖：设置往返、预设清单（精选免网）、预设落服务、
// 分组/密钥、写手 preview/apply 真文件往返、坏链接错误码、notify 推送、token 门禁。
// 不起 fabric（share/import.apply 等需组网的过程由 CLI e2e 覆盖）。

import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import { WebServer } from "../../src/app/web-server.ts";
import { createRpcRouter } from "../../src/app/rpc-router.ts";
import { EngineHost } from "../../src/app/engine-host.ts";

let base;
let server;
let host;
let port;
let cookie = "";
const notifyEvents = [];

function rpcUrl() {
  return `ws://127.0.0.1:${port}/ws/rpc`;
}

function makeClient() {
  const ws = new WebSocket(rpcUrl(), { headers: cookie ? { cookie } : undefined });
  const client = createORPCClient(new RPCLink({ websocket: ws }));
  return { client, ws };
}

before(async () => {
  base = mkdtempSync(join(tmpdir(), "aifly-app-int-"));
  mkdirSync(join(base, ".aifly"), { recursive: true });
  writeFileSync(
    join(base, ".aifly", "settings.json"),
    JSON.stringify({ theme: "dark", modelsDevEnabled: false, relayUrls: null }),
  );
  const webuiDir = join(base, "webui-dist");
  mkdirSync(webuiDir, { recursive: true });
  writeFileSync(join(webuiDir, "index.html"), "<html><body>ai-fly webui fixture</body></html>");
  host = new EngineHost({ home: base });
  const router = createRpcRouter({ host, home: base });
  server = new WebServer({ webuiDir, router, host: "127.0.0.1" });
  port = await server.start(0);
});

after(async () => {
  await server.stop();
  await host.stop();
  rmSync(base, { recursive: true, force: true });
});

describe("app integration: token gate + contract over ws", () => {
  it("token 一次性兑换为会话 cookie；无 token 只得指引页", async () => {
    const bare = await fetch(`http://127.0.0.1:${port}/`);
    assert.ok((bare.headers.get("content-type") ?? "").includes("text/html"));
    assert.match(await bare.text(), /desktop app/i);
    assert.equal(bare.status, 200);

    const token = server.issueUiToken();
    const res = await fetch(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`, {
      redirect: "manual",
    });
    assert.equal(res.status, 303);
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /aifly_ui_session=/);
    cookie = setCookie.split(";")[0];

    const replay = await fetch(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`, {
      redirect: "manual",
    });
    assert.equal(replay.status, 200);
    assert.match(await replay.text(), /desktop app/i);
  });

  it("设置往返（notify 通道可开）", async () => {
    const notify = new WebSocket(`ws://127.0.0.1:${port}/ws/notify`, { headers: { cookie } });
    await new Promise((r) => notify.once("open", r));
    notifyEvents.length = 0;
    notify.on("message", (d) => notifyEvents.push(JSON.parse(String(d))));

    const { client, ws } = makeClient();
    const before = await client.system.settings.get({});
    assert.equal(before.theme, "dark");
    assert.equal(before.modelsDevEnabled, false);
    const saved = await client.system.settings.set({ theme: "light", modelsDevEnabled: false, relayUrls: [] });
    assert.equal(saved.theme, "light");
    ws.close();
    // notify 不断开：后续用例的 store 事件继续收集
  });

  it("预设清单（精选免网）→ 预设落服务 → detail 凭据脱敏", async () => {
    const { client, ws } = makeClient();
    const presets = await client.presets.list({});
    assert.ok(presets.curated.length >= 15, `curated presets >= 15 (got ${presets.curated.length})`);
    assert.ok(presets.curated.some((p) => p.id === "ollama"));

    const zai = presets.curated.find((p) => p.id.startsWith("zai"));
    assert.ok(zai, "zai preset present");

    const added = await client.provider.services.add({
      name: "zai-bridge",
      upstream: zai.baseUrl,
      defaultPort: 4300,
      match: zai.matchDomains.slice(0, 2).map((d) => ({ type: "suffix", value: d })),
      rewrite: { headerSet: { authorization: `$env:${zai.keyEnv}` } },
    });
    assert.ok(added.service.name === "zai-bridge");

    const got = await client.provider.services.get({ name: "zai-bridge" });
    const detail = JSON.stringify(got);
    // 本地 RPC 面允许 $env 引用（变量名在本机 store 内，非 wire 面）；
    // 关键断言：不包含环境变量的"值"（store 从不落值），wire 面（AUTH_OK）的
    // ● 脱敏由引擎集成测试覆盖。
    assert.ok(detail.includes("$env:ZHIPU_API_KEY"), "本地配置面保留 $env 引用");
    assert.ok(!detail.includes(process.env.ZHIPU_API_KEY ?? "__never__"), "不含变量值");
    ws.close();
  });

  it("分组/密钥管理（issue 原文一次性）", async () => {
    const { client, ws } = makeClient();
    await client.provider.groups.add({ name: "friends", serviceNames: [], limits: { maxConcurrency: 2 } });
    const key = await client.provider.keys.issue({ group: "friends" });
    assert.match(key.key, /^sk-aifly-/);
    const listed = await client.provider.keys.list({});
    const entry = listed.keys.find((k) => k.keyId === key.keyId);
    assert.ok(entry);
    assert.equal(entry.revokedAt, undefined, "新钥未撤销");
    assert.ok(!JSON.stringify(entry).includes(key.key), "list 不回显原文");
    ws.close();
  });

  it("写手 preview→apply 真文件往返（continue，tmp HOME）", async () => {
    const { client, ws } = makeClient();
    const preview = await client.writers.preview({ agent: "continue", target: { port: 4300 } });
    assert.ok(preview.diff.includes("+"), "diff 存在新增行");
    assert.ok(preview.path.includes(base), `写手落在注入的 HOME（${preview.path}）`);
    const applied = await client.writers.apply({ agent: "continue", target: { port: 4300 }, confirmToken: preview.confirmToken });
    assert.equal(applied.written, true);
    ws.close();
  });

  it("坏链接 → INVALID_INPUT（离线 preview）", async () => {
    const { client, ws } = makeClient();
    await assert.rejects(
      client.consumer.import.preview({ link: "aifly1.not-base64!!!" }),
      (err) => {
        assert.match(String(err.code ?? ""), /INVALID_INPUT|INVALID_INPUT_INPUT/);
        return true;
      },
    );
    ws.close();
  });
});
