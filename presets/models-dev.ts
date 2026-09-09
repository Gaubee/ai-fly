// 预设库（presets spec）：精选集（仓库内 providers.json，带出处）+ models.dev
// 长尾扩展（运行时拉取 api.json → apiForm 归类 → 数据目录缓存 TTL 7 天 →
// 断网回退缓存与精选集 → 可禁用）。
// 正交意图（本文件不实现）：
// - 预设如何变成服务（applyAsService 在 rpc-router 侧展开后走 store.addService）；
// - 契约形状（src/shared/rpc-contract.ts 的 PRESET_SCHEMA 是唯一形状信源）。
// 副作用注入点：cachePath/fetchImpl/now 均可注入（单测无网络、无 HOME 依赖）。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { PRESET_SCHEMA, type ApiForm, type Preset } from "../src/shared/rpc-contract.ts";
import curatedJson from "./providers.json" with { type: "json" };

/** models.dev api.json 地址（spec 点名）。 */
export const MODELS_DEV_API_URL = "https://models.dev/api.json";

/** 缓存 TTL（spec：7 天）。 */
export const MODELS_DEV_CACHE_TTL_MS = 7 * 86_400_000;

/** 缓存路径（默认 ~/.aifly/cache/models-dev.json；测试注入）。 */
export function modelsDevCachePath(base = homedir()): string {
  return join(base, ".aifly", "cache", "models-dev.json");
}

// ---------------------------------------------------------------------------
// 精选集
// ---------------------------------------------------------------------------

const CURATED_FILE_SCHEMA = z.strictObject({
  version: z.literal(1),
  providers: z.array(PRESET_SCHEMA).min(1),
});

/** 精选预设（模块加载即校验；仓库内数据损坏应 fail-fast 而非静默降级）。 */
export function loadCuratedPresets(): Preset[] {
  const parsed = CURATED_FILE_SCHEMA.parse(curatedJson);
  return parsed.providers;
}

// ---------------------------------------------------------------------------
// models.dev 长尾
// ---------------------------------------------------------------------------

/** api.json 中 provider 级条目的最小投影（防御性：多余字段忽略）。 */
const API_JSON_PROVIDER_SCHEMA = z.object({
  id: z.string().min(1).max(128),
  name: z.string().max(256).optional(),
  /** 显式 base URL（SDK 缺省时缺失——长尾只收录显式 api 的条目）。 */
  api: z.string().max(2048).optional(),
  /** 惯用 env 名列表（取首个）。 */
  env: z.array(z.string().max(256)).max(16).optional(),
  /** npm 包名（apiForm 归类依据）。 */
  npm: z.string().max(256).optional(),
});

const API_JSON_SCHEMA = z.record(z.string(), API_JSON_PROVIDER_SCHEMA);

/** 缓存文件形状：原始 api.json 文本 + 抓取时间。 */
const CACHE_FILE_SCHEMA = z.strictObject({
  fetchedAt: z.number().int().min(0),
  raw: z.string().min(2),
});

/** 长尾结果：presets 可为空数组；不可用时 error 说明原因（精选集不受影响）。 */
export interface ModelsDevResult {
  presets: Preset[];
  /** 本次结果来源。 */
  origin: "fetch" | "cache";
  error?: string;
}

export interface ModelsDevOptions {
  /** 缓存文件路径（默认 ~/.aifly/cache/models-dev.json）。 */
  cachePath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** 强制刷新（忽略未过期缓存）。 */
  force?: boolean;
}

/**
 * npm 包名 → apiForm 归类（spec：npm 含 openai-compatible→openai-completions、
 * anthropic→anthropic-messages、google→gemini-native、其它归 openai-completions
 * 并标 unverified）。
 */
export function classifyApiForm(npm: string | undefined): { apiForm: ApiForm; unverified: boolean } {
  const pkg = npm ?? "";
  if (pkg.includes("anthropic")) return { apiForm: "anthropic-messages", unverified: false };
  if (pkg.includes("google")) return { apiForm: "gemini-native", unverified: false };
  if (pkg.includes("openai")) return { apiForm: "openai-completions", unverified: false };
  return { apiForm: "openai-completions", unverified: true };
}

