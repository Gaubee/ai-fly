// secret CLI（cli-hardening #11 + hooks-lifecycle 5.2）：set --value/--stdin、
// list 形状（无 bearer 列——bearerPrefix 退役，前缀归服务 auth 槽）、remove；
// 值永不出库（list 无值列）。stdout 间谍 + tmp HOME + 真实 SecretsStore。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/commands/provider/secret.ts";
import { SecretsStore } from "../../src/provider/secrets.ts";

const lines: string[] = [];
const errLines: string[] = [];
vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
  lines.push(String(chunk));
  return true;
});
vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
  errLines.push(String(chunk));
  return true;
});

const homes: string[] = [];

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), `aifly-secret-${process.pid}-${homes.length}`));
  homes.push(home);
  return home;
}

afterEach(() => {
  lines.length = 0;
  errLines.length = 0;
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("ai-fly secret", () => {
  it("set --value：原样存储（bearerPrefix 退役——前缀由服务 auth 槽拼）", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    expect(await run(["set", "k1", "--value", "sk-abc", "--data", data], { homedir: home })).toBe(0);
    const store = SecretsStore.open(data);
    expect(store.resolve("k1")?.headerValue).toBe("sk-abc");
    expect(JSON.stringify(store.list())).not.toContain("bearerPrefix");
  });

  it("set --stdin 读一行 stdin（去换行）", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    const real = process.stdin;
    vi.spyOn(process, "stdin", "get").mockReturnValue(Readable.from(["sk-from-stdin\n"]) as unknown as typeof process.stdin);
    expect(await run(["set", "ks", "--stdin", "--data", data], { homedir: home })).toBe(0);
    vi.spyOn(process, "stdin", "get").mockReturnValue(real);
    expect(SecretsStore.open(data).resolve("ks")?.headerValue).toBe("sk-from-stdin");
  });

  it("list：名字/时间列，无值列无 bearer 列（值不出库）；remove 删除", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    await run(["set", "k1", "--value", "sk-abc", "--data", data], { homedir: home });
    lines.length = 0;
    expect(await run(["list", "--data", data], { homedir: home })).toBe(0);
    const text = lines.join("");
    expect(text).toContain("k1");
    expect(text).not.toContain("bearer");
    expect(text).not.toContain("sk-abc");
    expect(await run(["remove", "k1", "--data", data], { homedir: home })).toBe(0);
    expect(SecretsStore.open(data).resolve("k1")).toBeUndefined();
  });
});
