// group CLI（set-services 子命令，2026-09-09 实机暴露的缺口）：真实 store +
// 注入 HOME，stdout 间谍捕获。add/list 已有 e2e 面，此处聚焦新子命令契约。

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/commands/provider/group.ts";
import { ProviderStore } from "../../src/provider/store.ts";

const lines: string[] = [];
const errLines: string[] = [];
const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
  lines.push(String(chunk));
  return true;
});
const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
  errLines.push(String(chunk));
  return true;
});

afterEach(() => {
  lines.length = 0;
  errLines.length = 0;
});

describe("ai-fly group set-services", () => {
  it("整表替换组成员（名称引用，保留限额与密钥）", async () => {
    const home = mkdtempSync(join(tmpdir(), "aifly-group-cli-"));
    const data = join(home, "p");
    const store = ProviderStore.open(data);
    store.addService({ name: "a", upstream: "http://127.0.0.1:1", match: [{ type: "suffix", value: ".a.test" }], defaultPort: 20001 });
    store.addService({ name: "b", upstream: "http://127.0.0.1:2", match: [{ type: "suffix", value: ".b.test" }], defaultPort: 20002 });
    store.addGroup("friends", ["a"], { maxConcurrency: 2 });
    const key = store.issueKey("friends");

    const code = await run(["set-services", "friends", "--service", "b", "--data", data], { homedir: home });
    expect(code).toBe(0);
    expect(lines.join("")).toContain("group updated: friends");
    expect(lines.join("")).toContain("services: b");

    const after = ProviderStore.open(data);
    expect(after.listGroups().find((g) => g.name === "friends")?.serviceIds).toHaveLength(1);
    expect(after.listGroups().find((g) => g.name === "friends")?.limits).toEqual({ maxConcurrency: 2 });
    expect(after.listKeys().find((k) => k.keyId === key.keyId)?.revokedAt).toBeUndefined();
  });

  it("空 --service 拒绝（清空组走 store API，防误操作）", async () => {
    const home = mkdtempSync(join(tmpdir(), "aifly-group-cli-"));
    const data = join(home, "p");
    const store = ProviderStore.open(data);
    store.addService({ name: "a", upstream: "http://127.0.0.1:1", match: [{ type: "suffix", value: ".a.test" }], defaultPort: 20001 });
    store.addGroup("friends", ["a"]);

    const code = await run(["set-services", "friends", "--data", data], { homedir: home });
    expect(code).toBe(2); // UsageError 经 reportCliError 的退出码
    expect(errLines.join("")).toContain("at least one --service");
  });
});
