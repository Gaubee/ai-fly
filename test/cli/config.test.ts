import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, saveConfig, resolveRelayUrls, configPath } from "../../src/cli/config.ts";
import { CliError } from "../../src/cli/errors.ts";

const bases: string[] = [];

function freshBase(): string {
  const base = join(tmpdir(), `aifly-test-${process.pid}-${bases.length}`);
  mkdirSync(base, { recursive: true });
  bases.push(base);
  return base;
}

afterEach(() => {
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

describe("config file", () => {
  it("missing file loads as empty config", () => {
    expect(loadConfig(freshBase())).toEqual({});
  });

  it("roundtrips and enforces 0600 file mode (posix)", () => {
    const base = freshBase();
    saveConfig({ relayUrls: ["http://192.168.2.13:8787"] }, base);
    expect(loadConfig(base)).toEqual({ relayUrls: ["http://192.168.2.13:8787"] });
    if (process.platform !== "win32") {
      const mode = statSync(configPath(base)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("corrupt JSON is a hard error, never silently reset", () => {
    const base = freshBase();
    const p = configPath(base);
    mkdirSync(join(base, ".aifly"), { recursive: true });
    writeFileSync(p, "{not json");
    expect(() => loadConfig(base)).toThrowError(CliError);
    expect(existsSync(p)).toBe(true);
  });

  it("schema-invalid content is rejected", () => {
    const base = freshBase();
    mkdirSync(join(base, ".aifly"), { recursive: true });
    writeFileSync(configPath(base), JSON.stringify({ relayUrls: "not-a-list" }));
    expect(() => loadConfig(base)).toThrowError(/validation/);
  });
});

describe("resolveRelayUrls precedence flag > env > file > default", () => {
  it("flag wins over env and file", () => {
    expect(
      resolveRelayUrls({
        flag: ["http://flag:1"],
        env: "http://env:1",
        file: { relayUrls: ["http://file:1"] },
      }),
    ).toEqual(["http://flag:1"]);
  });

  it("env beats file; comma-separated env accepted", () => {
    expect(
      resolveRelayUrls({ env: "http://a:1, http://b:2", file: { relayUrls: ["http://file:1"] } }),
    ).toEqual(["http://a:1", "http://b:2"]);
  });

  it("file used when flag/env absent; undefined means SDK default", () => {
    expect(resolveRelayUrls({ file: { relayUrls: ["http://file:1"] } })).toEqual([
      "http://file:1",
    ]);
    expect(resolveRelayUrls({})).toBeUndefined();
    expect(resolveRelayUrls({ flag: [] })).toBeUndefined();
  });
});
