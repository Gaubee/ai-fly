// provider status CLI（hooks-lifecycle 2.3/6.1）：legacy（pre-v2）services.json 的
// 状态面呈现——摘要行 + --verbose 失效服务名册 + 移除路径提示（不新增命令）。
// tmp HOME；fabric 身份缺席走既有降级行（不触网）。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/commands/provider/status.ts";

const lines: string[] = [];
vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
  lines.push(String(chunk));
  return true;
});

const homes: string[] = [];

function freshLegacyHome(): { home: string; data: string } {
  const home = mkdtempSync(join(tmpdir(), `aifly-status-legacy-${process.pid}-${homes.length}`));
  homes.push(home);
  const data = join(home, "provider");
  mkdirSync(data, { recursive: true });
  // v1 形状：无 version 字段 → ProviderStore 进入 legacy 态（空视图 + 名册）
  writeFileSync(
    join(data, "services.json"),
    JSON.stringify({
      revision: 7,
      meta: { alias: "old-host" },
      services: [{ name: "old-a", upstream: "https://a.example.com" }, { name: "old-b", upstream: "https://b.example.com" }],
      groups: [],
      keys: [],
    }),
  );
  return { home, data };
}

afterEach(() => {
  lines.length = 0;
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("ai-fly status（provider，legacy 态）", () => {
  it("摘要行报 legacy 态与移除路径；--verbose 展开失效服务名", async () => {
    const { home, data } = freshLegacyHome();
    expect(await run(["--data", data], { homedir: home })).toBe(0);
    let text = lines.join("");
    expect(text).toContain("legacy  : 2 stale service(s)");
    expect(text).toContain("ai-fly service remove <name>");
    // 名册只在 --verbose 展开
    expect(text).not.toContain("old-a  [legacy]");

    lines.length = 0;
    expect(await run(["--data", data, "--verbose"], { homedir: home })).toBe(0);
    text = lines.join("");
    expect(text).toContain("old-a  [legacy]");
    expect(text).toContain("old-b  [legacy]");
  });
});
