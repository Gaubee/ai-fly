// settings/relay CLI（cli-hardening #11）：与 GUI 同源 settings.json 的读写契约
// ——list 初始态、set theme/models-dev/relay 校验（协议白名单/上限/--default）、
// relay 兼容别名落点一致。stdout 间谍 + tmp HOME。

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAsSettings, runAsRelay } from "../../src/cli/commands/settings.ts";
import { loadSettings, settingsPath } from "../../src/app/settings.ts";

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
  const home = mkdtempSync(join(tmpdir(), `aifly-settings-${process.pid}-${homes.length}`));
  homes.push(home);
  return home;
}

afterEach(() => {
  lines.length = 0;
  errLines.length = 0;
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("ai-fly settings", () => {
  it("list：初始默认态（theme system / models-dev on / relay n0）", async () => {
    const home = freshHome();
    const code = await runAsSettings(["list"], { homedir: home });
    expect(code).toBe(0);
    const text = lines.join("");
    expect(text).toContain("theme      : system");
    expect(text).toContain("models-dev : on");
    expect(text).toContain("relay      : SDK defaults (n0 public relays)");
  });

  it("set theme/models-dev 落盘与 GUI 同源 settings.json", async () => {
    const home = freshHome();
    expect(await runAsSettings(["set", "theme", "dark"], { homedir: home })).toBe(0);
    expect(await runAsSettings(["set", "models-dev", "off"], { homedir: home })).toBe(0);
    const saved = loadSettings(home);
    expect(saved.theme).toBe("dark");
    expect(saved.modelsDevEnabled).toBe(false);
    expect(JSON.parse(readFileSync(settingsPath(home), "utf8")).theme).toBe("dark");
  });

  it("set relay：多 URL 落盘；非法协议拒绝；--default 回 SDK 默认", async () => {
    const home = freshHome();
    expect(
      await runAsSettings(["set", "relay", "http://39.107.213.167:3340", "https://euc1-1.relay.n0.iroh.link./"], { homedir: home }),
    ).toBe(0);
    expect(loadSettings(home).relayUrls).toEqual(["http://39.107.213.167:3340", "https://euc1-1.relay.n0.iroh.link./"]);

    lines.length = 0;
    expect(await runAsSettings(["set", "relay", "wss://bad.example/"], { homedir: home })).toBe(2);
    expect(errLines.join("")).toContain("must start with http");

    expect(await runAsSettings(["set", "relay", "--default"], { homedir: home })).toBe(0);
    expect(loadSettings(home).relayUrls).toBeNull();
  });

  it("relay 别名与 settings set relay 同落点", async () => {
    const home = freshHome();
    expect(await runAsRelay(["set", "http://r1.example:3340"], { homedir: home })).toBe(0);
    expect(loadSettings(home).relayUrls).toEqual(["http://r1.example:3340"]);
    lines.length = 0;
    expect(await runAsRelay(["list"], { homedir: home })).toBe(0);
    expect(lines.join("")).toContain("http://r1.example:3340");
  });
});
