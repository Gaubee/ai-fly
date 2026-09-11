// service add 路由参数（cli-parity B1 → cli-hardening #11）：--route local=up[@forms]
// 解析（forms 按 anthropic 子串自动推导）、--route-pattern match=template、
// --secret 推 $secret: 重写、service get 全量详情。真实 ProviderStore + tmp HOME。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/commands/provider/service.ts";
import { ProviderStore } from "../../src/provider/store.ts";

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
  const home = mkdtempSync(join(tmpdir(), `aifly-svc-route-${process.pid}-${homes.length}`));
  homes.push(home);
  return home;
}

afterEach(() => {
  lines.length = 0;
  errLines.length = 0;
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("ai-fly service add 路由参数", () => {
  it("--route local=up 解析为 prefix 路由；anthropic 子串自动推导 forms", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    const code = await run(
      ["add", "myapi", "--upstream", "https://api.example.com/", "--match", "suffix:api.example.com", "--route", "/v1=/v1", "--route", "/anthropic=/anthropic", "--port", "4310", "--data", data],
      { homedir: home },
    );
    expect(code).toBe(0);
    const svc = ProviderStore.open(data).listServices().find((s) => s.name === "myapi");
    expect(svc?.routes).toHaveLength(2);
    expect(svc?.routes?.[0]).toMatchObject({ localPrefix: "/v1", upstreamPrefix: "/v1", forms: ["openai-chat", "openai-responses"] });
    expect(svc?.routes?.[1]).toMatchObject({ localPrefix: "/anthropic", upstreamPrefix: "/anthropic", forms: ["anthropic"] });
    expect(lines.join("")).toContain("routes     : /v1=/v1 | /anthropic=/anthropic");
  });

  it("--route 显式 @forms 覆盖自动推导", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    await run(["add", "f1", "--upstream", "https://x.example.com/", "--match", "suffix:x.example.com", "--route", "/a=/b@openai-chat", "--port", "4311", "--data", data], { homedir: home });
    const svc = ProviderStore.open(data).listServices().find((s) => s.name === "f1");
    expect(svc?.routes?.[0]?.forms).toEqual(["openai-chat"]);
  });

  it("--route-pattern match=template 构造 pattern 路由；非法格式退出码 2", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    await run(
      ["add", "p1", "--upstream", "https://x.example.com/", "--match", "suffix:x.example.com", "--route-pattern", "/models/{model}=https://x.example.com/v1/{model}", "--port", "4312", "--data", data],
      { homedir: home },
    );
    const svc = ProviderStore.open(data).listServices().find((s) => s.name === "p1");
    expect(svc?.routes?.[0]).toMatchObject({ mode: "pattern" });
    expect(svc?.routes?.[0]?.matchPattern).toBe("/models/{model}");

    const code = await run(["add", "p2", "--upstream", "https://x.example.com/", "--match", "suffix:x.example.com", "--route-pattern", "no-equal-sign", "--port", "4313", "--data", data], { homedir: home });
    expect(code).toBe(2);
  });

  it("--secret 挂 authorization=$secret:<name> 重写；service get 展示（值不出库）", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    const secret = await import("../../src/cli/commands/provider/secret.ts");
    await secret.run(["set", "kk", "--value", "sk-xyz", "--data", data], { homedir: home });
    lines.length = 0;
    await run(["add", "withsec", "--upstream", "https://api.example.com/", "--match", "suffix:api.example.com", "--secret", "kk", "--port", "4314", "--data", data], { homedir: home });
    const svc = ProviderStore.open(data).listServices().find((s) => s.name === "withsec");
    expect(svc?.rewrite?.headerSet).toEqual({ authorization: "$secret:kk" });
    lines.length = 0;
    expect(await run(["get", "withsec", "--data", data], { homedir: home })).toBe(0);
    const text = lines.join("");
    expect(text).toContain("$secret:kk");
    expect(text).not.toContain("sk-xyz");
  });
});
