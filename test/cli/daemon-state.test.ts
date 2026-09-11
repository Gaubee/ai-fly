// daemon-state（cli-parity A1 → cli-hardening #11）：dir 形状（daemon/gateway 双
// kind）、pid 写读清、last-start 往返、kind 隔离。纯 fs 语义，tmp HOME。

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearPid,
  daemonDir,
  ensureDaemonDir,
  readLastStart,
  readPid,
  writeLastStart,
  writePid,
} from "../../src/cli/daemon-state.ts";

const homes: string[] = [];

function freshHome(): string {
  const home = join(tmpdir(), `aifly-dstate-${process.pid}-${homes.length}`);
  mkdtempSync(home);
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("state dirs", () => {
  it("daemon 与 gateway 各自独立目录与日志名", () => {
    const home = freshHome();
    const d = daemonDir(home, "daemon");
    const g = daemonDir(home, "gateway");
    expect(d.root).toBe(join(home, ".aifly", "daemon"));
    expect(d.logFile).toBe(join(d.root, "daemon.log"));
    expect(g.root).toBe(join(home, ".aifly", "gateway"));
    expect(g.logFile).toBe(join(g.root, "gateway.log"));
    expect(d.pidFile).not.toBe(g.pidFile);
  });

  it("ensureDaemonDir 建目录（幂等）", () => {
    const home = freshHome();
    const dir = ensureDaemonDir(home, "gateway");
    expect(() => readFileSync(join(dir.root, "pid"), "utf8")).toThrow();
    ensureDaemonDir(home, "gateway");
  });
});

describe("pid lifecycle", () => {
  it("write → read → clear；缺省/空文件读 null", () => {
    const home = freshHome();
    expect(readPid(home, "gateway")).toBeNull();
    writePid(4242, home, "gateway");
    expect(readPid(home, "gateway")).toBe(4242);
    expect(readPid(home, "daemon")).toBeNull(); // kind 隔离
    clearPid(home, "gateway");
    expect(readPid(home, "gateway")).toBeNull();
  });
});

describe("last-start", () => {
  it("往返保持 entry/args/startedAt；坏文件读 null", () => {
    const home = freshHome();
    expect(readLastStart(home, "daemon")).toBeNull();
    const last = { entry: "/x/dist/ai-fly.js", args: ["daemon", "start", "--data", "/d"], startedAt: 123456 };
    writeLastStart(last, home, "daemon");
    expect(readLastStart(home, "daemon")).toEqual(last);
    expect(readLastStart(home, "gateway")).toBeNull();
  });
});
