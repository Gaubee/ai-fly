// 长时 SSE 浸润测试（默认 skip；AIFLY_SOAK=1 启用——真实 5 分钟级时长不进常规门禁）。
//
// 覆盖（用户验收问：长时间 SSE 能否全量传输）：
// - 300s 连续 SSE：上游每 250ms 一个 event（共 1200 个），payload 携带单调 token
// - 中途两次真实断线注入（continuityReset，t≈60s / t≈180s）——本地读循环不重启，
//   依赖内核 auto-resume 原序续传
// - 断言：token 序列恰为 0..N-1（零丢失/零重复/原序）、上游请求执行恰一次、
//   状态机经历 offline（瞬断语义）后回 direct、总时长贴近发流时长（无隐性长停顿）
//
// 运行：AIFLY_SOAK=1 pnpm exec vitest? 不——node --import tsx --test 本文件；
// 或 AIFLY_SOAK=1 pnpm test:e2e（并入 e2e 套件）。
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
const SOAK = process.env.AIFLY_SOAK === "1";
const maybeTest = HAS_CONTINUITY && SOAK ? test : test.skip;

// 浸润参数（真实时长：总 wall ≈ TICK_MS × TICKS + 组网/收尾余量）
const TICK_MS = 250;
const TICKS = 1200; // 300s
const RESET_AT = [60_000, 180_000]; // 两次断线注入时刻（相对首 token）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(p, ms, what) {
  return Promise.race([
    p,
    new Promise((_, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout: ${what}`)), ms);
      t.unref?.();
    }),
  ]);
}

async function waitFor(pred, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(50);
  }
  throw new Error(`waitFor timeout: ${what}`);
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
  const providerDataDir = tmp("aifly-soak-prov-");
  const provider = await Fabric.createRoot({
    dataDir: providerDataDir,
    relay: { mode: "disabled" },
    advertiseAddrs: [`127.0.0.1:${portA}`],
    bindAddr: `127.0.0.1:${portA}`,
  });
  const fabricId = await provider.fabricIdHex();
  const consumer = await Fabric.attach(
    { dataDir: tmp("aifly-soak-cons-"), relay: { mode: "disabled" }, bindAddr: `127.0.0.1:${portB}` },
    fabricId,
  );
  const token = await provider.invite(300_000, null, { allowRelayless: true });
  await consumer.join(token);
  await provider.addKnownAddr(consumer.endpointId, `127.0.0.1:${portB}`);
  return { provider, consumer, providerDataDir };
}

/** 持续 SSE 上游：每 tick 一个 event（token 单调），到量后 end；请求计数即执行次数。 */
async function startSseSoakUpstream() {
  let requests = 0;
  const server = httpServer((req, res) => {
    requests += 1;
    if (req.url !== "/soak") {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    let i = 0;
    const timer = setInterval(() => {
      res.write(`data: token-${i}\n\n`);
      i += 1;
      if (i >= TICKS) {
        clearInterval(timer);
        res.end();
      }
    }, TICK_MS);
    res.on("close", () => clearInterval(timer));
    req.on("close", () => clearInterval(timer));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port, get requests() { return requests; } };
}

maybeTest(`soak: ${TICKS} SSE events over ${(TICK_MS * TICKS / 1000).toFixed(0)}s with 2 mid-stream disconnects — exact, ordered, zero-dup delivery`, async () => {
  const upstream = await startSseSoakUpstream();
  const p = await pair();
  const engineDir = tmp("aifly-soak-engdir-");
  const store = ProviderStore.open(engineDir);
  const svc = store.addService({ name: "soak", upstream: `http://127.0.0.1:${upstream.port}`, match: [{ type: "suffix", value: ".local" }] });
  store.addGroup("soak", ["soak"]);
  const key = store.issueKey("soak");
  const httpMod = await import("@jixo/opendweb-client-sdk/http");
  const serveHttpGlue = /** @type {any} */ (httpMod).serveHttp ?? /** @type {any} */ (httpMod).default?.serveHttp;
  const engine = new ProviderEngine({
    fabric: p.provider,
    store,
    dataDir: engineDir,
    serveHttp: (f, peerId, handler) => serveHttpGlue(f, peerId, handler),
    opts: { timeouts: { connectMs: 2_000, firstByteMs: 10_000, stallMs: 30_000 } },
  });
  await engine.start();
  let stack;
  try {
    // —— 网关/连接装配（镜像 kernel-migration bootStack 的精简版）——
    const root = tmp("aifly-soak-root-");
    const ring = {
      alias: "soak-prov",
      endpointId: p.provider.endpointId,
      relayUrls: [],
      keys: [{ keyId: key.keyId, key: key.key, group: "soak", grantedAt: Date.now() }],
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
    const conn = new ProviderConnection({
      ring,
      root,
      factory: { open: async () => p.consumer, shutdown: async () => undefined },
      onCatalog: (c, updated) => {
        void gateway.syncProviderServices(c.endpointId, updated.alias, updated.services, updated.ports);
      },
      onStateChange: (c) => stateLog.push(c.state),
    });
    connRef = conn;
    await gateway.syncProviderServices(ring.endpointId, ring.alias, [
      { serviceId: svc.serviceId, name: "soak", match: [], defaultPort: 0 },
    ], {});
    conn.start();
    const listener = gateway.listenerInfo().find((l) => l.serviceId === svc.serviceId);
    assert.ok(listener, "gateway listener materialized");
    await waitFor(() => conn.state === "direct" || conn.state === "relay", 45_000, "direct after AUTH");

    // —— 主读循环（不断重启；断线由内核 auto-resume 原序续传）——
    const t0 = Date.now();
    const tokens = [];
    function onToken(n) { tokens.push(n); }
    let readFailed = null;
    const firstTokenSeen = new Promise((resolve) => {
      void (async () => {
        const res = await fetch(`http://127.0.0.1:${listener.port}/soak`, { headers: { accept: "text/event-stream" } });
        assert.equal(res.status, 200);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n\n")) !== -1) {
            const block = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            if (block.startsWith("data: token-")) {
              resolve();
              onToken(Number(block.slice("data: token-".length)));
            }
          }
        }
      })().catch((err) => { readFailed = err; });
    });
    await withTimeout(firstTokenSeen, 20_000, "first SSE token");
    const startedAt = Date.now();

    // —— 断线注入（相对首 token 时刻）——
    for (const at of RESET_AT) {
      const wait = startedAt + at - Date.now();
      if (wait > 0) await sleep(wait);
      await p.consumer.continuityReset(p.provider.endpointId);
    }

    // —— 收尾等全量（发流 300s + 恢复裕量）——
    const deadline = Date.now() + TICK_MS * TICKS + 60_000;
    while (tokens.length < TICKS && readFailed === null) {
      assert(Date.now() < deadline, `未收齐：${tokens.length}/${TICKS}`);
      await sleep(500);
    }
    assert.ok(readFailed === null, `读循环异常：${readFailed}`);
    const elapsedMs = Date.now() - startedAt;

    // —— 断言 ——
    assert.equal(tokens.length, TICKS, `全量到达（${tokens.length}/${TICKS}）`);
    assert.deepEqual(tokens, Array.from({ length: TICKS }, (_, i) => i), "token 序列原序零重复零丢失");
    assert.equal(new Set(tokens).size, TICKS, "去重计数");
    assert.equal(upstream.requests, 1, "上游请求执行恰一次");
    assert.ok(stateLog.includes("offline"), `状态经历瞬断 offline（${[...new Set(stateLog)].join(",")}）`);
    await waitFor(() => conn.state === "direct" || conn.state === "relay", 30_000, "收尾回 direct");
    // 总时长贴近发流时长：两次断线恢复 + 收尾读空的总开销 < 30s
    assert.ok(
      elapsedMs < TICK_MS * TICKS + 30_000,
      `总时长 ${elapsedMs}ms 贴近发流 ${TICK_MS * TICKS}ms（无隐性长停顿）`,
    );
    console.log(`[soak] ${TICKS} tokens / ${(elapsedMs / 1000).toFixed(1)}s（含 2 次断线恢复）· wall ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    await stack?.stop();
    await engine.shutdown();
    await p.provider.shutdown();
    await p.consumer.shutdown();
    await new Promise((r) => upstream.server.close(() => r()));
    rmSync(engineDir, { recursive: true, force: true });
  }
});
