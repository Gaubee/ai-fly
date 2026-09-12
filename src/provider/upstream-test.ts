// 上游连通性测试（provider-local）：对「草稿或已存服务形状」（upstream、apiForm、
// secretName、model?）发一次最小单轮请求，报告 ok/httpStatus/latencyMs/model/request。
// 正交意图（本文件不实现）：
// - 密钥库存取（secrets.ts；本文件只按 secretName resolve 出最终头值——bearerPrefix
//   默认拼 "Bearer "，Owner 裁决 2026-09-10：密钥值默认是裸 key）；
// - 模型清单解析（presets/models-dev.ts；model 缺省时按 upstream 定位 provider
//   取 priced chat 最低价模型；api.json 不覆盖的自定义上游回退探测 {upstream}/models）；
// - 转发/限额/fabric（测试 MUST provider-local：不落盘、不计限额、不经 fabric——
//   本模块是纯函数级一次 fetch，无任何引擎状态）。
// 失败语义：全部以结果对象返回（ok=false + error），绝不抛——RPC 面直接透出。
// 错误文本 MUST NOT 包含密钥值（网络错误摘要做密钥串剔除兜底）。

import type { ApiForm } from "../shared/rpc-contract.ts";
import { deriveModels, findModelsDevProviderKey } from "../../presets/models-dev.ts";

/** 密钥读取面（SecretsStore 的结构子集；测试可注入内存假体）。 */
export interface UpstreamTestSecrets {
  resolve(name: string): { headerValue: string } | undefined;
}

export interface UpstreamTestInput {
  /** 上游基址（http(s)；调用方已过 URL 校验）。 */
  upstream: string;
  /** API 形态（缺省 openai-completions）。 */
  apiForm?: ApiForm | undefined;
  /** 密钥库名（给定则从 secretsStore resolve 最终头值注入；缺密钥 = 结果级失败）。 */
  secretName?: string | undefined;
  /** 显式模型（缺省按 modelsRaw 选 priced chat 最低价；再缺则探测 /models）。 */
  model?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  secretsStore?: UpstreamTestSecrets | undefined;
  /** api.json 原始文本（models.dev 缓存；模型缺省选择用）。 */
  modelsRaw?: string | undefined;
  /** 整体超时（默认 20s；测试注入小值）。 */
  timeoutMs?: number | undefined;
  now?: (() => number) | undefined;
}

export interface UpstreamTestResult {
  ok: boolean;
  httpStatus?: number;
  latencyMs: number;
  model: string;
  error?: string;
  /** 请求详情（发起过请求即有；UI 呈现「发了什么」——Owner 2026-09-10 验收要求）。 */
  request?: { method: "POST"; url: string; model: string };
  /** 模型选择来源（models.dev 缓存 / 上游 /models 探测 / 显式指定）。 */
  modelSource?: "models.dev" | "upstream-probe" | "explicit";
}

const DEFAULT_TIMEOUT_MS = 20_000;
const ERROR_SUMMARY_MAX = 200;
const BODY_EXCERPT_MAX = 300;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** base 路径已带版本段（/v1、/v1beta、/compatible-mode/v1 等）时不再补 /v1
    （M3-r4：openai 预设 base 去 /v1 改由路由模型接管，两形态都要可用）。 */
function endsWithVersionSegment(base: string): boolean {
  return /\/v\d+[a-z]*$/.test(base);
}

/** 网络错误摘要（截断；若摘要意外含密钥原文则整段打码——防御式）。 */
function summarizeError(err: unknown, secretValue: string | undefined): string {
  const message = err instanceof Error ? err.message : String(err);
  let summary = message.slice(0, ERROR_SUMMARY_MAX);
  if (summary === "") summary = "request failed";
  if (secretValue !== undefined && secretValue !== "" && summary.includes(secretValue)) {
    summary = "request failed";
  }
  return summary;
}

/** model 缺省选择：按 upstream 定位 api.json provider，取 priced chat 最低价（复用 deriveModels 排序）。
    （M3-r4 起消费侧测试也复用——models.dev 缓存按 upstream 主机名命中。） */
