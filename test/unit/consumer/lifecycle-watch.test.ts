// lifecycle-watch 单测（service-lifecycle 1.3）：keyring.json 外部变更（CLI 独立
// 进程语义）→ daemon watch 去抖 → 网关停用/启用全量重放；轮询兜底与停止清理。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceEntry } from "../../../src/wire/frames.ts";
import { Gateway } from "../../../src/consumer/gateway.ts";
import { saveKeyring, setProviderEnabled, setServiceEnabled, type Keyring } from "../../../src/consumer/store.ts";
import { watchServiceLifecycle } from "../../../src/consumer/lifecycle-watch.ts";
import type { ProviderRoute, ProviderStateKind } from "../../../src/consumer/providers.ts";

class FakeRoute implements ProviderRoute {
  alias = "prov";
  state: ProviderStateKind = "direct";
  overflows = 0;
  forward(): never {
    throw new Error("not used in this test");
  }
  noteBufferOverflow(): void {
    this.overflows += 1;
  }
}

function svc(serviceId: string, defaultPort: number): ServiceEntry {
  return { serviceId, name: serviceId, match: [], defaultPort };
}

function ringOf(ep: string, services: ServiceEntry[]): Keyring {
  return { alias: "prov", endpointId: ep, relayUrls: [], keys: [], services, ports: {}, actualPorts: {}, disabledServices: [], disabled: false };
}

const roots: string[] = [];
const gateways: Gateway[] = [];

afterEach(() => {
  for (const g of gateways.splice(0)) void g.stop();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("watchServiceLifecycle（keyring 外部变更 → 网关热重放）", () => {
  it("外部停用/启用经 watch 传导；停止后不再响应", async () => {
    const root = mkdtempSync(join(tmpdir(), "aifly-lc-"));
    roots.push(root);
    const ep = "ep-lifecycle-watch-01";
    const ring = ringOf(ep, [svc("svc-a", 11434), svc("svc-b", 8787)]);
    saveKeyring(root, ring);

    const route = new FakeRoute();
    const gateway = new Gateway({ resolveRoute: () => route });
    gateways.push(gateway);
    await gateway.syncProviderServices(ep, route.alias, ring.services, ring.ports);
    expect(gateway.listenerInfo()).toHaveLength(2);

    const watch = watchServiceLifecycle({ root, rings: [ring], gateway, debounceMs: 30, pollMs: 500 });

    // 外部进程语义：直接写盘停用 svc-a
    setServiceEnabled(root, ep, "svc-a", false);
    await vi.waitFor(() => {
      expect(gateway.listenerInfo().map((l) => l.serviceId).sort()).toEqual(["svc-b"]);
    }, { timeout: 3000 });

    // 重新启用：恢复（端口偏好空 → defaultPort）
    setServiceEnabled(root, ep, "svc-a", true);
    await vi.waitFor(() => {
      expect(gateway.listenerInfo()).toHaveLength(2);
    }, { timeout: 3000 });

    // stop 后文件再变也不响应
    watch.stop();
    setServiceEnabled(root, ep, "svc-b", false);
    await new Promise((r) => setTimeout(r, 400));
    expect(gateway.listenerInfo().map((l) => l.serviceId).sort()).toEqual(["svc-a", "svc-b"]);
  });

  it("环级停用：外部 setProviderEnabled 传导全部监听关；恢复时单服务停用保持", async () => {
    const root = mkdtempSync(join(tmpdir(), "aifly-lc-"));
    roots.push(root);
    const ep = "ep-lifecycle-watch-03";
    let ring = ringOf(ep, [svc("svc-a", 11434), svc("svc-b", 8787)]);
    ring.disabledServices = ["svc-a"];
    saveKeyring(root, ring);

    const route = new FakeRoute();
    const gateway = new Gateway({ resolveRoute: () => route });
    gateways.push(gateway);
    await gateway.syncProviderServices(ep, route.alias, [svc("svc-b", 8787)], ring.ports);
    expect(gateway.listenerInfo().map((l) => l.serviceId)).toEqual(["svc-b"]);

    watchServiceLifecycle({ root, rings: [ring], gateway, debounceMs: 30, pollMs: 500 });
    setProviderEnabled(root, ep, false);
    await vi.waitFor(() => {
      expect(gateway.listenerInfo()).toHaveLength(0);
    }, { timeout: 3000 });

    setProviderEnabled(root, ep, true);
    await vi.waitFor(() => {
      expect(gateway.listenerInfo().map((l) => l.serviceId)).toEqual(["svc-b"]); // svc-a 单服务停用保持
    }, { timeout: 3000 });
  });

  it("目录全量替换后 disabled 仍生效（可复活语义的网关侧闭环）", async () => {
    const root = mkdtempSync(join(tmpdir(), "aifly-lc-"));
    roots.push(root);
    const ep = "ep-lifecycle-watch-02";
    let ring = ringOf(ep, [svc("svc-a", 11434)]);
    ring.disabledServices = ["svc-a"];
    saveKeyring(root, ring);

    const route = new FakeRoute();
    const gateway = new Gateway({ resolveRoute: () => route });
    gateways.push(gateway);
    // daemon 启动物化：disabled 过滤（runtime 语义——本测试直接模拟过滤后视图）
    await gateway.syncProviderServices(ep, route.alias, [], ring.ports);
    expect(gateway.listenerInfo()).toHaveLength(0);

    watchServiceLifecycle({ root, rings: [ring], gateway, debounceMs: 30, pollMs: 500 });
    // 外部启用 → 目录条目仍在（applyCatalog 保留），重放恢复监听
    setServiceEnabled(root, ep, "svc-a", true);
    await vi.waitFor(() => {
      expect(gateway.listenerInfo().map((l) => l.serviceId)).toEqual(["svc-a"]);
    }, { timeout: 3000 });
  });
});
