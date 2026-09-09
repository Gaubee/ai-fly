// limits 单测：并发矩阵（上限 2 时第三请求 rate_limited、release 回落）、日限
// （quota-day.json 持久化、UTC 日界重置、按 keyId 分别计数）、超限码、
// usage.jsonl 仅元数据（无正文）。

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LimitEnforcer, UsageLog } from "../../../src/provider/limits.ts";

let dir: string;
let nowValue = new Date("2026-09-09T10:00:00Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aifly-limits-"));
  nowValue = new Date("2026-09-09T10:00:00Z");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function make(now?: () => Date): LimitEnforcer {
  const enforcer = new LimitEnforcer({ dataDir: dir, now: now ?? (() => nowValue) });
  enforcer.setGroupLimits("g", { maxConcurrency: 2, dailyRequests: 3 });
  return enforcer;
}

/** 仅日限的组（避免并发上限先行触发）。 */
function makeDailyOnly(now?: () => Date): LimitEnforcer {
  const enforcer = new LimitEnforcer({ dataDir: dir, now: now ?? (() => nowValue) });
  enforcer.setGroupLimits("g", { dailyRequests: 3 });
  return enforcer;
}

describe("并发限额（分组在途计数）", () => {
  it("上限 2：前两个请求占用、第三个 rate_limited", () => {
    const lim = make();
    expect(lim.acquire("k1", "g")).toEqual({ ok: true });
    expect(lim.acquire("k2", "g")).toEqual({ ok: true });
    expect(lim.acquire("k3", "g")).toEqual({ ok: false, code: "rate_limited" });
    expect(lim.inflightCount("g")).toBe(2);
  });

  it("release 后回落：终结一个请求即可再次受理", () => {
    const lim = make();
    lim.acquire("k1", "g");
    lim.acquire("k1", "g");
    expect(lim.acquire("k1", "g")).toEqual({ ok: false, code: "rate_limited" });
    lim.release("g");
    expect(lim.acquire("k1", "g")).toEqual({ ok: true });
  });

  it("并发按分组独立计数；限额仅作用于已配置分组", () => {
    const lim = make();
    lim.acquire("k1", "g");
    lim.acquire("k1", "g");
    expect(lim.acquire("k1", "other")).toEqual({ ok: true }); // 未配置组不限
  });

  it("rate_limited 请求不占日限计数（拨号前拒绝零成本）", () => {
    const lim = make();
    lim.acquire("k1", "g");
    lim.acquire("k1", "g");
    lim.acquire("k1", "g"); // 被并发拒绝
    expect(lim.dailyCount("k1")).toBe(2);
  });
});

describe("日限（keyId 计数 / UTC 日界 / 持久化）", () => {
  it("dailyRequests=3：第四个请求 quota_exceeded", () => {
    const lim = makeDailyOnly();
    for (let i = 0; i < 3; i++) expect(lim.acquire("k1", "g")).toEqual({ ok: true });
    expect(lim.acquire("k1", "g")).toEqual({ ok: false, code: "quota_exceeded" });
  });

  it("按 keyId 分别计数（k1 打满不影响 k2）", () => {
    const lim = makeDailyOnly();
    for (let i = 0; i < 3; i++) lim.acquire("k1", "g");
    expect(lim.acquire("k2", "g")).toEqual({ ok: true });
  });

  it("UTC 日界重置", () => {
    const lim = makeDailyOnly();
    for (let i = 0; i < 3; i++) lim.acquire("k1", "g");
    expect(lim.acquire("k1", "g")).toEqual({ ok: false, code: "quota_exceeded" });
    nowValue = new Date("2026-09-10T00:00:00.001Z"); // 次日（UTC）
    expect(lim.acquire("k1", "g")).toEqual({ ok: true });
    expect(lim.dailyCount("k1")).toBe(1);
  });

  it("quota-day.json 持久化：新实例同日恢复计数，跨日丢弃", () => {
    const lim = makeDailyOnly();
    for (let i = 0; i < 3; i++) lim.acquire("k1", "g");
    const file = JSON.parse(readFileSync(LimitEnforcer.quotaFilePath(dir), "utf8")) as {
      date: string;
      counts: Record<string, number>;
    };
    expect(file).toEqual({ date: "2026-09-09", counts: { k1: 3 } });
    const reopened = new LimitEnforcer({ dataDir: dir, now: () => nowValue });
    reopened.setGroupLimits("g", { dailyRequests: 3 });
    expect(reopened.acquire("k1", "g")).toEqual({ ok: false, code: "quota_exceeded" });
  });
});

describe("usage.jsonl（仅元数据）", () => {
  it("追加仅元数据行：keyId/serviceId/status/bytes/ts，无正文", () => {
    const log = new UsageLog(dir);
    log.append({ ts: 1_700_000_000_000, keyId: "k1", serviceId: "svc1", status: 200, bytes: 1234 });
    log.append({ ts: 1_700_000_000_001, keyId: "k1", serviceId: "svc1", status: "upstream_unreachable", bytes: 0 });
    const lines = readFileSync(join(dir, "usage.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first).toEqual({ ts: 1_700_000_000_000, keyId: "k1", serviceId: "svc1", status: 200, bytes: 1234 });
    expect(lines.join("\n")).not.toContain("body");
    expect(lines.join("\n")).not.toContain("payload");
  });
});
