// actualPorts（cli-hardening 修复 g）：网关实际监听端口回写。
// - store 层：setActualPorts 整体替换 + 修剪死服务；applyCatalog 携带/修剪；旧文件缺字段加载兼容
// - 引擎层：startEngine 物化监听后回写（fake session 工厂，不触原生模块）
// - 命令层：ai-fly test 的端口解析 actualPorts > pin > defaultPort

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyCatalog,
  keyringPath,
  listKeyrings,
  saveKeyring,
  setActualPorts,
  type Keyring,
} from "../../../src/consumer/store.ts";
import { startEngine } from "../../../src/consumer/runtime.ts";
import type { ProviderTransportSession } from "../../../src/consumer/providers.ts";
import type { ServiceEntry } from "../../../src/wire/frames.ts";

const roots: string[] = [];

function freshRoot(): string {
  const root = join(tmpdir(), `aifly-aports-${process.pid}-${roots.length}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

function svc(serviceId: string, defaultPort: number): ServiceEntry {
  return { serviceId, name: serviceId, match: [{ type: "suffix", value: `${serviceId}.test` }], defaultPort };
}

function ring(endpointId: string, services: ServiceEntry[], ports: Record<string, number> = {}, actualPorts: Record<string, number> = {}): Keyring {
  return { alias: endpointId.slice(0, 8), endpointId, relayUrls: [], keys: [], services, ports, actualPorts, disabledServices: [], disabled: false };
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("store: actualPorts", () => {
  it("setActualPorts 整体替换并修剪到存活服务", () => {
    const root = freshRoot();
    saveKeyring(root, ring("ep1111111111", [svc("s1", 4311), svc("s2", 4312)]));
    setActualPorts(root, "ep1111111111", { s1: 4311, s2: 52_000, dead: 9999 });
    const r = listKeyrings(root).rings[0]!;
    expect(r.actualPorts).toEqual({ s1: 4311, s2: 52_000 }); // dead 被修剪
    setActualPorts(root, "ep1111111111", { s1: 4311 });
    expect(listKeyrings(root).rings[0]!.actualPorts).toEqual({ s1: 4311 }); // 整体替换（s2 清除）
  });

  it("applyCatalog 携带并修剪 actualPorts；pin 不受影响", () => {
    const base = ring("ep2222222222", [svc("a", 1), svc("b", 2)], { a: 5000 }, { a: 5000, b: 52_001 });
    const next = applyCatalog(base, { relayUrls: [], services: [svc("a", 1)] }); // b 被删
    expect(next.ports).toEqual({ a: 5000 });
    expect(next.actualPorts).toEqual({ a: 5000 });
  });

  it("旧版 keyring（无 actualPorts 字段）加载得 {} 并可往返", () => {
    const root = freshRoot();
    const dir = join(root, "ep3333333331".slice(0, 8));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      keyringPath(root, "ep3333333331"),
      JSON.stringify({ alias: "old", endpointId: "ep3333333331", relayUrls: [], keys: [], services: [], ports: {} }),
    );
    const r = listKeyrings(root).rings[0]!;
    expect(r.actualPorts).toEqual({});
  });
});

describe("engine: 启动回写实际端口", () => {
  it("startEngine 物化监听后 actualPorts = listenerInfo 实际端口", async () => {
    const root = freshRoot();
    const r = ring("ep4444444441", [svc("s1", 47_141)]);
    saveKeyring(root, r);
    const notices: string[] = [];
    // session 工厂保持 pending（离线态）——仅验证监听物化与回写，不触原生模块
    const pending = (): Promise<ProviderTransportSession> => new Promise(() => {});
    const engine = await startEngine({
      rings: [r],
      consumersRoot: root,
      sessionFactoryFor: () => ({ openSession: pending, shutdown: async () => {} }),
      onNotice: (line) => notices.push(line),
    });
    try {
      const live = engine.gateway.listenerInfo().find((l) => l.serviceId === "s1")!;
      expect(live).toBeDefined();
      const persisted = listKeyrings(root).rings[0]!;
      expect(persisted.actualPorts.s1).toBe(live.port);
    } finally {
      await engine.stop();
    }
  });
});

describe("ai-fly test 端口解析", () => {
  it("actualPorts 优先于 pin 与 defaultPort", async () => {
    const root = freshRoot();
    const r = ring("ep5555555551", [svc("s1", 4399)], { s1: 4500 }, { s1: 53_463 });
    saveKeyring(root, r);
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const { run } = await import("../../../src/cli/commands/consumer/test.ts");
    const code = await run(["--data", root], { homedir: tmpdir() });
    spy.mockRestore();
    expect(code).toBe(1); // 无监听 → failed（fetch refused），退出码 1
    expect(lines.join("")).toContain("POST http://127.0.0.1:53463/"); // actual 命中
  });
});
