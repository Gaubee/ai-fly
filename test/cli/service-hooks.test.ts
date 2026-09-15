// service add --hooks（预设模式，rust-fetch-sidecar 变更）CLI 面：
// - 整段绑定落库 + humanize 呈现（add 摘要 / get）
// - 与逐槽旗标互斥 → 退出码 2（UsageError）
// - 绑定无阶段导出的脚本 → 错误退出
// tmp HOME（内建 codex 脚本现含 ①②③ 导出——预设模式合法目标）。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/commands/provider/service.ts";

const out: string[] = [];
vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
  out.push(String(chunk));
  return true;
});
const errOut: string[] = [];
vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
  errOut.push(String(chunk));
  return true;
});

const homes: string[] = [];

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), `aifly-svc-hooks-${process.pid}-${homes.length}`));
  homes.push(home);
  return home;
}

afterEach(() => {
  out.length = 0;
  errOut.length = 0;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("service add --hooks（预设模式）", () => {
  it("整段绑定：落库 hooks 槽 + add/get humanize 呈现 preset mode", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    const code = await run(
      ["add", "codex-main", "--upstream", "https://chatgpt.com", "--match", "suffix:chatgpt.com", "--port", "4306", "--hooks", "codex", "--data", data],
      { homedir: home },
    );
    expect(code).toBe(0);
    expect(out.join("")).toContain("hooks      : codex (preset mode)");

    out.length = 0;
    const getCode = await run(["get", "codex-main", "--data", data], { homedir: home });
    expect(getCode).toBe(0);
    expect(out.join("")).toContain("hooks      : codex (preset mode)");
  });

  it("与逐槽旗标互斥：--hooks + --secret → 退出码 2", async () => {
    const home = freshHome();
    const code = await run(
      ["add", "bad", "--upstream", "https://u.example", "--match", "suffix:u.example", "--port", "9100", "--hooks", "codex", "--secret", "lib", "--data", join(home, "provider")],
      { homedir: home },
    );
    expect(code).toBe(2);
    expect(errOut.join("")).toContain("mutually exclusive");
  });

  it("无阶段导出的脚本 → 错误退出（绑定无意义）", async () => {
    const home = freshHome();
    const code = await run(
      ["add", "bad2", "--upstream", "https://u.example", "--match", "suffix:u.example", "--port", "9100", "--hooks", "ghost-script", "--data", join(home, "provider")],
      { homedir: home },
    );
    expect(code).not.toBe(0);
    expect(errOut.join("")).toContain("no lifecycle stage function");
  });
});
