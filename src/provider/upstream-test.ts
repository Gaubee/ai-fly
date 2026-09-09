// 上游连通性测试（provider-local）：对「草稿或已存服务形状」（upstream、apiForm、
// secretName、model?）发一次最小单轮请求，报告 ok/httpStatus/latencyMs/model。
// 正交意图（本文件不实现）：
// - 密钥库存取（secrets.ts；本文件只按 secretName 取值并注入请求头——与转发路径
//   同源的完整头值语义，如 "Bearer sk-…"）；
// - 模型清单解析（presets/models-dev.ts；model 缺省时按 upstream 定位 provider
//   取 priced chat 最低价模型）；
// - 转发/限额/fabric（测试 MUST provider-local：不落盘、不计限额、不经 fabric——
//   本模块是纯函数级一次 fetch，无任何引擎状态）。
// 失败语义：全部以结果对象返回（ok=false + error），绝不抛——RPC 面直接透出。
// 错误文本 MUST NOT 包含密钥值（网络错误摘要做密钥串剔除兜底）。

import type { ApiForm } from "../shared/rpc-contract.ts";
import { deriveModels, findModelsDevProviderKey } from "../../presets/models-dev.ts";

/** 密钥读取面（SecretsStore 的结构子集；测试可注入内存假体）。 */
export interface UpstreamTestSecrets {
  get(name: string): string | undefined;
}

export interface UpstreamTestInput {
  /** 上游基址（http(s)；调用方已过 URL 校验）。 */
  upstream: string;
  /** API 形态（缺省 openai-completions）。 */
  apiForm?: ApiForm | undefined;
  /** 密钥库名（给定则从 secretsStore 取完整头值注入；缺密钥 = 结果级失败）。 */
  secretName?: string | undefined;
  /** 显式模型（缺省按 modelsRaw 选 priced chat 最低价）。 */
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
}

const DEFAULT_TIMEOUT_MS = 20_000;
const ERROR_SUMMARY_MAX = 200;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
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

/** model 缺省选择：按 upstream 定位 api.json provider，取 priced chat 最低价（复用 deriveModels 排序）。 */
function pickDefaultModel(modelsRaw: string | undefined, upstream: string): string | undefined {
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
 * 执行一次最小连通测试。三个 apiForm 的请求形状（spec「上游连通性测试」）：
 * - openai-completions: POST {upstream}/chat/completions，max_tokens:1，authorization 头
 * - anthropic-messages: POST {upstream}/v1/messages，max_tokens:1，authorization +
 *   anthropic-version: 2023-06-01
 * - gemini-native: POST {upstream}/v1beta/models/{model}:generateContent，
 *   generationConfig.maxOutputTokens:1，密钥经 x-goog-api-key（无 secret 则不带）
 */
export async function testUpstream(input: UpstreamTestInput): Promise<UpstreamTestResult> {
  const fetchFn = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;

  // 1) 密钥解析：缺失/空值 = 结果级失败（不抛、零网络）。
  let secretValue: string | undefined;
  if (input.secretName !== undefined) {
    secretValue = input.secretsStore?.get(input.secretName);
    if (secretValue === undefined || secretValue === "") {
      return { ok: false, latencyMs: 0, model: input.model ?? "", error: "secret not found" };
    }
  }

  // 2) 模型：显式优先；缺省从 api.json 清单取 priced chat 最低价；清单不可用即失败。
  let model = input.model;
  if (model === undefined) {
    const chosen = pickDefaultModel(input.modelsRaw, input.upstream);
    if (chosen === undefined) {
      return { ok: false, latencyMs: 0, model: "", error: "model list unavailable; specify a model" };
    }
    model = chosen;
  }

  // 3) 按 apiForm 构造最小请求（单轮 "ping"、最小 max tokens、JSON 正文）。
  const apiForm = input.apiForm ?? "openai-completions";
  const base = trimTrailingSlash(input.upstream);
  const headers: Record<string, string> = { "content-type": "application/json" };
  let url: string;
  let body: string;
  if (apiForm === "openai-completions") {
    url = `${base}/chat/completions`;
    body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    });
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

  // 4) 发送（整体超时 AbortController；结果级返回）。
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const startedAt = now();
  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers,
      body,
      signal: ctrl.signal,
    });
    const latencyMs = now() - startedAt;
    void response.body?.cancel().catch(() => undefined); // 不消费正文：释放连接
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, httpStatus: response.status, latencyMs, model };
    }
    return {
      ok: false,
      httpStatus: response.status,
      latencyMs,
      model,
      error: `upstream returned HTTP ${response.status}`,
    };
  } catch (err) {
    const latencyMs = now() - startedAt;
    const timedOut = ctrl.signal.aborted;
    return {
      ok: false,
      latencyMs,
      model,
      error: timedOut ? "request timed out" : summarizeError(err, secretValue),
    };
  } finally {
    clearTimeout(timer);
  }
}
