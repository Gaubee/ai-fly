// provider share CLI（hooks-lifecycle 复核 R1-F6）：legacy（pre-v2）store 的
// 门禁前置——invite 是有外部副作用的资源（fabric 配额/中继可达性），必须在
// openExistingFabric/issueInvite 之前拒绝：退出码 1 + 明确文案 + 零组网调用
//（openExistingFabric 未被触达——fabric 变量保持 undefined）。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/commands/provider/share.ts";

const stderrLines: string[] = [];
vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
  stderrLines.push(String(chunk));
  return true;
});
vi.spyOn(process.stdout, "write").mockImplementation(() => true);

const homes: string[] =[];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("provider share：legacy 门禁前置", () => {
  it("v1 store → exit 1 + legacy 文案，且先于 fabric 组网（无 invite 副作用）", async () => {
    const home = mkdtempSync(join(tmpdir(), `aifly-share-legacy-${process.pid}`));
    homes.push(home);
    const data = join(home, "provider");
    mkdirSync(data, { recursive: true });
    writeFileSync(
      join(data, "services.json"),
      JSON.stringify({
        revision: 3,
        services: [{ serviceId: "o1", name: "old-a", upstream: "https://a.example.com", defaultPort: 29001 }],
        groups: [{ name: "g", serviceIds: ["o1"] }],
        keys: [],
      }),
    );

    const exit = await run(["--data", data, "--group", "g"], { homedir: home });
    expect(exit).toBe(1);
    expect(stderrLines.some((l) => l.includes("legacy (pre-v2)"))).toBe(true);
    // 门禁先于 relay 警告（resolvedRelayUrls 在门禁之后才执行——反向证明次序）
    expect(stderrLines.some((l) => l.includes("no relay configured"))).toBe(false);
  });
});
