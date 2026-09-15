// service add 路由参数（cli-parity B1 → cli-hardening #11）：--route local=up[@forms]
// 解析（forms 按 anthropic 子串自动推导）、--route-pattern match=template、
// --secret 推 $secret: 重写、service get 全量详情。真实 ProviderStore + tmp HOME。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("--secret 落 auth.secret 槽；service get 展示（值不出库）", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    const secret = await import("../../src/cli/commands/provider/secret.ts");
    await secret.run(["set", "kk", "--value", "sk-xyz", "--data", data], { homedir: home });
    lines.length = 0;
    await run(["add", "withsec", "--upstream", "https://api.example.com/", "--match", "suffix:api.example.com", "--secret", "kk", "--port", "4314", "--data", data], { homedir: home });
    const svc = ProviderStore.open(data).listServices().find((s) => s.name === "withsec");
    // hooks-lifecycle v2：--secret 糖 → auth.secret（不再写 rewrite.headerSet/hooks）
    expect(svc?.auth).toEqual({ secret: "kk" });
    expect(svc?.rewrite).toBeUndefined();
    lines.length = 0;
    expect(await run(["get", "withsec", "--data", data], { homedir: home })).toBe(0);
    const text = lines.join("");
    expect(text).toContain("auth       : secret kk");
    expect(text).not.toContain("sk-xyz");
  });
});

