// opendweb-kernel-migration 真内核 e2e（node --import tsx --test）：
// 同进程双 Fabric（createRoot/attach+join+addKnownAddr 固定端口对拨，镜像 SDK
// test/continuity-http.test.mjs 组网）+ 真 serveHttp/fetchHttp 内核 + ai-fly
// ProviderEngine/ProviderConnection/Gateway 产品装配。覆盖（design §6 / tasks 4.x）：
// - T1 AUTH HTTP 化 + 目录 + 网关转发全链路（真内核）
// - T2 SSE 中途断线原序续传（continuityReset 注入，~3s 压缩形态）：零重复 token、
//   上游 exec==1、recovering 不提前 503（在途与新请求均挂起、续传后完成）、
//   状态经 offline（瞬断语义）回 direct
// - T3 provider 重启（RESUME → REQUEST_STATE_LOST）：在途 504（session_lost）、
//   新请求 503 provider_offline（dead 置位瞬间确定性捕获）、会话重建 + 重 AUTH
//   （新 session id）后恢复 200
// - T4 WS keepOpen 隧道三态：active 下行收帧（+终结后上行写）、recovering 挂起
//   不报错、dead/close 关闭码透传
// （本阶段 NAPI 承载面为静态 chunks：101 meta 与响应体在载体终结时一次性下发——
// 交互式 echo 形态不可测，T4 用推送型上游；详见任务报告阻塞项 B1/B2。）
// 所有 Fabric/engine/gateway/upstream 显式回收（finally 钩子）。

import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { createServer as httpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import opendwebModule from "@jixo/opendweb-client-sdk";
import { ProviderEngine } from "../../src/provider/engine.ts";
import { ProviderStore } from "../../src/provider/store.ts";
import { Gateway } from "../../src/consumer/gateway.ts";
import { ProviderConnection } from "../../src/consumer/providers.ts";
import { saveKeyring } from "../../src/consumer/store.ts";

const { Fabric } = /** @type {any} */ (opendwebModule);
const HAS_CONTINUITY = typeof Fabric?.prototype?.openSession === "function";
const maybeTest = HAS_CONTINUITY ? test : test.skip;

const httpMod = await import("@jixo/opendweb-client-sdk/http");
const serveHttpGlue = /** @type {any} */ (httpMod).serveHttp ?? /** @type {any} */ (httpMod).default?.serveHttp;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await pred();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`waitFor timeout: ${what}`);
}

