// services CLI（service-lifecycle）：真实 keyring 存储 + 注入 HOME，stdout 间谍。
// 聚焦子命令契约：list 跨组展示与停用态标注、stop/start/rm 落盘语义、ref/service
// 定位错误面。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/commands/consumer/services.ts";
import { loadKeyring, saveKeyring, type Keyring } from "../../src/consumer/store.ts";
import type { ServiceEntry } from "../../src/wire/frames.ts";

const lines: string[] = [];
const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
  lines.push(String(chunk));
  return true;
});

afterEach(() => {
  lines.length = 0;
});
void writeSpy;

function svc(serviceId: string, name: string, defaultPort: number): ServiceEntry {
  return { serviceId, name, match: [], defaultPort };
}

function ringOf(ep: string, alias: string, services: ServiceEntry[]): Keyring {
  return { alias, endpointId: ep, relayUrls: [], keys: [], services, ports: {}, actualPorts: {}, disabledServices: [] };
}

const homes: string[] = [];

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("ai-fly services", () => {
  it("list：跨组列出 + 停用态标注 + daemon 活性行", async () => {
    const home = mkdtempSync(join(tmpdir(), "aifly-svc-cli-"));
    homes.push(home);
    const data = join(home, "consumers");
    const ringA = { ...ringOf("ep-aaaaaaaa01", "alpha", [svc("svc-a1", "ollama", 11434)]), disabledServices: ["svc-a1"] };
    const ringB = ringOf("ep-bbbbbbbb02", "beta", [svc("svc-b1", "qwen", 8787)]);
    saveKeyring(data, ringA);
    saveKeyring(data, ringB);

    const code = await run(["list", "--data", data], { homedir: home });
    expect(code).toBe(0);
    const text = lines.join("");
    expect(text).toContain("svc-a1");
    expect(text).toContain("disabled");
    expect(text).toContain("svc-b1");
    expect(text).toContain("ready");
    expect(text).toContain("gateway daemon:");
  });

  it("stop/rm/start：落盘停用集合，rm 与 stop 同义，幂等态提示", async () => {
    const home = mkdtempSync(join(tmpdir(), "aifly-svc-cli-"));
    homes.push(home);
    const data = join(home, "consumers");
    const ep = "ep-cccccccc03";
    saveKeyring(data, ringOf(ep, "gamma", [svc("svc-c1", "llama", 8080)]));

    const stopCode = await run(["stop", "gamma", "llama", "--data", data], { homedir: home });
    expect(stopCode).toBe(0);
    expect(lines.join("")).toContain("stopped service 'llama'");
    expect(loadKeyring(data, ep)?.disabledServices).toEqual(["svc-c1"]);

    lines.length = 0;
    const againCode = await run(["rm", "gamma", "svc-c1", "--data", data], { homedir: home });
    expect(againCode).toBe(0);
    expect(lines.join("")).toContain("already disabled");
    expect(loadKeyring(data, ep)?.disabledServices).toEqual(["svc-c1"]); // 未重复追加

    lines.length = 0;
    const startCode = await run(["start", "gamma", "svc-c1", "--data", data], { homedir: home });
    expect(startCode).toBe(0);
    expect(lines.join("")).toContain("started service 'llama'");
    expect(loadKeyring(data, ep)?.disabledServices).toEqual([]);
  });

  it("定位错误面：未知 provider / 未知服务 / 名称歧义", async () => {
    const home = mkdtempSync(join(tmpdir(), "aifly-svc-cli-"));
    homes.push(home);
    const data = join(home, "consumers");
    saveKeyring(data, ringOf("ep-dddddddd04", "delta", [svc("s1", "dup", 1), svc("s2", "dup", 2)]));

    await expect(run(["stop", "no-such", "s1", "--data", data], { homedir: home })).rejects.toThrow(/not found/);
    await expect(run(["stop", "delta", "no-such", "--data", data], { homedir: home })).rejects.toThrow(/unknown service/);
    await expect(run(["stop", "delta", "dup", "--data", data], { homedir: home })).rejects.toThrow(/ambiguous/);
    await expect(run(["stop", "delta", "--data", data], { homedir: home })).rejects.toThrow(/usage:/);
  });
});
