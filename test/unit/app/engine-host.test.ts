// engine-host 单测：注入 fake provider daemon / fabric factory（不触原生 SDK 与
// 网络），验证幂等开关、事件桥（fabric 事件 → notify、存储 revision 轮询 →
// notify）、requireProviderDaemon 错误边界；settings 持久化一并覆盖。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Fabric, FabricOptions } from "@jixo/opendweb-client-sdk";
import { EngineHost, type NotifyEvent } from "../../../src/app/engine-host.ts";
import type { RunningDaemon } from "../../../src/provider/serve.ts";
import { ProviderStore } from "../../../src/provider/store.ts";
import type { FabricEventLike, FabricFactory, FabricLike } from "../../../src/consumer/providers.ts";
import { DomainError } from "../../../src/app/errors.ts";
import { loadSettings, saveSettings, settingsPath } from "../../../src/app/settings.ts";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

let base: string;
let events: NotifyEvent[];
let host: EngineHost;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "aifly-host-"));
  events = [];
  host = new EngineHost({
    home: base,
    providerDataDir: join(base, "provider"),
    consumersRoot: join(base, "consumers"),
    notify: (event) => events.push(event),
    pollMs: 10,
  });
});

afterEach(async () => {
  await host.stop();
  rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fake daemon / fabric
// ---------------------------------------------------------------------------

/** SDK Fabric 事件联合（engine 订阅面；含 roster/relay 事件）。 */
type SdkFabricEvent = Parameters<Parameters<Fabric["on"]>[0]>[0];

function makeFakeFabric(): Fabric & { emit(event: SdkFabricEvent): void } {
  const listeners = new Set<(event: SdkFabricEvent) => void>();
  const fabric = {
    endpointId: "endpoint-fake-0001",
    async invite() {
      return "dweb1.fake-invite";
    },
    async relayStatus() {
      return { mode: "default", urls: ["https://relay.example"], online: true };
    },
    on(callback: (event: SdkFabricEvent) => void) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    async shutdown() {
      // 测试假体：无资源
    },
    emit(event: SdkFabricEvent) {
      for (const listener of listeners) listener(event);
    },
  };
  return fabric as unknown as Fabric & { emit(event: FabricEventLike): void };
}

function installFakeDaemon(): {
  fabric: ReturnType<typeof makeFakeFabric>;
  daemon: RunningDaemon;
} {
  const fabric = makeFakeFabric();
  const store = ProviderStore.open(join(base, "provider"));
  const engine = {
    store,
    sessionCount: () => 0,
    alias: () => "tester",
    shutdown: async () => undefined,
  } as unknown as RunningDaemon["engine"];
  const daemon: RunningDaemon = {
    engine,
    fabric,
    endpointId: fabric.endpointId,
    fabricIdHex: "abcd",
    relayUrls: ["https://relay.example"],
    relayMode: "default",
    banner: "",
    stop: async () => undefined,
  };
  host = new EngineHost({
    home: base,
    providerDataDir: join(base, "provider"),
    consumersRoot: join(base, "consumers"),
    notify: (event) => events.push(event),
    pollMs: 10,
    startProviderDaemonImpl: async () => daemon,
    fabricFactory: {} as FabricFactory, // 不触真实 SDK
  });
  return { fabric, daemon };
}

// ---------------------------------------------------------------------------
// provider daemon 开关与事件桥
// ---------------------------------------------------------------------------

describe("EngineHost provider daemon", () => {
  it("start/stop are idempotent and emit notify events", async () => {
    const { daemon } = installFakeDaemon();
    await host.startProvider();
    await host.startProvider(); // 幂等
    expect(host.isProviderRunning()).toBe(true);
    expect(host.runningProviderDaemon()).toBe(daemon);

    await host.stopProvider();
    await host.stopProvider(); // 幂等
    expect(host.isProviderRunning()).toBe(false);

    const types = events.map((e) => e.type);
    expect(types).toContain("provider-daemon");
    const start = events.find((e) => e.type === "provider-daemon" && e.payload["running"] === true);
    const stop = events.find((e) => e.type === "provider-daemon" && e.payload["running"] === false);
    expect(start).toBeDefined();
    expect(stop).toBeDefined();
  });

  it("requires a running daemon for fabric-dependent operations", () => {
    expect(() => host.requireProviderDaemon()).toThrowError(DomainError);
  });

  it("bridges fabric events to notify", async () => {
    const { fabric } = installFakeDaemon();
    await host.startProvider();
    fabric.emit({ type: "peer-connected", endpointId: "peer-1" });
    fabric.emit({ type: "peer-disconnected", endpointId: "peer-1" });
    fabric.emit({
      type: "relay-offline",
      relay: {
        mode: "n0",
        urls: ["https://relay.example"],
        online: false,
        lastError: "",
        activeUrl: "",
      },
    } satisfies SdkFabricEvent & { relay: { lastError?: string; activeUrl?: string } });
    fabric.emit({ type: "roster-updated" });
    const sessionEvents = events.filter((e) => e.type === "provider-session");
    expect(sessionEvents).toHaveLength(2);
    expect(sessionEvents[0]!.payload).toEqual({ peerId: "peer-1", connected: true });
    expect(events.some((e) => e.type === "provider-relay")).toBe(true);
    expect(events.some((e) => e.type === "provider-roster")).toBe(true);
  });

  it("bridges provider store revisions via polling", async () => {
    installFakeDaemon();
    await host.startProvider();
    host.providerStore().addService({
      name: "svc",
      upstream: "https://api.example.com/v1",
      match: [{ type: "suffix", value: "api.example.com" }],
      defaultPort: 8901,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events.some((e) => e.type === "provider-store")).toBe(true);
  });

  it("stop() tears down everything (idempotent full shutdown)", async () => {
    installFakeDaemon();
    await host.startProvider();
    await host.stop();
    await host.stop();
    expect(host.isProviderRunning()).toBe(false);
    expect(host.isGatewayRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 消费侧兜底（无 fake 注入时不开真实网关）
// ---------------------------------------------------------------------------

describe("EngineHost consumer surface (no engine started)", () => {
  it("exposes null engine and resolves a factory from the injected provider", async () => {
    const factory: FabricFactory = {
      open: async (opts: { dataDir: string; relayUrls?: string[] }) =>
        ({ ...(await Promise.resolve({})), ...opts } as unknown as FabricLike),
      joinWithToken: async () => ({}) as FabricLike,
    };
    host = new EngineHost({
      home: base,
      providerDataDir: join(base, "provider"),
      consumersRoot: join(base, "consumers"),
      notify: (event) => events.push(event),
      fabricFactory: factory,
    });
    expect(host.consumerEngine()).toBeNull();
    const resolved = await host.resolveFabricFactory();
    expect(resolved).toBe(factory); // 缓存复用
    expect(await host.resolveFabricFactory()).toBe(factory);
  });
});

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

describe("settings persistence", () => {
  it("returns defaults when no file exists", () => {
    const settings = loadSettings(base);
    expect(settings).toEqual({ theme: "system", modelsDevEnabled: true, relayUrls: null, opendwebServer: null });
  });

  it("saves patches without touching unsubmitted fields", () => {
    const first = saveSettings({ theme: "dark" }, base);
    expect(first.theme).toBe("dark");
    expect(first.modelsDevEnabled).toBe(true);
    const second = saveSettings({ modelsDevEnabled: false, relayUrls: ["https://r.example"] }, base);
    expect(second.theme).toBe("dark");
    expect(second.modelsDevEnabled).toBe(false);
    expect(second.relayUrls).toEqual(["https://r.example"]);
    // 回读一致
    expect(loadSettings(base)).toEqual(second);
  });

  it("falls back to defaults on a corrupt file", () => {
    mkdirSync(join(base, ".aifly"), { recursive: true });
    writeFileSync(settingsPath(base), "{corrupt");
    expect(loadSettings(base).theme).toBe("system");
  });

  it("round-trips through the contract schema (zod parse of the file on disk)", () => {
    saveSettings({ theme: "light" }, base);
    const raw = JSON.parse(readFileSync(settingsPath(base), "utf8")) as unknown;
    const schema = z.object({
      theme: z.enum(["dark", "light", "system"]),
      modelsDevEnabled: z.boolean(),
      relayUrls: z.array(z.string()).nullable(),
    });
    expect(schema.parse(raw)).toBeTruthy();
  });
});
