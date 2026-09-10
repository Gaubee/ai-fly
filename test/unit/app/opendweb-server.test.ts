// 自托管 opendweb server 管理器（src/app/opendweb-server.ts）：对账状态机
// （启停/同配置 no-op/配置变化重启/崩溃观测）与 status 投影。假句柄注入，
// 零子进程依赖。

import { describe, expect, it } from "vitest";
import {
  OpendwebServerManager,
  relayUrlOf,
  type OpendwebServerHandle,
} from "../../../src/app/opendweb-server.ts";
import type { OpendwebServerConfig } from "../../../src/shared/rpc-contract.ts";

function makeConfig(patch: Partial<OpendwebServerConfig> = {}): OpendwebServerConfig {
  return {
    enabled: true,
    gatewayBind: "127.0.0.1:8787",
    relayBind: "127.0.0.1:3340",
    relayEnabled: true,
    ...patch,
  };
}

interface FakeRecord {
  handle: OpendwebServerHandle;
  startedAt: number;
  stopCalls: number;
  resolveExit: (code: number) => void;
}

function fakeLauncher() {
  const records: FakeRecord[] = [];
  const start = async (config: OpendwebServerConfig): Promise<OpendwebServerHandle> => {
    const record = {} as FakeRecord;
    let resolveExit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const handle: OpendwebServerHandle = {
      pid: 1000 + records.length,
      gatewayUrl: `http://${config.gatewayBind}`,
      relayHttpUrl: `http://${config.relayBind}`,
      stop: async () => {
        record.stopCalls += 1;
        resolveExit(0);
      },
      exited,
    };
    Object.assign(record, { handle, startedAt: records.length, stopCalls: 0, resolveExit });
    records.push(record);
    return handle;
  };
  return { records, start };
}

describe("OpendwebServerManager.apply 对账", () => {
  it("null / disabled → 停（未跑时 no-op）", async () => {
    const { records } = fakeLauncher();
    const manager = new OpendwebServerManager(records.length === 0 ? async () => {
      throw new Error("unreachable");
    } : undefined);
    await manager.apply(null);
    await manager.apply(makeConfig({ enabled: false }));
    expect(manager.status().running).toBe(false);
    expect(manager.status().config).toBeNull();
  });

  it("enabled → 启动并投影 pid/urls；同配置再 apply = no-op（不重启）", async () => {
    const { records, start } = fakeLauncher();
    const manager = new OpendwebServerManager(start);
    const config = makeConfig();
    await manager.apply(config);
    expect(manager.status()).toMatchObject({
      running: true,
      pid: 1000,
      gatewayUrl: "http://127.0.0.1:8787",
      relayHttpUrl: "http://127.0.0.1:3340",
      config,
    });
    await manager.apply(makeConfig());
    expect(records).toHaveLength(1);
  });

  it("配置变化（relayBind）→ 重启：旧句柄 stop、新 pid", async () => {
    const { records, start } = fakeLauncher();
    const manager = new OpendwebServerManager(start);
    await manager.apply(makeConfig());
    await manager.apply(makeConfig({ relayBind: "127.0.0.1:3341" }));
    expect(records).toHaveLength(2);
    expect(records[0]!.stopCalls).toBe(1);
    expect(manager.status().pid).toBe(1001);
    expect(manager.status().relayHttpUrl).toBe("http://127.0.0.1:3341");
  });

  it("enabled 翻 false → 停；再翻 true → 复启", async () => {
    const { records, start } = fakeLauncher();
    const manager = new OpendwebServerManager(start);
    await manager.apply(makeConfig());
    await manager.apply(makeConfig({ enabled: false }));
    expect(manager.status().running).toBe(false);
    expect(records[0]!.stopCalls).toBe(1);
    await manager.apply(makeConfig());
    expect(manager.status().running).toBe(true);
  });

  it("启动抛错 → running=false + lastError 披露（不抛出）", async () => {
    const manager = new OpendwebServerManager(async () => {
      throw new Error("binary missing");
    });
    await manager.apply(makeConfig());
    expect(manager.status().running).toBe(false);
    expect(manager.status().lastError).toContain("binary missing");
  });

  it("崩溃（exited 非 0）→ running=false + lastError 记退出码", async () => {
    const { records, start } = fakeLauncher();
    const manager = new OpendwebServerManager(start);
    await manager.apply(makeConfig());
    records[0]!.resolveExit(1);
    await records[0]!.handle.exited;
    await Promise.resolve(); // 观测 then 链落定
    expect(manager.status().running).toBe(false);
    expect(manager.status().lastError).toContain("code 1");
  });

  it("主动 stop 后退出码 0 不记 lastError", async () => {
    const { records, start } = fakeLauncher();
    const manager = new OpendwebServerManager(start);
    await manager.apply(makeConfig());
    await manager.stop();
    expect(manager.status().running).toBe(false);
    expect(manager.status().lastError).toBeUndefined();
  });
});

describe("relayUrlOf", () => {
  it("relayBind → http URL（fabric relay 形态）", () => {
    expect(relayUrlOf(makeConfig())).toBe("http://127.0.0.1:3340");
  });
});