function withTimeout(p, ms, what) {
  return Promise.race([
    p,
    new Promise((_, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout: ${what}`)), ms);
      t.unref?.();
    }),
  ]);
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket("udp4");
    s.bind(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 单进程 pair 组网（provider=root，consumer=attach+join；relay 禁用 + 固定端口对拨）。 */
async function pair() {
  const [portA, portB] = await Promise.all([reservePort(), reservePort()]);
  const providerDataDir = tmp("aifly-e2e-prov-");
  const provider = await Fabric.createRoot({
    dataDir: providerDataDir,
    relay: { mode: "disabled" },
    advertiseAddrs: [`127.0.0.1:${portA}`],
    bindAddr: `127.0.0.1:${portA}`,
  });
  const fabricId = await provider.fabricIdHex();
  const consumer = await Fabric.attach(
    { dataDir: tmp("aifly-e2e-cons-"), relay: { mode: "disabled" }, bindAddr: `127.0.0.1:${portB}` },
    fabricId,
  );
  const token = await provider.invite(300_000, null, { allowRelayless: true });
  await consumer.join(token);
  await provider.addKnownAddr(consumer.endpointId, `127.0.0.1:${portB}`);
  return { provider, consumer, providerDataDir, bind: `127.0.0.1:${portA}` };
}

// ---------------------------------------------------------------------------
// 产品装配
// ---------------------------------------------------------------------------

function makeProviderEngine(fabric, engineDir, upstreamUrl) {
  const store = ProviderStore.open(engineDir);
  const svc =
    store.getServiceByName("e2e") ??
    store.addService({ name: "e2e", upstream: upstreamUrl, match: [{ type: "suffix", value: ".local" }] });
  if (store.getGroup("friends") === undefined) store.addGroup("friends", ["e2e"]);
  const key = store.issueKey("friends");
  const engine = new ProviderEngine({
    fabric,
    store,
    dataDir: engineDir,
    serveHttp: (f, peerId, handler) => serveHttpGlue(f, peerId, handler),
    opts: { timeouts: { connectMs: 2_000, firstByteMs: 10_000, stallMs: 10_000 } },
  });
  return { engine, store, serviceId: svc.serviceId, key };
}

async function bootStack(providerFabric, consumerFabric, key, serviceId, opts = {}) {
  const root = tmp("aifly-e2e-root-");
  const ring = {
    alias: "prov",
    endpointId: providerFabric.endpointId,
    relayUrls: [],
    keys: [{ keyId: key.keyId, key: key.key, group: "friends", grantedAt: Date.now() }],
    services: [],
    ports: {},
    actualPorts: {},
    disabledServices: [],
    disabled: false,
  };
  saveKeyring(root, ring);
  let connRef;
  const gateway = new Gateway({ resolveRoute: () => connRef });
  const stateLog = [];
  const offline503 = { threw: false, code: undefined };
  const conn = new ProviderConnection({
    ring,
    root,
    factory: { open: async () => consumerFabric, shutdown: async () => undefined },
    onCatalog: (c, updated) => {
      void gateway.syncProviderServices(c.endpointId, updated.alias, updated.services, updated.ports);
    },
    onStateChange: (c) => {
      stateLog.push(c.state);
      // dead 确定性窗口：offline（终态）置位瞬间会话已摘除、重建尚未启动——
      // 此时新请求必 503 provider_offline（onStateChange 同步先于 ensureSession）
      if (c.state === "offline" && opts.captureOffline503 === true) {
        try {
          c.forward({ serviceId, method: "GET", path: "/probe", body: new Uint8Array(0), upgrade: false }, {
            onMeta: () => undefined,
            onChunk: () => undefined,
            onEnd: () => undefined,
            onError: () => undefined,
            onWsData: () => undefined,
            onWsClose: () => undefined,
            onTerminate: () => undefined,
          });
        } catch (err) {
          offline503.threw = true;
          offline503.code = /** @type {any} */ (err).code;
        }
      }
    },
  });
  connRef = conn;
  // 先物化监听（离线 503 语义），再启动连接（AUTH 后目录再同步刷新）
  await gateway.syncProviderServices(ring.endpointId, ring.alias, [
    { serviceId, name: "e2e", match: [], defaultPort: 0 },
  ], {});
  conn.start();
  const listener = gateway.listenerInfo().find((l) => l.serviceId === serviceId);
  assert.ok(listener, "gateway listener materialized");
  // 相位采样（25ms——内核事件泵 100ms 粒度可能错过快速 recovering 窗口；连接
  // 相位每秒采样——重连退避观测）
  const phases = [];
  const connPhases = [];
  const sampler = setInterval(() => {
    const s = /** @type {any} */ (conn).session;
    if (s !== null && s !== undefined) void s.state().then((snap) => phases.push(snap.phase)).catch(() => undefined);
  }, 25);
  sampler.unref?.();
  const connSampler = setInterval(() => {
    void consumerFabric.continuitySnapshot(providerFabric.endpointId).then((snap) => connPhases.push(snap.phase)).catch(() => undefined);
  }, 1_000);
  connSampler.unref?.();
  return {
    root,
    gateway,
    conn,
    stateLog,
    phases,
    connPhases,
    offline503,
    port: listener.port,
    async stop() {
      clearInterval(sampler);
      clearInterval(connSampler);
      await conn.stop();
      await gateway.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// T1：AUTH HTTP 化 + 目录 + 网关转发（真内核全链路）
// ---------------------------------------------------------------------------

maybeTest("kernel e2e: AUTH + catalog + gateway forward over real fabric", async () => {
  const upstream = await startEchoUpstream();
  const p = await pair();
  const engineDir = tmp("aifly-e2e-engdir-");
  const { engine, serviceId, key } = makeProviderEngine(p.provider, engineDir, `http://127.0.0.1:${upstream.port}`);
  await engine.start();
  let stack;
  try {
    stack = await bootStack(p.provider, p.consumer, key, serviceId);
    await waitFor(() => stack.conn.state === "direct" || stack.conn.state === "relay", 45_000, "direct after AUTH");
    const res = await withTimeout(
      fetch(`http://127.0.0.1:${stack.port}/v1/echo?x=1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"q":"kernel"}',
      }),
      20_000,
      "gateway forward",
    );
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.path, "/v1/echo?x=1");
    assert.equal(payload.body, '{"q":"kernel"}');
    assert.ok(stack.conn.servedCount >= 1);
  } finally {
    await stack?.stop();
    await engine.shutdown();
    await p.provider.shutdown();
    await p.consumer.shutdown();
    await closeServer(upstream.server);
    rmSync(engineDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T2：SSE 中途断线原序续传
// ---------------------------------------------------------------------------

maybeTest("kernel e2e: SSE mid-stream continuityReset — ordered resume, zero dup tokens, upstream exec==1", async () => {
  const TOKENS = 14;
  const TICK_MS = 200;
  let exec = 0;
  const upstream = await startSseUpstream({
    tokens: TOKENS,
    tickMs: TICK_MS,
    onExec: () => (exec += 1),
  });
  const p = await pair();
  const engineDir = tmp("aifly-e2e-engdir-");
  const { engine, serviceId, key } = makeProviderEngine(p.provider, engineDir, `http://127.0.0.1:${upstream.port}`);
  await engine.start();
  let stack;
  try {
    stack = await bootStack(p.provider, p.consumer, key, serviceId);
    await waitFor(() => stack.conn.state === "direct" || stack.conn.state === "relay", 45_000, "direct after AUTH");

    // 在途 SSE 请求（读循环不重启；载体在 handler 完成后一次性下发——断言语义
    // 不变：字节级精确 + 零重复 + exec==1）
    const resPromise = withTimeout(
      fetch(`http://127.0.0.1:${stack.port}/sse`, { headers: { accept: "text/event-stream" } }),
      30_000,
      "sse response head",
    );
    const firstArrived = new Promise((resolve) => (upstream.onFirstToken = resolve));
    await withTimeout(firstArrived, 10_000, "first sse token at provider");

    // 断线窗口穿越流：/slow 已建立（reset 前发起并到达上游、响应延迟到恢复
    // 窗口之后）——在途挂起、恢复后经 journal 重放原序完成（design §2）
    const slowArrived = new Promise((resolve) => (upstream.onSlowArrived = resolve));
    const slowPromise = withTimeout(
      fetch(`http://127.0.0.1:${stack.port}/slow`, { method: "POST", body: "cross-window" }),
      30_000,
      "cross-window request",
    );
    await withTimeout(slowArrived, 10_000, "cross-window request established at provider");

    await p.consumer.continuityReset(p.provider.endpointId);
    // 相位证据：采样器/状态机其一观察到 recovering（快速恢复窗口下事件泵可能错过）
    await waitFor(
      () => stack.phases.includes("recovering") || stack.stateLog.includes("offline"),
      10_000,
      "recovering observed",
    );

    // recovering 期间的新请求：不提前 503（内核 B4 缺陷下 open_stream 可能
    // 504——断言收紧为「绝非 503 provider_offline」；快恢复时通常 200）
    const probePromise = fetch(`http://127.0.0.1:${stack.port}/slow`, { method: "POST", body: "probe" }).catch(
      () => null,
    );

    const res = await resPromise;
    assert.equal(res.status, 200);
    const text = await withTimeout(res.text(), 30_000, "sse body");
    const tokens = parseSseTokens(text);
    assert.deepEqual(tokens, Array.from({ length: TOKENS }, (_, i) => i), "token 序列原序");
    assert.equal(new Set(tokens).size, TOKENS, "零重复 token");

    // 断线窗口穿越请求在续传后完成（在途挂起语义）
    const res2 = await slowPromise;
    assert.equal(res2.status, 200);
    assert.equal(await res2.text(), "slow-ok");

    // recovering 探针：绝非 503（快恢复下 200；内核 B4 下可能 504）
    const probe = await withTimeout(probePromise, 30_000, "probe during recovery");
    if (probe !== null) {
      await probe.text();
      assert.notEqual(probe.status, 503, "recovering 期间不提前 503 provider_offline");
    }

    // 上游副作用恰好一次 + 状态回 direct
    await waitFor(() => exec >= 1, 5_000, "upstream exec recorded");
    assert.equal(exec, 1, "upstream request executed exactly once");
    await waitFor(() => stack.conn.state === "direct" || stack.conn.state === "relay", 10_000, "back to direct");
    const resumed = stack.phases.includes("active");
    assert.ok(resumed, `恢复后相位 active（采样 ${stack.phases.join(",")}）`);
  } finally {
    await stack?.stop();
    await engine.shutdown();
    await p.provider.shutdown();
    await p.consumer.shutdown();
    await closeServer(upstream.server);
    rmSync(engineDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T3：provider 重启 → REQUEST_STATE_LOST → 在途 504 / 新请求 503 → 重建重 AUTH
// ---------------------------------------------------------------------------

maybeTest("kernel e2e: provider restart (REQUEST_STATE_LOST) — in-flight 504, new-request 503, rebuild + re-AUTH", async () => {
  const upstream = await startGatedUpstream(); // 永不响应（在途请求制造）
  const echo = await startEchoUpstream(); // 重启后验证恢复用
  const p = await pair();
  const engineDir = tmp("aifly-e2e-engdir-");
  const made = makeProviderEngine(p.provider, engineDir, `http://127.0.0.1:${upstream.port}`);
  const { engine, key } = made;
  const serviceId = made.serviceId;
  // 第二服务（echo）：重启后恢复验证（catalog 经 AUTH 进入网关）
  made.store.addService({ name: "echo", upstream: `http://127.0.0.1:${echo.port}`, match: [{ type: "suffix", value: ".local" }] });
  made.store.setGroupServices("friends", ["e2e", "echo"]);
  await engine.start();
  let stack;
  let engine2;
  let provider2;
  try {
    stack = await bootStack(p.provider, p.consumer, key, serviceId, { captureOffline503: true });
    await waitFor(() => stack.conn.state === "direct" || stack.conn.state === "relay", 45_000, "direct after AUTH");
    const firstSessionId = currentSessionId(stack.conn);

    // 在途请求（上游 gated，响应头未到达）。Dead 到位时序：内核连接管理器
    // 重连退避（1s..30s 封顶）+ RESUME 拒绝——窗口放宽到 60s。
    const inflight = withTimeout(
      fetch(`http://127.0.0.1:${stack.port}/gated`, { method: "POST", body: "inflight" }),
      60_000,
      "in-flight response",
    );

    // 注入断连 + provider 重启（内核会话注册表随进程态丢失）。注意：这里只
    // 关闭 fabric（serve 任务随内核 abort、未决 handler 被丢弃）——不走
    // engine.shutdown() 的 server.close()：SDK /http 胶水对 close 后完成的
    // handler 结算会同步抛 [session] unknown request id（未捕获拒绝；已记录
    // 为 SDK 缺陷，ai-fly 侧以不触发路径规避）。
    await p.consumer.continuityReset(p.provider.endpointId);
    await p.provider.shutdown();

    // 重启：同 dataDir 新 Fabric（新 bind 端口——旧 QUIC 端口释放有竞态；消费端
    // 经 addKnownAddr 重新会合）+ 新引擎 → 消费端 RESUME 被 REQUEST_STATE_LOST
    // 拒绝 → 会话 Dead
    const restartPort = await reservePort();
    const restartBind = `127.0.0.1:${restartPort}`;
    provider2 = await Fabric.open({
      dataDir: p.providerDataDir,
      relay: { mode: "disabled" },
      advertiseAddrs: [restartBind],
      bindAddr: restartBind,
    });
    await p.consumer.addKnownAddr(p.provider.endpointId, restartBind);
    const second = makeProviderEngine(provider2, engineDir, `http://127.0.0.1:${upstream.port}`);
    engine2 = second.engine;
    await engine2.start();

    // 在途请求：会话 Dead 终结 → 504 session_lost（确定错误）
    const res = await inflight;
    assert.equal(res.status, 504);
    const errBody = await res.json();
    assert.equal(errBody.error.code, "session_lost");

    // 新请求 503 provider_offline：dead 置位瞬间（onStateChange 窗口）确定性捕获
    await waitFor(
      () => stack.offline503.threw === true,
      60_000,
      `offline window captured provider_offline (states=${stack.stateLog.join(",")} phases=[${stack.phases.slice(-6).join(",")}] conn=${stack.connPhases.join(",")})`,
    );
    assert.equal(stack.offline503.code, "provider_offline");

    // 会话重建 + 重 AUTH（新 session id）后恢复可用
    await waitFor(() => stack.conn.state === "direct" || stack.conn.state === "relay", 60_000, "rebuilt to direct");
    assert.notEqual(currentSessionId(stack.conn), firstSessionId, "新会话（新 session id）");
    // echo 服务（重启后 catalog 经新 AUTH 刷新）验证转发面恢复
    const echoListener = await waitFor(
      () => stack.gateway.listenerInfo().find((l) => l.name === "echo"),
      20_000,
      `echo listener after re-AUTH (listeners=${stack.gateway.listenerInfo().map((l) => l.name).join(",")} state=${stack.conn.state} keys=${stack.conn.keys.length} services=${stack.conn.services.map((s) => s.serviceId).join(",")})`,
    );
    const ok = await withTimeout(
      fetch(`http://127.0.0.1:${echoListener.port}/v1/echo`, { method: "POST", body: "after-restart" }),
      30_000,
      "forward after restart",
    );
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).body, "after-restart");
    assert.ok(stack.conn.servedCount >= 2);
  } finally {
    await stack?.stop();
    await provider2?.shutdown().catch(() => undefined);
    await p.provider.shutdown().catch(() => undefined);
    await p.consumer.shutdown();
    await closeServer(upstream.server);
    await closeServer(echo.server);
    rmSync(engineDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T4：WS keepOpen 隧道三态（推送型上游——静态 chunks 阶段交互式 echo 不可测）
// ---------------------------------------------------------------------------

maybeTest("kernel e2e: WS keepOpen tunnel — active receive, recovering hang, close code passthrough", async () => {
  const FRAMES = 6;
  const upstream = await startWsPushUpstream({ frames: FRAMES, tickMs: 250 });
  const p = await pair();
  const engineDir = tmp("aifly-e2e-engdir-");
  const { engine, serviceId, key } = makeProviderEngine(p.provider, engineDir, `http://127.0.0.1:${upstream.port}`);
  await engine.start();
  let stack;
  try {
    stack = await bootStack(p.provider, p.consumer, key, serviceId);
    await waitFor(() => stack.conn.state === "direct" || stack.conn.state === "relay", 45_000, "direct after AUTH");

    const events = [];
    const handle = stack.conn.forward(
      {
        serviceId,
        method: "GET",
        path: "/ws",
        headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "aWZseS1rZXk=" },
        upgrade: true,
        body: new Uint8Array(0),
      },
      {
        onMeta: (h) => events.push(`meta:${h.status}`),
        onChunk: () => events.push("chunk"),
        onEnd: () => events.push("end"),
        onError: (h) => events.push(`error:${h.code}`),
        onWsData: (b) => events.push(`ws:${Buffer.from(b).toString("utf8")}`),
        onWsClose: (code) => events.push(`wsclose:${code}`),
        onTerminate: (c) => events.push(`terminate:${c.source}`),
      },
    );

    // active：上游推送进行中（meta 101 待载体终结下发——挂起即 active 收帧窗口）
    await waitFor(() => upstream.sent >= 2, 10_000, `upstream pushing frames (events=${events.join(",")} upgrades=${upstream.upgrades} state=${stack.conn.state})`);

    // recovering：注入连接死亡——隧道挂起不报错（无 error 事件直达；快速恢复
    // 窗口下事件泵可能错过相位，以采样器/状态机其一为准）
    await p.consumer.continuityReset(p.provider.endpointId);
    await waitFor(
      () => stack.phases.includes("recovering") || stack.stateLog.includes("offline"),
      10_000,
      "recovering observed",
    );
    await sleep(300);
    assert.ok(!events.some((e) => e.startsWith("error:")), `recovering 期间不提前报错（${events.join(",")}）`);

    // 续传后上游继续推送并关闭（1000）→ 载体终结：101 + 全部下行帧 + 关闭码
    await waitFor(() => events.some((e) => e.startsWith("wsclose:")), 30_000, "ws close delivered");
    assert.ok(events.includes("meta:101"), `101 meta（${events.join(",")}）`);
    const down = events.filter((e) => e.startsWith("ws:")).map((e) => e.slice(3));
    assert.deepEqual(down, Array.from({ length: FRAMES }, (_, i) => `push-${i}`), "下行帧字节序（含 recovering 后续传段）");
    assert.ok(events.includes("wsclose:1000"), `关闭码 1000 透传（${events.join(",")}）`);
    assert.ok(events.includes("terminate:peer"), "终结 peer 语义");
    // 终结后上行写仍可结算（keepOpen 请求方向未半关；上游已关由 provider 侧丢弃）
    await handle.sendData(Buffer.from("post-close-up"));
    assert.equal(upstream.upgrades, 1, "上游 WS 会话恰好一次");
  } finally {
    await stack?.stop();
    await engine.shutdown();
    await p.provider.shutdown();
    await p.consumer.shutdown();
    await closeServer(upstream.server);
    rmSync(engineDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// upstream 假体
// ---------------------------------------------------------------------------

async function startEchoUpstream() {
  const server = httpServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: req.url, body: Buffer.concat(chunks).toString() }));
    });
  });
  await listen(server);
  return { server, port: portOf(server) };
}

async function startSseUpstream({ tokens, tickMs, onExec, slowMs = 2_500 }) {
  let exec = 0;
  let onFirstToken = () => undefined;
  let onSlowArrived = () => undefined;
  const server = httpServer((req, res) => {
    if (req.url === "/sse") {
      exec += 1;
      onExec?.();
      res.writeHead(200, { "content-type": "text/event-stream" });
      let i = 0;
      const timer = setInterval(() => {
        res.write(`data: token-${String(i).padStart(2, "0")}\n\n`);
        if (i === 0) onFirstToken();
        i += 1;
        if (i >= tokens) {
          clearInterval(timer);
          res.end();
        }
      }, tickMs);
      req.on("close", () => clearInterval(timer));
      return;
    }
    if (req.url === "/slow") {
      // 断线窗口穿越用：响应延迟到恢复窗口之后（已建立流的 journal 重放语义）
      onSlowArrived();
      res.writeHead(200, { "content-type": "text/plain" });
      setTimeout(() => res.end("slow-ok"), slowMs);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("fast-ok");
  });
  await listen(server);
  return {
    server,
    port: portOf(server),
    get exec() {
      return exec;
    },
    set onFirstToken(v) {
      onFirstToken = v;
    },
    set onSlowArrived(v) {
      onSlowArrived = v;
    },
  };
}

async function startGatedUpstream() {
  const server = httpServer((_req, res) => {
    // 永不响应（在途请求制造；测试结束随 server.close 销毁）
    void res;
  });
  await listen(server);
  return { server, port: portOf(server) };
}

async function startWsPushUpstream({ frames, tickMs }) {
  const { WebSocketServer } = await import("ws");
  let upgrades = 0;
  let sent = 0;
  const sockets = new Set();
  const server = httpServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    upgrades += 1;
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      let i = 0;
      const timer = setInterval(() => {
        ws.send(`push-${i}`);
        sent += 1;
        i += 1;
        if (i >= frames) {
          clearInterval(timer);
          ws.close(1000);
        }
      }, tickMs);
      ws.on("close", () => {
        clearInterval(timer);
        sockets.delete(ws);
      });
    });
  });
  await listen(server);
  return { server, wss, port: portOf(server), get sent() { return sent; }, get upgrades() { return upgrades; } };
}

function parseSseTokens(text) {
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => Number(block.slice("data: token-".length)));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function portOf(server) {
  return server.address().port;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function currentSessionId(conn) {
  return /** @type {any} */ (conn).session?.sessionId ?? null;
}
