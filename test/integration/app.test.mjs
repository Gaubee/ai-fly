// app 层集成（m2 tasks 5.1）：真 EngineHost（真盘上 store、真 HOME）+ WebServer +
// 契约 client over 真 ws。覆盖：设置往返、预设清单（精选免网）、预设落服务、
// 分组/密钥、写手 preview/apply 真文件往返、坏链接错误码、notify 推送、token 门禁。
// 不起 fabric（share/import.apply 等需组网的过程由 CLI e2e 覆盖）。

import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
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
import { saveKeyring } from "../../src/consumer/store.ts";

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

  it("预设清单（精选免网）→ 预设落服务（routes 随行）→ detail 凭据脱敏", async () => {
    const { client, ws } = makeClient();
    const presets = await client.presets.list({});
    assert.ok(presets.curated.length >= 3, `curated presets >= 3 (got ${presets.curated.length})`);
    assert.ok(presets.curated.some((p) => p.id === "deepseek"));

    const deepseek = presets.curated.find((p) => p.id === "deepseek");
    assert.ok(deepseek, "deepseek preset present");
    assert.ok(
      deepseek.routes?.some((r) => r.forms.includes("anthropic") && r.localPrefix === "/anthropic"),
      "deepseek preset carries anthropic route",
    );

    const added = await client.provider.services.add({
      name: "deepseek-bridge",
      upstream: deepseek.baseUrl,
      defaultPort: 4300,
      match: deepseek.matchDomains.slice(0, 2).map((d) => ({ type: "suffix", value: d })),
      rewrite: { headerSet: { authorization: `$env:${deepseek.keyEnv}` } },
      routes: deepseek.routes,
    });
    assert.ok(added.service.name === "deepseek-bridge");
    assert.ok(
      added.service.routes?.some((r) => r.forms.includes("anthropic") && r.upstreamPrefix === "/anthropic"),
      "routes 随服务落库",
    );

    const got = await client.provider.services.get({ name: "deepseek-bridge" });
    const detail = JSON.stringify(got);
    // 本地 RPC 面允许 $env 引用（变量名在本机 store 内，非 wire 面）；
    // 关键断言：不包含环境变量的"值"（store 从不落值），wire 面（AUTH_OK）的
    // ● 脱敏由引擎集成测试覆盖。
    assert.ok(detail.includes("$env:DEEPSEEK_API_KEY"), "本地配置面保留 $env 引用");
    assert.ok(!detail.includes(process.env.DEEPSEEK_API_KEY ?? "__never__"), "不含变量值");
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

  it("services 生命周期：list / setRunning / remove（停用可复活语义）", async () => {
    const { client, ws } = makeClient();
    const ep = "ep-svclife-integration01";
    saveKeyring(join(base, ".aifly", "consumers"), {
      alias: "life-prov",
      endpointId: ep,
      relayUrls: [],
      keys: [],
      services: [
        {
          serviceId: "svc-x",
          name: "llama",
          match: [{ type: "suffix", value: ".x.test" }],
          defaultPort: 18080,
        },
      ],
      ports: {},
      actualPorts: {},
      disabledServices: [],
    });

    const find = (listed) =>
      listed.providers.find((p) => p.endpointId === ep)?.services.find((s) => s.serviceId === "svc-x");

    const before = await client.consumer.services.list({});
    assert.ok(find(before), "list 含新导入服务");
    assert.equal(find(before).enabled, true);
    assert.equal(find(before).listening, false, "网关未启动，listening 恒 false");

    const stopped = await client.consumer.services.setRunning({ endpointId: ep, serviceId: "svc-x", running: false });
    assert.equal(stopped.changed, true);
    const idempotent = await client.consumer.services.setRunning({ endpointId: ep, serviceId: "svc-x", running: false });
    assert.equal(idempotent.changed, false);

    const after = await client.consumer.services.list({});
    assert.equal(find(after).enabled, false, "停用集合生效");
    assert.equal(find(after).listening, false);

    const removed = await client.consumer.services.remove({ endpointId: ep, serviceId: "svc-x" });
    assert.equal(removed.removed, true);

    const restarted = await client.consumer.services.setRunning({ endpointId: ep, serviceId: "svc-x", running: true });
    assert.equal(restarted.changed, true, "停用可复活");
    const revived = await client.consumer.services.list({});
    assert.equal(find(revived).enabled, true);

    await assert.rejects(
      client.consumer.services.setRunning({ endpointId: ep, serviceId: "ghost", running: false }),
      (err) => {
        assert.match(String(err.code ?? ""), /INVALID_INPUT|NOT_FOUND|INTERNAL/);
        return true;
      },
    );
    ws.close();
  });

  it("services 提供方级：setProviderRunning 环开关（providers[].enabled + 叠加语义）", async () => {
    const { client, ws } = makeClient();
    const ep = "ep-svclife-integration02";
    saveKeyring(join(base, ".aifly", "consumers"), {
      alias: "ring-prov",
      endpointId: ep,
      relayUrls: [],
      keys: [],
      services: [
        { serviceId: "svc-p1", name: "one", match: [{ type: "suffix", value: ".p1.test" }], defaultPort: 18081 },
        { serviceId: "svc-p2", name: "two", match: [{ type: "suffix", value: ".p2.test" }], defaultPort: 18082 },
      ],
      ports: {},
      actualPorts: {},
      disabledServices: ["svc-p2"],
      disabled: false,
    });

    const prov = (listed) => listed.providers.find((p) => p.endpointId === ep);
    const svc = (listed, id) => prov(listed)?.services.find((s) => s.serviceId === id);

    const before = await client.consumer.services.list({});
    assert.equal(prov(before).enabled, true);
    assert.equal(svc(before, "svc-p2").enabled, false, "单服务停用先行");

    const stopped = await client.consumer.services.setProviderRunning({ endpointId: ep, running: false });
    assert.equal(stopped.changed, true);
    const idem = await client.consumer.services.setProviderRunning({ endpointId: ep, running: false });
    assert.equal(idem.changed, false);

    const during = await client.consumer.services.list({});
    assert.equal(prov(during).enabled, false, "环级停用");
    assert.equal(svc(during, "svc-p1").enabled, false, "环停用覆盖全部服务");

    const started = await client.consumer.services.setProviderRunning({ endpointId: ep, running: true });
    assert.equal(started.changed, true);
    const after = await client.consumer.services.list({});
    assert.equal(prov(after).enabled, true);
    assert.equal(svc(after, "svc-p1").enabled, true, "环恢复：正常服务回来");
    assert.equal(svc(after, "svc-p2").enabled, false, "环恢复：单服务停用保持叠加");

    await assert.rejects(
      client.consumer.services.setProviderRunning({ endpointId: "ep-no-such-ref", running: false }),
      (err) => {
        assert.match(String(err.code ?? ""), /INVALID_INPUT|NOT_FOUND|INTERNAL/);
        return true;
      },
    );
    ws.close();
  });

  it("密钥库往返：set/list/remove；值绝不跨 RPC；文件 0600", async () => {
    const { client, ws } = makeClient();
    const first = await client.provider.secrets.set({ name: "openai", value: "Bearer sk-test-123" });
    assert.equal(first.secret.name, "openai");
    assert.equal(typeof first.secret.createdAt, "number");
    await client.provider.secrets.set({ name: "anthropic.main", value: "sk-ant-456" });

    const listed = await client.provider.secrets.list({});
    assert.deepEqual(
      listed.secrets.map((s) => s.name),
      ["anthropic.main", "openai"],
    );
    const listedJson = JSON.stringify(listed);
    assert.ok(!listedJson.includes("sk-test-123"), "list 不含值");
    assert.ok(!listedJson.includes("sk-ant-456"), "list 不含值");
    assert.ok(!("value" in listed.secrets[0]), "条目无 value 字段");

    const secretsPath = join(base, ".aifly", "provider", "secrets.json");
    assert.ok(existsSync(secretsPath), "secrets.json 落在 provider 数据目录");
    assert.equal(statSync(secretsPath).mode & 0o777, 0o600, "0600 权限");
    const onDisk = readFileSync(secretsPath, "utf8");
    assert.ok(onDisk.includes("sk-test-123"), "值只落本机密钥库文件");

    // remove 未命中 -> NOT_FOUND；命中后清单收缩
    await assert.rejects(client.provider.secrets.remove({ name: "ghost" }), (err) => {
      assert.match(String(err.code ?? ""), /NOT_FOUND/);
      return true;
    });
    const removed = await client.provider.secrets.remove({ name: "openai" });
    assert.equal(removed.removed, true);
    const after = await client.provider.secrets.list({});
    assert.deepEqual(
      after.secrets.map((s) => s.name),
      ["anthropic.main"],
    );
    ws.close();
  });

  it("草稿形状连通测试：fake upstream + models.dev 缓存注入（免网络）", async () => {
    // 本地 fake upstream：记录请求、回 200 JSON。
    const seen = [];
    // custom 探测用第二上游（finally 统一收尾：keep-alive 下 close 回调式收）
    let probeServer;
    const upstreamServer = createServer((req, res) => {
      // /models：OpenAI 兼容清单（探测路径用：便宜档 mini 排前由引擎启发式保证）
      if (req.method === "GET" && req.url === "/models") {
        seen.push({ url: req.url, authorization: req.headers.authorization ?? null, googKey: null });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "probe-big" }, { id: "probe-mini" }] }));
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({
          url: req.url,
          authorization: req.headers.authorization ?? null,
          googKey: req.headers["x-goog-api-key"] ?? null,
          body: body === "" ? undefined : JSON.parse(body),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise((r) => upstreamServer.listen(0, "127.0.0.1", r));
    const upstreamBase = `http://127.0.0.1:${upstreamServer.address().port}`;

    // 假 api.json 缓存：只含 fake provider（api 指向 fake upstream；fetchedAt 新鲜免刷新）。
    const cachePath = join(base, ".aifly", "cache", "models-dev.json");
    mkdirSync(join(base, ".aifly", "cache"), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({
        fetchedAt: Date.now(),
        raw: JSON.stringify({
          fake: {
            id: "fake",
            name: "Fake LLM",
            api: upstreamBase,
            npm: "@ai-sdk/openai-compatible",
            models: {
              "pricey-chat": { id: "pricey-chat", cost: { input: 10, output: 20 } },
              "cheap-chat": { id: "cheap-chat", cost: { input: 0.1, output: 0.2 } },
              "unpriced-chat": { id: "unpriced-chat" },
              "text-embedding-3": { id: "text-embedding-3", cost: { input: 0.01, output: 0.01 } },
            },
          },
        }),
      }),
    );

    const { client, ws } = makeClient();
    try {
      // 模型清单（长尾 presetId 即 models.dev provider id；缓存命中免网络）
      const models = await client.presets.models({ presetId: "fake" });
      assert.equal(models.error, undefined);
      assert.equal(models.models[0].id, "cheap-chat", "最便宜 chat 模型排首位");
      assert.equal(models.models[0].pricePerMTok, 0.1 + 0.2);
      const embed = models.models.find((m) => m.id === "text-embedding-3");
      assert.equal(embed.chat, false, "embed 归 non-chat");

      // 测试前缺密钥 -> 结果级失败（不抛）
      const noSecret = await client.provider.services.test({
        upstream: upstreamBase,
        secretName: "fake",
      });
      assert.equal(noSecret.ok, false);
      assert.equal(noSecret.error, "secret not found");

      // 设密钥后：默认模型 = priced chat 最低价；openai 形状请求注入 authorization。
      // 裸 key（Owner 2026-09-10）：bearerPrefix 默认开，注入自动拼 "Bearer "
      await client.provider.secrets.set({ name: "fake", value: "fk-1" });
      const ok = await client.provider.services.test({
        upstream: upstreamBase,
        secretName: "fake",
      });
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.equal(ok.httpStatus, 200);
      assert.equal(ok.model, "cheap-chat");
      assert.equal(typeof ok.latencyMs, "number");
      assert.equal(seen.at(-1).url, "/v1/chat/completions"); // M3-r4：base 无版本段补 /v1
      assert.equal(seen.at(-1).authorization, "Bearer fk-1");
      assert.equal(seen.at(-1).body.max_tokens, 1);
      assert.equal(seen.at(-1).body.messages[0].content, "ping");

      // anthropic 形状：/v1/messages（显式 model 避免清单依赖）
      await client.provider.services.test({
        upstream: upstreamBase,
        apiForm: "anthropic-messages",
        model: "claude-x",
        secretName: "fake",
      });
      assert.equal(seen.at(-1).url, "/v1/messages");
      assert.equal(seen.at(-1).body.model, "claude-x");

      // gemini 形状：密钥经 x-goog-api-key；无 secretName 则不带
      await client.provider.services.test({
        upstream: upstreamBase,
        apiForm: "gemini-native",
        model: "gemini-x",
        secretName: "fake",
      });
      assert.equal(seen.at(-1).url, "/v1beta/models/gemini-x:generateContent");
      assert.equal(seen.at(-1).googKey, "Bearer fk-1");
      await client.provider.services.test({
        upstream: upstreamBase,
        apiForm: "gemini-native",
        model: "gemini-x",
      });
      assert.equal(seen.at(-1).googKey, null, "无 secretName 不带密钥头");

      // 非 http(s) upstream -> INVALID_INPUT
      await assert.rejects(
        client.provider.services.test({ upstream: "ftp://nope.example", model: "m" }),
        (err) => {
          assert.match(String(err.code ?? ""), /INVALID_INPUT/);
          return true;
        },
      );

      // 清单不可用（缓存没有 + 探测拒绝）且未指定模型 -> 结果级失败（零外网）
      const noCatalog = await client.provider.services.test({
        upstream: "http://127.0.0.2:9",
      });
      assert.equal(noCatalog.ok, false);
      assert.match(noCatalog.error, /no model available/);

      // custom 上游探测模式：不在缓存里的第二上游，/models 拉清单 + test 走探测模型
      probeServer = createServer((req, res) => {
        // M3-r4：base 无版本段时探测走 /v1/models（两路都答）
        if (req.method === "GET" && (req.url === "/models" || req.url === "/v1/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: [{ id: "relay-xl" }, { id: "relay-mini" }] }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
      // 仍绑 127.0.0.1，但以 http://localhost:<port> 访问：缓存按 URL 主机名匹配
      // （localhost ≠ 127.0.0.1），探测路径得以触发（同主机不同端口会命中缓存——
      // 设计如此：同主机=同 provider）。
      await new Promise((r) => probeServer.listen(0, "127.0.0.1", r));
      const probeBase = `http://localhost:${probeServer.address().port}`;
      const probed = await client.presets.models({ upstream: probeBase, secretName: "fake" });
      assert.equal(probed.error, undefined);
      assert.equal(probed.models[0].id, "relay-mini", "探测清单便宜档排首");
      const viaProbe = await client.provider.services.test({ upstream: probeBase, secretName: "fake" });
      assert.equal(viaProbe.ok, true, JSON.stringify(viaProbe));
      assert.equal(viaProbe.model, "relay-mini");
      assert.equal(viaProbe.modelSource, "upstream-probe");
      assert.equal(viaProbe.request.url, `${probeBase}/v1/chat/completions`);

      // 删除密钥后同请求回到 secret not found
      await client.provider.secrets.remove({ name: "fake" });
      const gone = await client.provider.services.test({
        upstream: upstreamBase,
        secretName: "fake",
        model: "cheap-chat",
      });
      assert.equal(gone.ok, false);
      assert.equal(gone.error, "secret not found");
    } finally {
      ws.close();
      await new Promise((r) => upstreamServer.close(() => r()));
      if (probeServer !== undefined) await new Promise((r) => probeServer.close(() => r()));
    }
  });
});
