// 直接 `ai-fly serve` 的 home 贯穿回归（复核 R3-P1）：CLI serve 入口把已解析
// home 传入 startProviderDaemon——沙盒 HOME 下预设模式脚本在 store 校验与
// engine 运行时（含 watcher reloadStore）都不回退真实 os.homedir()。
// 注入方式：mock provider/serve.ts 的 startProviderDaemon 捕获 opts；run() 的
// 长驻 await 不参与断言（挂起 Promise 随进程收尾）。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/commands/provider/serve.ts";
import { startProviderDaemon, type RunningDaemon } from "../../src/provider/serve.ts";

vi.mock("../../src/provider/serve.ts", async (importOriginal) => {
  return { ...(await importOriginal<typeof import("../../src/provider/serve.ts")>()), startProviderDaemon: vi.fn() };
});

const mocked = vi.mocked(startProviderDaemon);

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aifly-serve-home-"));
  mocked.mockReset();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function fakeDaemon(): RunningDaemon {
  return {
    engine: {} as RunningDaemon["engine"],
    fabric: {} as RunningDaemon["fabric"],
    endpointId: "ep-test",
    fabricIdHex: "00",
    relayUrls: [],
    relayMode: "test",
    banner: "test banner",
    stop: async () => undefined,
  };
}

async function waitForCaptured(ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (mocked.mock.calls.length > 0) return;
    if (Date.now() > deadline) throw new Error("waitForCaptured: timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("ai-fly serve home threading（复核 R3-P1）", () => {
  it("注入 homedir 透传到 startProviderDaemon opts.home", async () => {
    mocked.mockResolvedValue(fakeDaemon());
    const dataDir = join(home, ".aifly", "provider");
    // 长驻命令：不 await（run() 的 await new Promise 永不完成）
    void run(["--data", dataDir], { homedir: home }).catch(() => undefined);
    await waitForCaptured();
    expect(mocked.mock.calls[0]![0]).toMatchObject({ dataDir, home });
  });

  it("缺省 ctx 解析为真实 os.homedir() 并显式传入（与注入路径同语义）", async () => {
    mocked.mockResolvedValue(fakeDaemon());
    void run(["--data", join(home, ".aifly", "provider")], {}).catch(() => undefined);
    await waitForCaptured();
    const { homedir } = await import("node:os");
    expect(mocked.mock.calls[0]![0]).toMatchObject({ home: homedir() });
  });
});
