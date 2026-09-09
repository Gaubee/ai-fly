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
  /** provider 级模型清单（模型/价格 spec：至少 id 与 cost.input/output；缺失视为未知价）。 */
  models: z.record(
    z.string().min(1).max(256),
    z
      .object({
        id: z.string().min(1).max(256).optional(),
        name: z.string().max(512).optional(),
        cost: z
          .object({
            input: z.number().nonnegative().optional(),
            output: z.number().nonnegative().optional(),
          })
          .optional(),
      })
      .passthrough(),
  ).optional(),
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

// ---------------------------------------------------------------------------
// 模型清单与价格（presets spec「模型清单与价格」）
// ---------------------------------------------------------------------------

/** 模型清单条目（RPC presets.models 的输出形状；与契约 schema 一一对应）。 */
export interface ModelCatalogEntry {
  id: string;
  name?: string;
  /** input+output 合计 USD/Mtok；未知价省略。 */
  pricePerMTok?: number;
  /** 价格已知（排序依据）。 */
  priced: boolean;
  /** false = embed/image/tts 等非对话模型（id 启发式）。 */
  chat: boolean;
}

/** non-chat 启发式（spec 点名词族：embed/image/whisper/tts/rerank/moderation/dall-e/sd3）。 */
const NON_CHAT_ID_PATTERN = /embed|image|whisper|tts|rerank|moderation|dall-e|sd3/i;

export function isChatModelId(id: string): boolean {
  return !NON_CHAT_ID_PATTERN.test(id);
}

/** 排序权重：chat 且价已知（价格升序）-> chat 未价 -> non-chat 价已知 -> non-chat 未价。 */
function catalogRank(entry: ModelCatalogEntry): number {
  if (entry.chat) return entry.priced ? 0 : 1;
  return entry.priced ? 2 : 3;
}

/**
 * 从 api.json 原始文本派生某 provider 的模型清单（价格升序、chat 优先、未知价尾排）。
 * provider 不在清单时返回 undefined（调用方按「无目录」处置，区别于空清单）。
 * 模型 id 取条目自带 id（缺省取 record 键——与上游 API 请求 model 参数同源）。
 */
export function deriveModels(raw: string, providerId: string): ModelCatalogEntry[] | undefined {
  const parsed: unknown = JSON.parse(raw);
  const providers = API_JSON_SCHEMA.parse(parsed);
  const provider = providers[providerId];
  if (provider === undefined) return undefined;
  const entries: ModelCatalogEntry[] = [];
  for (const [key, model] of Object.entries(provider.models ?? {})) {
    const id = model.id ?? key;
    const input = model.cost?.input;
    const output = model.cost?.output;
    // 价格 = input+output（USD/Mtok）；任一缺失视为未知价（priced=false）。
    const price = input !== undefined && output !== undefined ? input + output : undefined;
    entries.push({
      id,
      ...(model.name !== undefined ? { name: model.name } : {}),
      ...(price !== undefined ? { pricePerMTok: price } : {}),
      priced: price !== undefined,
      chat: isChatModelId(id),
    });
  }
  entries.sort((a, b) => {
    const rankDiff = catalogRank(a) - catalogRank(b);
    if (rankDiff !== 0) return rankDiff;
    if (a.priced && b.priced) {
      const priceDiff = (a.pricePerMTok ?? 0) - (b.pricePerMTok ?? 0);
      if (priceDiff !== 0) return priceDiff;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return entries;
}

/** URL 规范形态（去尾斜杠）——api 匹配用；非法 URL 原样返回。 */
function normalizedUrlForm(value: string): string {
  try {
    return new URL(value).href.replace(/\/+$/, "");
  } catch {
    return value;
  }
}

/**
 * 按 upstream 基址定位 api.json 中的 provider 键（连通测试的默认模型选择用）：
 * 精确相等 > 路径前缀（任一方向、段边界）> 主机名相等；无命中返回 undefined。
 */
export function findModelsDevProviderKey(raw: string, upstream: string): string | undefined {
  let providers: Record<string, z.infer<typeof API_JSON_PROVIDER_SCHEMA>>;
  try {
    providers = API_JSON_SCHEMA.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
  const target = normalizedUrlForm(upstream);
  let best: { key: string; score: number; apiLen: number } | undefined;
  for (const [key, provider] of Object.entries(providers)) {
    if (provider.api === undefined || provider.api === "") continue;
    const api = normalizedUrlForm(provider.api);
    let score = 0;
    if (api === target) score = 3;
    else if (api.startsWith(`${target}/`) || target.startsWith(`${api}/`)) score = 2;
    else {
      try {
        if (new URL(api).hostname === new URL(target).hostname) score = 1;
      } catch {
        score = 0;
      }
    }
    if (score === 0) continue;
    const candidate = { key, score, apiLen: api.length };
    if (
      best === undefined ||
      candidate.score > best.score ||
      (candidate.score === best.score && candidate.apiLen > best.apiLen) ||
      (candidate.score === best.score && candidate.apiLen === best.apiLen && candidate.key < best.key)
    ) {
      best = candidate;
    }
  }
  return best?.key;
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

/** 只读缓存中的原始 api.json 文本（不存在/损坏返回 undefined——不触发网络）。 */
export function readModelsDevRaw(cachePath = modelsDevCachePath()): string | undefined {
  return readCache(cachePath)?.raw;
}

/** 原始文本结果：raw 缺失（无缓存且拉取失败）时 error 说明原因。 */
export interface ModelsDevRawResult {
  raw: string | undefined;
  origin: "fetch" | "cache";
  error?: string;
}

/**
 * 取原始 api.json（presets.models 与长尾派生共用的数据面）：TTL 内直接回缓存；
 * 过期/未命中先刷新，失败回退缓存并附错误说明（spec：缓存未命中或已过期时
 * SHALL 先尝试刷新，失败回退缓存）。
 */
export async function fetchModelsDevRaw(
  opts: ModelsDevOptions = {},
): Promise<ModelsDevRawResult> {
  const now = opts.now ?? Date.now;
  const cachePath = opts.cachePath ?? modelsDevCachePath();
  const doFetch = opts.fetchImpl ?? fetch;

  const cached = readCache(cachePath);
  if (!opts.force && cached !== undefined && now() - cached.fetchedAt < MODELS_DEV_CACHE_TTL_MS) {
    return { raw: cached.raw, origin: "cache" };
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
    return { raw, origin: "fetch" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cached !== undefined) {
      return {
        raw: cached.raw,
        origin: "cache",
        error: `fetch failed (${message}); serving cached copy`,
      };
    }
    return { raw: undefined, origin: "cache", error: `fetch failed (${message}) and no cache available` };
  }
}

/** 拉取（或回退缓存）models.dev 长尾。失败且无可用缓存时返回 error 结果（不抛）。 */
export async function fetchModelsDevPresets(
  curated: readonly Preset[],
  opts: ModelsDevOptions = {},
): Promise<ModelsDevResult> {
  const result = await fetchModelsDevRaw(opts);
  const curatedIds = new Set(curated.map((p) => p.id));
  if (result.raw === undefined) {
    return {
      presets: [],
      origin: "cache",
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }
  return {
    presets: deriveModelsDevPresets(result.raw, curatedIds),
    origin: result.origin,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

/** 快速探测缓存是否存在（UI 展示「长尾不可用」状态用）。 */
export function hasModelsDevCache(cachePath = modelsDevCachePath()): boolean {
  return existsSync(cachePath);
}
