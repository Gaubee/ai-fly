// 分组级限额执行与用量记录：
// - maxConcurrency：分组在途 REQ 计数（拨号前检查，超限回 rate_limited）；
// - dailyRequests：按 keyId 的日请求数（UTC 日界重置，quota-day.json 原子持久化，
//   超限回 quota_exceeded）；
// - usage.jsonl：--log-usage 时追加，仅元数据（keyId/serviceId/status/bytes/时间戳），
//   MUST NOT 记录正文。
// 正交意图：不校验授权（auth.ts）、不接触网络（引擎在拨号前调用 acquire）；
// 日界判定与计数持久化都在本文件，acquire 是同步原子步骤（JS 单线程，检查+占用
// 之间无并发窗口）。

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { atomicWriteFileSync, ensurePrivateDir } from "./store.ts";
import type { GroupLimits, ProviderStore } from "./store.ts";

export type { GroupLimits } from "./store.ts";

/** 超限结果码（wire ERROR 帧码子集）。 */
export type LimitReject = { ok: false; code: "rate_limited" | "quota_exceeded" };
export type AcquireResult = { ok: true } | LimitReject;

/** 用量元数据记录（无正文）。 */
export interface UsageRecord {
  ts: number;
  keyId: string;
  serviceId: string;
  /** HTTP status（number）或终结错误码（string）。 */
  status: number | string;
  bytes: number;
}

const QUOTA_DAY_SCHEMA = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  counts: z.record(z.string(), z.number().int().min(0)),
});

type QuotaDay = z.infer<typeof QUOTA_DAY_SCHEMA>;

export class LimitEnforcer {
  readonly dataDir: string;
  private readonly now: () => Date;
  /** 分组限额配置（reload 时整体替换）。 */
  private limitsByGroup = new Map<string, GroupLimits>();
  /** 分组在途计数。 */
  private readonly inflight = new Map<string, number>();
  private quotaDate = "";
  private quotaCounts = new Map<string, number>();

  constructor(opts: { dataDir: string; now?: () => Date }) {
    this.dataDir = opts.dataDir;
    this.now = opts.now ?? (() => new Date());
  }

  static quotaFilePath(dataDir: string): string {
    return join(dataDir, "quota-day.json");
  }

  /** 引擎在 store（重）加载后同步分组限额配置。 */
  syncFromStore(store: ProviderStore): void {
    this.limitsByGroup = new Map(
      store.listGroups().map((g) => [g.name, g.limits ? { ...g.limits } : {}]),
    );
  }

  setGroupLimits(group: string, limits: GroupLimits): void {
    this.limitsByGroup.set(group, { ...limits });
  }

  /** 拨号前检查+占用（原子）：并发按分组计，日限按 keyId 计。 */
  acquire(keyId: string, group: string): AcquireResult {
    const limits = this.limitsByGroup.get(group) ?? {};
    const current = this.inflight.get(group) ?? 0;
    if (limits.maxConcurrency !== undefined && current >= limits.maxConcurrency) {
      return { ok: false, code: "rate_limited" };
    }
    this.ensureQuotaLoaded();
    const used = this.quotaCounts.get(keyId) ?? 0;
    if (limits.dailyRequests !== undefined && used >= limits.dailyRequests) {
      return { ok: false, code: "quota_exceeded" };
    }
    this.inflight.set(group, current + 1);
    this.quotaCounts.set(keyId, used + 1);
    this.persistQuota();
    return { ok: true };
  }

  /** 请求终结时释放并发占用（幂等保护：下限 0）。 */
  release(group: string): void {
    const current = this.inflight.get(group) ?? 0;
    this.inflight.set(group, Math.max(0, current - 1));
  }

  inflightCount(group: string): number {
    return this.inflight.get(group) ?? 0;
  }

  dailyCount(keyId: string): number {
    this.ensureQuotaLoaded();
    return this.quotaCounts.get(keyId) ?? 0;
  }

  today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  /** 加载/日界重置（懒加载：首次 acquire 或查询时）。 */
  private ensureQuotaLoaded(): void {
    const today = this.today();
    if (this.quotaDate === today) return;
    let counts = new Map<string, number>();
    const path = LimitEnforcer.quotaFilePath(this.dataDir);
    if (existsSync(path)) {
      try {
        const parsed = QUOTA_DAY_SCHEMA.parse(JSON.parse(readFileSync(path, "utf8")));
        if (parsed.date === today) {
          counts = new Map(Object.entries(parsed.counts));
        }
        // 日期不符 -> 日界重置（旧文件被今天的首写覆盖）。
      } catch {
        // 损坏视同空表（不阻塞服务；下次写入覆盖修复）。
      }
    }
    this.quotaDate = today;
    this.quotaCounts = counts;
  }

  private persistQuota(): void {
    const payload: QuotaDay = {
      date: this.quotaDate,
      counts: Object.fromEntries(this.quotaCounts),
    };
    atomicWriteFileSync(LimitEnforcer.quotaFilePath(this.dataDir), `${JSON.stringify(payload, null, 2)}\n`);
  }
}

// ---------------------------------------------------------------------------
// 用量日志（仅元数据）
// ---------------------------------------------------------------------------

export class UsageLog {
  private readonly path: string;
  private dirReady = false;

  constructor(dataDir: string) {
    this.path = join(dataDir, "usage.jsonl");
  }

  append(record: UsageRecord): void {
    if (!this.dirReady) {
      ensurePrivateDir(dirname(this.path));
      this.dirReady = true;
    }
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  pathOf(): string {
    return this.path;
  }
}