/** 长尾 defaultPort：id 的 FNV-1a 哈希映射到 20000..64999（确定性；监听期冲突由端口回退兜底）。 */
export function derivedPortFor(id: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(id, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 20000 + (hash % 45000);
}

/** 从 api.json 原始文本派生长尾预设（跳过无显式 api 的条目；排除精选集已覆盖的 id）。 */
export function deriveModelsDevPresets(raw: string, curatedIds: ReadonlySet<string>): Preset[] {
  const parsed: unknown = JSON.parse(raw);
  const providers = API_JSON_SCHEMA.parse(parsed);
  const out: Preset[] = [];
  for (const [id, provider] of Object.entries(providers)) {
    if (provider.api === undefined || provider.api === "") continue;
    if (curatedIds.has(id)) continue; // 精选集胜出（出处更可信）
    if (!/^https?:\/\//.test(provider.api)) continue;
    const { apiForm, unverified } = classifyApiForm(provider.npm);
    let host: string;
    try {
      host = new URL(provider.api).hostname;
    } catch {
      continue;
    }
    const keyEnv = provider.env?.[0];
    out.push(
      PRESET_SCHEMA.parse({
        id,
        label: provider.name && provider.name !== "" ? provider.name : id,
        apiForm,
        baseUrl: provider.api,
        ...(keyEnv !== undefined ? { keyEnv } : {}),
        defaultPort: derivedPortFor(id),
        matchDomains: [host],
        source: "models.dev",
        ...(unverified ? { unverified: true } : {}),
      }),
    );
  }
  return out;
}

/** 读取并校验缓存（损坏/不存在返回 undefined）。 */
function readCache(cachePath: string): { raw: string; fetchedAt: number } | undefined {
  try {
    return CACHE_FILE_SCHEMA.parse(JSON.parse(readFileSync(cachePath, "utf8")));
  } catch {
    return undefined;
  }
}

/** 原子写缓存（失败静默：缓存写失败不致命）。 */
function writeCache(cachePath: string, raw: string, fetchedAt: number): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}`;
    writeFileSync(tmp, `${JSON.stringify({ fetchedAt, raw }, undefined, 2)}\n`);
    renameSync(tmp, cachePath);
  } catch {
    // 缓存写失败不致命：本次结果仍可用
  }
}

/** 拉取（或回退缓存）models.dev 长尾。失败且无可用缓存时返回 error 结果（不抛）。 */
export async function fetchModelsDevPresets(
  curated: readonly Preset[],
  opts: ModelsDevOptions = {},
): Promise<ModelsDevResult> {
  const now = opts.now ?? Date.now;
  const cachePath = opts.cachePath ?? modelsDevCachePath();
  const doFetch = opts.fetchImpl ?? fetch;
  const curatedIds = new Set(curated.map((p) => p.id));

  const cached = readCache(cachePath);
  if (!opts.force && cached !== undefined && now() - cached.fetchedAt < MODELS_DEV_CACHE_TTL_MS) {
    return { presets: deriveModelsDevPresets(cached.raw, curatedIds), origin: "cache" };
  }

  try {
    const response = await doFetch(MODELS_DEV_API_URL, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const raw = await response.text();
    JSON.parse(raw); // 形状校验在派生层；这里只确保是 JSON
    writeCache(cachePath, raw, now());
    return { presets: deriveModelsDevPresets(raw, curatedIds), origin: "fetch" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cached !== undefined) {
      return {
        presets: deriveModelsDevPresets(cached.raw, curatedIds),
        origin: "cache",
        error: `fetch failed (${message}); serving cached copy`,
      };
    }
    return { presets: [], origin: "cache", error: `fetch failed (${message}) and no cache available` };
  }
}

/** 快速探测缓存是否存在（UI 展示「长尾不可用」状态用）。 */
export function hasModelsDevCache(cachePath = modelsDevCachePath()): boolean {
  return existsSync(cachePath);
}