export function pickDefaultModel(modelsRaw: string | undefined, upstream: string): string | undefined {
  if (modelsRaw === undefined || modelsRaw === "") return undefined;
  const providerKey = findModelsDevProviderKey(modelsRaw, upstream);
  if (providerKey === undefined) return undefined;
  let models: ReturnType<typeof deriveModels>;
  try {
    models = deriveModels(modelsRaw, providerKey);
  } catch {
    return undefined;
  }
  if (models === undefined || models.length === 0) return undefined;
  // deriveModels 已按「chat 且价已知升序」排好；无价已知时退而取首个 chat 条目。
  return (models.find((m) => m.chat && m.priced) ?? models.find((m) => m.chat))?.id;
}

/**
 * 探测 OpenAI 兼容上游的模型清单（GET {upstream}/models，带密钥）：自定义中转站
 * 不在 models.dev 覆盖内的回退路径。返回 id 列表（尽量挑便宜档：mini/flash/
 * small/lite 优先）；失败返回 undefined（原因不抛出，由调用方组合错误文本）。
 */
export async function probeUpstreamModels(input: {
  upstream: string;
  secretName?: string | undefined;
  secretsStore?: UpstreamTestSecrets | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}): Promise<string[] | undefined> {
  const fetchFn = input.fetchImpl ?? fetch;
  const headers: Record<string, string> = { accept: "application/json" };
  if (input.secretName !== undefined) {
    const resolved = input.secretsStore?.resolve(input.secretName);
    if (resolved === undefined) return undefined;
    headers.authorization = resolved.headerValue;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchFn(
      `${trimTrailingSlash(input.upstream)}${endsWithVersionSegment(trimTrailingSlash(input.upstream)) ? "/models" : "/v1/models"}`,
      {
        headers,
        signal: ctrl.signal,
      },
    );
    if (!(response.status >= 200 && response.status < 300)) return undefined;
    const parsed = (await response.json()) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(parsed?.data)) return undefined;
    const ids = parsed.data
      .map((m) => (typeof m?.id === "string" ? m.id : undefined))
      .filter((id): id is string => id !== undefined);
    if (ids.length === 0) return undefined;
    // 便宜档优先（无价格信息，按命名启发式）；保持上游相对顺序稳定。
    const cheap = ids.filter((id) => /mini|flash|small|lite|nano|turbo/i.test(id));
    return [...cheap, ...ids.filter((id) => !cheap.includes(id))];
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 执行一次最小连通测试。四个 apiForm 的请求形状（spec「上游连通性测试」）：
 * - openai-completions: POST {upstream}/chat/completions，max_tokens:1，authorization 头
 * - openai-responses: POST {upstream}/responses，input:"ping"，max_output_tokens:1，authorization 头（cli-codex）
 * - anthropic-messages: POST {upstream}/v1/messages，max_tokens:1，authorization +
 *   anthropic-version: 2023-06-01
 * - gemini-native: POST {upstream}/v1beta/models/{model}:generateContent，
 *   generationConfig.maxOutputTokens:1，密钥经 x-goog-api-key（无 secret 则不带）
 */
export async function testUpstream(input: UpstreamTestInput): Promise<UpstreamTestResult> {
  const fetchFn = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;

  // 1) 密钥解析（bearerPrefix 语义在 resolve 内）：缺失/空值 = 结果级失败（不抛、零网络）。
  let secretValue: string | undefined;
  if (input.secretName !== undefined) {
    secretValue = input.secretsStore?.resolve(input.secretName)?.headerValue;
    if (secretValue === undefined || secretValue === "") {
      return { ok: false, latencyMs: 0, model: input.model ?? "", error: "secret not found" };
    }
  }

  // 2) 模型：显式 > models.dev 缓存（priced chat 最低价）> 上游 /models 探测（便宜档启发式）。
  let model = input.model;
  let modelSource: UpstreamTestResult["modelSource"];
  if (model !== undefined) {
    modelSource = "explicit";
  } else {
    const fromCache = pickDefaultModel(input.modelsRaw, input.upstream);
    if (fromCache !== undefined) {
      model = fromCache;
      modelSource = "models.dev";
    } else {
      const probed = await probeUpstreamModels({
        upstream: input.upstream,
        secretName: input.secretName,
        secretsStore: input.secretsStore,
        fetchImpl: fetchFn,
        timeoutMs: input.timeoutMs,
      });
      if (probed !== undefined && probed.length > 0) {
        model = probed[0]!;
        modelSource = "upstream-probe";
      }
    }
    if (model === undefined) {
      return {
        ok: false,
        latencyMs: 0,
        model: "",
        error:
          "no model available: this upstream is not in the models.dev catalog and its /models probe failed - pick a model explicitly or check the api key and network",
      };
    }
  }

  // 3) 按 apiForm 构造最小请求（单轮 "ping"、最小 max tokens、JSON 正文）。
  const apiForm = input.apiForm ?? "openai-completions";
  const base = trimTrailingSlash(input.upstream);
  const headers: Record<string, string> = { "content-type": "application/json" };
  let url: string;
  let body: string;
  if (apiForm === "openai-completions") {
    url = `${base}${endsWithVersionSegment(base) ? "/chat/completions" : "/v1/chat/completions"}`;
    body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    });
    if (secretValue !== undefined) headers.authorization = secretValue;
  } else if (apiForm === "openai-responses") {
    url = `${base}${endsWithVersionSegment(base) ? "/responses" : "/v1/responses"}`;
    body = JSON.stringify({ model, input: "ping", max_output_tokens: 1, stream: false });
    if (secretValue !== undefined) headers.authorization = secretValue;
  } else if (apiForm === "anthropic-messages") {
    url = `${base}/v1/messages`;
    body = JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 });
    if (secretValue !== undefined) headers.authorization = secretValue;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    body = JSON.stringify({
      contents: [{ parts: [{ text: "ping" }] }],
      generationConfig: { maxOutputTokens: 1 },
    });
    if (secretValue !== undefined) headers["x-goog-api-key"] = secretValue;
  }

  // 4) 发送（整体超时 AbortController；结果级返回 + 请求详情与非 2xx 正文摘录）。
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const startedAt = now();
  const requestDetail = { method: "POST" as const, url, model };
  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers,
      body,
      signal: ctrl.signal,
    });
    const latencyMs = now() - startedAt;
    if (response.status >= 200 && response.status < 300) {
      void response.body?.cancel().catch(() => undefined); // 不消费正文：释放连接
      return { ok: true, httpStatus: response.status, latencyMs, model, request: requestDetail, ...(modelSource !== undefined ? { modelSource } : {}) };
    }
    // 非 2xx：读正文摘录（上游错误体是排障第一现场——Owner 2026-09-10 验收要求）
    let excerpt = "";
    try {
      excerpt = (await response.text()).replace(/\s+/g, " ").trim().slice(0, BODY_EXCERPT_MAX);
    } catch {
      // 正文读失败不掩盖状态码
    }
    if (secretValue !== undefined && excerpt.includes(secretValue)) excerpt = "(redacted)";
    return {
      ok: false,
      httpStatus: response.status,
      latencyMs,
      model,
      request: requestDetail,
      ...(modelSource !== undefined ? { modelSource } : {}),
      error:
        excerpt !== ""
          ? `upstream returned HTTP ${response.status}: ${excerpt}`
          : `upstream returned HTTP ${response.status}`,
    };
  } catch (err) {
    const latencyMs = now() - startedAt;
    const timedOut = ctrl.signal.aborted;
    return {
      ok: false,
      latencyMs,
      model,
      request: requestDetail,
      ...(modelSource !== undefined ? { modelSource } : {}),
      error: timedOut ? "request timed out" : summarizeError(err, secretValue),
    };
  } finally {
    clearTimeout(timer);
  }
}
