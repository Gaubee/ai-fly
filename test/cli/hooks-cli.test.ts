// hooks CLI（hooks-lifecycle 6.1/6.2）：list 阶段矩阵（内建四脚本归 ①；旧导出
// 名提示重写）、get 的 stages 行、run --stage 阶段语义（① 三态取值掩码 / ② 对象
// 返回 JSON / 缺 stage 与未知 stage 的错误面 / 阶段导出缺席 exit 1）。
// stdout/stderr 间谍 + tmp HOME + 真实 SecretsStore（--data 指向临时目录）。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/commands/provider/hooks.ts";
import { discoverHooks } from "../../src/provider/hook.ts";

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
  const home = mkdtempSync(join(tmpdir(), `aifly-hooks-cli-${process.pid}-${homes.length}`));
  homes.push(home);
  return home;
}

afterEach(() => {
  lines.length = 0;
  errLines.length = 0;
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  delete process.env.AIFLY_HOOK_TEST_ENV;
});

/** 在用户库装一个脚本（同名覆盖内建语义由 loadHookScript 承担）。 */
function installUser(home: string, name: string, content: string): void {
  const dir = join(home, ".aifly", "hooks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.cjs`), content);
}

describe("ai-fly hooks list（阶段矩阵）", () => {
  it("内建四脚本（codex/env/file/secret）归 ① onRequestBearerAuthentication", async () => {
    const home = freshHome();
    const scripts = discoverHooks(home);
    for (const name of ["codex", "env", "file", "secret"]) {
      const found = scripts.find((s) => s.name === name && s.source === "builtin");
      expect(found, `builtin ${name} should be discoverable`).toBeDefined();
      expect(found?.stages).toEqual(["onRequestBearerAuthentication"]);
    }
    lines.length = 0;
    expect(await run(["list"], { homedir: home })).toBe(0);
    const text = lines.join("");
    expect(text).toContain("codex");
    expect(text).toContain("onRequestBearerAuthentication");
    expect(text).toContain("--auth-script");
    expect(text).toContain("--headers-script");
  });

  it("旧导出名（v1 authHeader）不在 stages 内——列表提示重写", async () => {
    const home = freshHome();
    installUser(home, "zold", "module.exports = { authHeader: () => 'x' };\n");
    installUser(home, "staged", "module.exports = { onRequestHeaders: () => ({ remove: ['x-a'] }) };\n");
    lines.length = 0;
    expect(await run(["list"], { homedir: home })).toBe(0);
    const text = lines.join("");
    expect(text).toContain("zold");
    expect(text).toContain("(no stage exports - rewrite to stage names)");
    expect(text).toMatch(/staged\s+\[user\]\s+onRequestHeaders/);
  });
});

describe("ai-fly hooks get（stages 行）", () => {
  it("输出脚本内容 + 阶段矩阵行", async () => {
    const home = freshHome();
    installUser(home, "tok", "module.exports = { onRequestBearerAuthentication: () => 'abc' };\n");
    lines.length = 0;
    expect(await run(["get", "tok"], { homedir: home })).toBe(0);
    const text = lines.join("");
    expect(text).toContain("stages: onRequestBearerAuthentication");
    expect(text).toContain("module.exports");
  });
});

describe("ai-fly hooks run --stage（阶段语义）", () => {
  it("① 用户脚本 string 返回：掩码输出（原值不回显）", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    installUser(home, "tok", "module.exports = { onRequestBearerAuthentication: ({ args }) => args.value || 'sk-test-123456' };\n");
    lines.length = 0;
    expect(
      await run(["run", "tok", "--stage", "onRequestBearerAuthentication", "--data", data], { homedir: home }),
    ).toBe(0);
    const text = lines.join("");
    expect(text).toContain("ok: tok.onRequestBearerAuthentication -> ");
    expect(text).toContain("(len 14)");
    expect(text).not.toContain("sk-test-123456");
  });

  it("① 内建 env 桥：--arg var=<NAME> 读环境变量（改名后仍可用）", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    process.env.AIFLY_HOOK_TEST_ENV = "envtok-987654";
    lines.length = 0;
    expect(
      await run(
        ["run", "env", "--stage", "onRequestBearerAuthentication", "--arg", "var=AIFLY_HOOK_TEST_ENV", "--data", data],
        { homedir: home },
      ),
    ).toBe(0);
    const text = lines.join("");
    expect(text).toContain("ok: env.onRequestBearerAuthentication -> ");
    expect(text).not.toContain("envtok-987654");
  });

  it("① 内建 codex：读 ~/.codex/auth.json（只读桥；掩码输出）", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "codex-tok-123456" } }));
    lines.length = 0;
    expect(
      await run(["run", "codex", "--stage", "onRequestBearerAuthentication", "--data", data], { homedir: home }),
    ).toBe(0);
    const text = lines.join("");
    expect(text).toContain("ok: codex.onRequestBearerAuthentication -> ");
    expect(text).not.toContain("codex-tok-123456");
  });

  it("① 内建 secret 桥：--arg name=<secret> 读密钥库", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    const secret = await import("../../src/cli/commands/provider/secret.ts");
    await secret.run(["set", "kk", "--value", "sk-from-store-9", "--data", data], { homedir: home });
    lines.length = 0;
    expect(
      await run(["run", "secret", "--stage", "onRequestBearerAuthentication", "--arg", "name=kk", "--data", data], { homedir: home }),
    ).toBe(0);
    const text = lines.join("");
    expect(text).toContain("ok: secret.onRequestBearerAuthentication -> ");
    expect(text).not.toContain("sk-from-store-9");
  });

  it("② 对象返回：{set?, remove?} 以 JSON 呈现（method/path 进 ctx）", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    installUser(
      home,
      "hdr",
      "module.exports = { onRequestHeaders: ({ method, path }) => ({ set: { 'x-method': method, 'x-path': path }, remove: ['x-internal'] }) };\n",
    );
    lines.length = 0;
    expect(
      await run(
        ["run", "hdr", "--stage", "onRequestHeaders", "--method", "POST", "--path", "/v1/x", "--data", data],
        { homedir: home },
      ),
    ).toBe(0);
    const text = lines.join("");
    expect(text).toContain("ok: hdr.onRequestHeaders -> ");
    expect(text).toContain('"set"');
    expect(text).toContain('"x-method":"POST"');
    expect(text).toContain('"x-path":"/v1/x"');
    expect(text).toContain('"remove"');
  });

  it("③ 合成请求 ctx：呈现 status/headers/body 字节数", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    installUser(
      home,
      "mock",
      "module.exports = { onRequest: async ({ method, body }) => ({ status: 201, headers: { 'content-type': 'text/plain' }, body: (async function* () { yield Buffer.from('hello'); })() }) };\n",
    );
    lines.length = 0;
    expect(
      await run(["run", "mock", "--stage", "onRequest", "--body", "ping", "--data", data], { homedir: home }),
    ).toBe(0);
    const text = lines.join("");
    expect(text).toContain("ok: mock.onRequest -> status 201");
    expect(text).toContain('"content-type":"text/plain"');
    expect(text).toContain("body 5 bytes");
  });

  it("缺 --stage / 未知 stage：UsageError（exit 2）", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    expect(await run(["run", "env", "--data", data], { homedir: home })).toBe(2);
    expect(errLines.join("")).toContain("requires --stage");
    errLines.length = 0;
    expect(
      await run(["run", "env", "--stage", "authHeader", "--data", data], { homedir: home }),
    ).toBe(2);
    expect(errLines.join("")).toContain("unknown stage 'authHeader'");
  });

  it("旧脚本（authHeader 导出）跑新阶段：hook_failed 面exit 1", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    installUser(home, "zold", "module.exports = { authHeader: () => 'x' };\n");
    errLines.length = 0;
    expect(
      await run(["run", "zold", "--stage", "onRequestHeaders", "--data", data], { homedir: home }),
    ).toBe(1);
    expect(errLines.join("")).toContain("zold.onRequestHeaders");
    expect(errLines.join("")).toContain("failed");
  });

  it("① 凭据缺席：HookMissingError 面（exit 1，不回显值）", async () => {
    const home = freshHome();
    const data = join(home, "provider");
    errLines.length = 0;
    // env 桥读未设置变量 → 三态取值未产出
    expect(
      await run(
        ["run", "env", "--stage", "onRequestBearerAuthentication", "--arg", "var=AIFLY_HOOK_TEST_ENV", "--data", data],
        { homedir: home },
      ),
    ).toBe(1);
    expect(errLines.join("")).toContain("did not yield a value");
  });
});