describe("ai-fly service add --preset codex（cli-codex）", () => {
  it("路由 + preset.auth→auth.script 预填（无需 --secret/--port）", async () => {
    const home = mkdtempSync(join(tmpdir(), `aifly-codex-${process.pid}`));
    const data = join(home, "provider");
    const code = await run(["add", "my-codex", "--preset", "codex", "--data", data], { homedir: home });
    expect(code).toBe(0);
    const svc = ProviderStore.open(data).listServices().find((s) => s.name === "my-codex");
    expect(svc?.upstream).toBe("https://chatgpt.com/");
    expect(svc?.defaultPort).toBe(4306);
    expect(svc?.routes?.[0]).toMatchObject({
      forms: ["openai-responses"],
      localPrefix: "/codex",
      upstreamPrefix: "/backend-api/codex",
    });
    // rust-fetch-sidecar：codex 预设走预设模式（hooks 整段绑定，脚本自带 ①②③）
    expect(svc?.hooks).toEqual({ script: "codex" });
    expect(svc?.auth).toBeUndefined();
    expect(svc?.rewrite).toBeUndefined();
    const text = lines.join("");
    expect(text).toContain("/codex=/backend-api/codex");
  });

  it("--secret 覆盖 preset 的 auth", async () => {
    const home = mkdtempSync(join(tmpdir(), `aifly-codex2-${process.pid}`));
    const data = join(home, "provider");
    const secret = await import("../../src/cli/commands/provider/secret.ts");
    await secret.run(["set", "ck", "--value", "sk-x", "--data", data], { homedir: home });
    lines.length = 0;
    await run(["add", "codex2", "--preset", "codex", "--secret", "ck", "--data", data], { homedir: home });
    const svc = ProviderStore.open(data).listServices().find((s) => s.name === "codex2");
    expect(svc?.auth).toEqual({ secret: "ck" });
  });

  it("--no-bearer 对预设模式 codex：无 auth 源可关 → 显式报错（①由整段脚本承担，前缀不可逐槽关闭）", async () => {
    const home = mkdtempSync(join(tmpdir(), `aifly-codex3-${process.pid}`));
    const data = join(home, "provider");
    const code = await run(["add", "codex3", "--preset", "codex", "--no-bearer", "--data", data], { homedir: home });
    expect(code).toBe(2);
    expect(errLines.join("")).toContain("--no-bearer requires an auth source");
    expect(ProviderStore.open(data).listServices()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// hooks-lifecycle 6.1：service add 旗标重映射 + get/list 四槽 humanize + legacy
// ---------------------------------------------------------------------------

describe("ai-fly service add 生命周期旗标（v2）", () => {
  it("--auth-script/--auth-literal 落 auth 槽；三族互斥拒绝", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    const base = ["--upstream", "https://api.example.com/", "--match", "suffix:api.example.com", "--port", "4320", "--data", data];
    await run(["add", "via-script", ...base, "--auth-script", "codex"], { homedir: home });
    await run(["add", "via-literal", ...base, "--auth-literal", "Bearer abc"], { homedir: home });
    const services = ProviderStore.open(data).listServices();
    expect(services.find((s) => s.name === "via-script")?.auth).toEqual({ script: "codex" });
    expect(services.find((s) => s.name === "via-literal")?.auth).toEqual({ literal: "Bearer abc" });

    // 互斥：--secret + --auth-script 同时给 → UsageError（退出码 2）
    const code = await run(["add", "conflict", ...base, "--secret", "a", "--auth-literal", "b"], { homedir: home });
    expect(code).toBe(2);
    expect(errLines.join("")).toContain("mutually exclusive");
  });

  it("--no-bearer 需要 auth 源；有 auth 源时落 bearer:false", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    const base = ["--upstream", "https://api.example.com/", "--match", "suffix:api.example.com", "--port", "4321", "--data", data];
    const noAuth = await run(["add", "x1", ...base, "--no-bearer"], { homedir: home });
    expect(noAuth).toBe(2);
    expect(errLines.join("")).toContain("--no-bearer requires an auth source");

    await run(["add", "x2", ...base, "--secret", "kk", "--no-bearer"], { homedir: home });
    expect(ProviderStore.open(data).listServices().find((s) => s.name === "x2")?.auth).toEqual({ secret: "kk", bearer: false });
  });

  it("--headers-script/--request-script/--response-script 落对应槽", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    await run(
      [
        "add", "staged",
        "--upstream", "https://api.example.com/", "--match", "suffix:api.example.com", "--port", "4322", "--data", data,
        "--header-set", "x-org=acme", "--header-set", "x-token=$secret:tk", "--header-remove", "X-Internal",
        "--headers-script", "hdrfix", "--request-script", "mock-up", "--response-script", "tail-log",
      ],
      { homedir: home },
    );
    const svc = ProviderStore.open(data).listServices().find((s) => s.name === "staged");
    expect(svc?.headers).toEqual({
      set: { "x-org": "acme", "x-token": "$secret:tk" },
      remove: ["x-internal"],
      script: { name: "hdrfix" },
    });
    expect(svc?.request).toEqual({ script: "mock-up" });
    expect(svc?.response).toEqual({ script: "tail-log" });
  });

  it("--header-set 值拒收 JSON 钩子对象（提示改用 --headers-script）", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    const code = await run(
      [
        "add", "badhdr",
        "--upstream", "https://api.example.com/", "--match", "suffix:api.example.com", "--port", "4323", "--data", data,
        "--header-set", 'authorization={"hook":"authHeader","args":{"name":"k"}}',
      ],
      { homedir: home },
    );
    expect(code).toBe(2);
    expect(errLines.join("")).toContain("per-header hook objects were removed");
    expect(errLines.join("")).toContain("--headers-script");
  });

  it("--hooks 预设模式（rust-fetch-sidecar 回归）：整段绑定落库（互斥/无导出用例见 service-hooks.test）", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    const code = await run(
      ["add", "presetsvc", "--upstream", "https://chatgpt.com/", "--match", "suffix:chatgpt.com", "--port", "4324", "--data", data, "--hooks", "codex"],
      { homedir: home },
    );
    expect(code).toBe(0);
    const svc = ProviderStore.open(data).getServiceByName("presetsvc");
    expect(svc?.hooks).toEqual({ script: "codex" });
    expect(svc?.auth).toBeUndefined();
  });

  it("service get/list 按四槽阶段 humanize（显示引用形态，auth 三族 + bearer）", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    await run(
      [
        "add", "full",
        "--upstream", "https://api.example.com/", "--match", "suffix:api.example.com", "--port", "4325", "--data", data,
        "--secret", "kk", "--no-bearer",
        "--header-set", "x-org=acme", "--header-remove", "X-Internal", "--headers-script", "hdrfix",
        "--request-script", "mock-up", "--response-script", "tail-log",
      ],
      { homedir: home },
    );
    lines.length = 0;
    expect(await run(["get", "full", "--data", data], { homedir: home })).toBe(0);
    const text = lines.join("");
    expect(text).toContain("auth       : secret kk (bearer off)");
    expect(text).toContain("headers    : set x-org=acme | remove x-internal | script hdrfix");
    expect(text).toContain("request    : script mock-up");
    expect(text).toContain("response   : script tail-log");

    lines.length = 0;
    expect(await run(["list", "--data", data], { homedir: home })).toBe(0);
    const listText = lines.join("");
    expect(listText).toContain("lifecycle  : auth:secret kk (bearer off); headers:set(1),remove(1),script:hdrfix; request:script mock-up; response:script tail-log");
  });

  it("keyEnv 预设（openai）走 auth.literal $env 引用", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    await run(["add", "oa", "--preset", "openai", "--data", data], { homedir: home });
    const svc = ProviderStore.open(data).listServices().find((s) => s.name === "oa");
    expect(svc?.auth).toEqual({ literal: "$env:OPENAI_API_KEY" });
  });

  it("legacy（pre-v2）services.json：service list 显示失效名册 + 移除提示", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    mkdirSync(data, { recursive: true });
    // v1 形状：无 version 字段（hooks-lifecycle 版本门禁 → legacy 态）
    writeFileSync(join(data, "services.json"), JSON.stringify({ revision: 3, services: [{ name: "old-a", upstream: "https://a.example.com" }, { name: "old-b", upstream: "https://b.example.com" }], groups: [], keys: [] }));
    lines.length = 0;
    expect(await run(["list", "--data", data], { homedir: home })).toBe(0);
    const text = lines.join("");
    expect(text).toContain("legacy (pre-v2) format");
    expect(text).toContain("old-a  [legacy]");
    expect(text).toContain("old-b  [legacy]");
    expect(text).toContain("ai-fly service remove <name>");
  });
});
