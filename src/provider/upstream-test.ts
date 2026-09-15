// 上游连通性测试（provider-local）：对「草稿或已存服务形状」（upstream、apiForm、
// **auth 槽草稿**（{secret}|{script,args?}|{literal} + bearer 开关）、model?）发
// 一次最小单轮请求，报告 ok/httpStatus/latencyMs/model/request。
// hooks-lifecycle 5.2：注入路径改读草稿 auth 槽——secret → 密钥库原样值；
// script → resolveStageAuth 阶段函数；literal → 原样/$env:/$secret: 间接引用解析；
// bearer 开关同转发路径（默认拼、已带 Bearer 不重复、关则原样）。不再接受
// secretName 单字段。
// 正交意图（本文件不实现）：
// - 密钥库存取（secrets.ts；本文件只按草稿解析出最终注入值）；
// - 模型清单解析（presets/models-dev.ts；model 缺省时按 upstream 定位 provider
//   取 priced chat 最低价模型；api.json 不覆盖的自定义上游回退探测 {upstream}/models）；
// - 转发/限额/fabric（测试 MUST provider-local：不落盘、不计限额、不经 fabric——
//   本模块是纯函数级一次 fetch，无任何引擎状态）。
// 失败语义：全部以结果对象返回（ok=false + error），绝不抛——RPC 面直接透出。
// 错误文本 MUST NOT 包含密钥值（网络错误摘要做密钥串剔除兜底）。

import type { ApiForm } from "../shared/rpc-contract.ts";
import { deriveModels, findModelsDevProviderKey } from "../../presets/models-dev.ts";
import { resolveStageAuth, type StageRequestCtx } from "./hook.ts";
import type { AuthSlot } from "./lifecycle.ts";
import { applyBearerPrefix, resolveLiteralHeaderValue } from "./rewrite.ts";

/** 密钥读取面（SecretsStore 的结构子集；测试可注入内存假体）。 */
export interface UpstreamTestSecrets {
  resolve(name: string): { headerValue: string } | undefined;
}

export interface UpstreamTestInput {
  /** 上游基址（http(s)；调用方已过 URL 校验）。 */
  upstream: string;
  /** API 形态（缺省 openai-completions）。 */
  apiForm?: ApiForm | undefined;
  /** auth 槽草稿（hooks-lifecycle 5.2：三族单选 + 可选 bearer）。 */
  auth?: AuthSlot | undefined;
  /** 显式模型（缺省按 modelsRaw 选 priced chat 最低价；再缺则探测 /models）。 */
  model?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  secretsStore?: UpstreamTestSecrets | undefined;
  /** literal `$env:` 解析源（缺省 process.env）。 */
  env?: Record<string, string | undefined> | undefined;
  /** auth.script 的脚本库 home / 测试加载缝（缺省真实加载）。 */
  home?: string | undefined;
  loader?: ((name: string, home: string) => Record<string, unknown> | undefined) | undefined;
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
 * 解析 auth 槽草稿为最终注入值（hooks-lifecycle 5.2 注入路径）：
 * - {secret}：密钥库原样值（未命中/空 → Error("secret not found")，结果级失败）；
 * - {script}：resolveStageAuth 阶段函数（失效 → HookMissingError 固定脱敏文案）；
 * - {literal}：原样 / $env:/$secret: 间接引用（$env 空/未设置 → undefined = 不注入；
 *   $secret 未命中 → Error("secret not found")）。
 * bearer 开关同转发路径（默认拼 "Bearer "、已带不重复、false 原样）。
 */
export async function resolveAuthDraft(
  auth: AuthSlot,
  opts: {
    secretsStore?: UpstreamTestSecrets | undefined;
    env?: Record<string, string | undefined> | undefined;
    home?: string | undefined;
    loader?: ((name: string, home: string) => Record<string, unknown> | undefined) | undefined;
    request?: StageRequestCtx | undefined;
  },
): Promise<string | undefined> {
  const secrets = (name: string): string | undefined => opts.secretsStore?.resolve(name)?.headerValue;
  let value: string | undefined;
  if ("secret" in auth) {
    value = secrets(auth.secret);
    if (value === undefined || value === "") throw new Error("secret not found");
  } else if ("script" in auth) {
    value = await resolveStageAuth(
      { script: auth.script, ...(auth.args !== undefined ? { args: auth.args } : {}) },
      {
        ...(opts.request !== undefined ? { request: opts.request } : {}),
        secrets,
        env: (n) => opts.env?.[n] ?? process.env[n],
        ...(opts.home !== undefined ? { home: opts.home } : {}),
        ...(opts.loader !== undefined ? { loader: opts.loader } : {}),
      },
    );
  } else {
    value = resolveLiteralHeaderValue(auth.literal, { env: opts.env ?? process.env, secrets });
    if (value === undefined) return undefined; // $env 空/未设置：不注入
  }
  return applyBearerPrefix(value, auth.bearer);
}

/**
 * 探测 OpenAI 兼容上游的模型清单（GET {upstream}/models，带凭据）：自定义中转站
 * 不在 models.dev 覆盖内的回退路径。凭据二选一：authorization（草稿解析后的最终
 * 头值——连通测试路径）；secretName + secretsStore（presets.models 路径：密钥库
 * 原样值 + 默认 Bearer 规则）。返回 id 列表（尽量挑便宜档：mini/flash/small/lite
 * 优先）；失败返回 undefined（原因不抛出，由调用方组合错误文本）。
 */
export async function probeUpstreamModels(input: {
  upstream: string;
  authorization?: string | undefined;
  secretName?: string | undefined;
  secretsStore?: UpstreamTestSecrets | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}): Promise<string[] | undefined> {
  const fetchFn = input.fetchImpl ?? fetch;
  const headers: Record<string, string> = { accept: "application/json" };
  if (input.authorization !== undefined) {
    headers.authorization = input.authorization;
  } else if (input.secretName !== undefined) {
    const resolved = input.secretsStore?.resolve(input.secretName)?.headerValue;
    if (resolved === undefined) return undefined;
    headers.authorization = applyBearerPrefix(resolved, true);
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
  const apiForm = input.apiForm ?? "openai-completions";
  const base = trimTrailingSlash(input.upstream);

  // 1) 模型预解析（显式 > models.dev 缓存——两步零网络，先于 auth：gemini 形态
  //    请求路径内嵌 model，请求级 ctx 需要它才能给出真实形状；/models 探测
  //    回退依赖凭据，置于 auth 之后）。
  let model = input.model;
  let modelSource: UpstreamTestResult["modelSource"];
  if (model !== undefined) {
    modelSource = "explicit";
  } else {
    const fromCache = pickDefaultModel(input.modelsRaw, input.upstream);
    if (fromCache !== undefined) {
      model = fromCache;
      modelSource = "models.dev";
    }
  }

  // 2) auth 草稿解析（secret/script/literal + bearer）：失效 = 结果级失败
  //    （不抛、零网络；消息脱敏——HookMissingError 固定文案/不含密钥名与值）。
  //    script 族请求级 ctx 与转发路径（rewrite）同契约：POST + 表单路径 +
  //    content-type（model 未知时 gemini 取其静态前缀——探测尚未发生）。
  let authValue: string | undefined;
  if (input.auth !== undefined) {
    const requestPath =
      apiForm === "openai-completions"
        ? `${endsWithVersionSegment(base) ? "/chat/completions" : "/v1/chat/completions"}`
        : apiForm === "openai-responses"
          ? `${endsWithVersionSegment(base) ? "/responses" : "/v1/responses"}`
          : apiForm === "anthropic-messages"
            ? `${endsWithVersionSegment(base) ? "/messages" : "/v1/messages"}`
            : model !== undefined
              ? `${endsWithVersionSegment(base) ? "/models" : "/v1beta/models"}/${encodeURIComponent(model)}:generateContent`
              : endsWithVersionSegment(base)
                ? "/models"
                : "/v1beta/models";
    try {
      authValue = await resolveAuthDraft(input.auth, {
        ...(input.secretsStore !== undefined ? { secretsStore: input.secretsStore } : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
        ...(input.home !== undefined ? { home: input.home } : {}),
        ...(input.loader !== undefined ? { loader: input.loader } : {}),
        request: { method: "POST", path: requestPath, headers: { "content-type": "application/json" } },
      });
    } catch (err) {
      return { ok: false, latencyMs: 0, model: input.model ?? "", error: (err as Error).message };
    }
  }

  // 3) 模型探测回退（models.dev 不覆盖的自定义上游：GET {upstream}/models 带凭据）。
  if (model === undefined) {
    const probed = await probeUpstreamModels({
      upstream: input.upstream,
      ...(authValue !== undefined ? { authorization: authValue } : {}),
      fetchImpl: fetchFn,
      timeoutMs: input.timeoutMs,
    });
    if (probed !== undefined && probed.length > 0) {
      model = probed[0]!;
      modelSource = "upstream-probe";
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

  // 4) 按 apiForm 构造最小请求（单轮 "ping"、最小 max tokens、JSON 正文）。
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
    if (authValue !== undefined) headers.authorization = authValue;
  } else if (apiForm === "openai-responses") {
    url = `${base}${endsWithVersionSegment(base) ? "/responses" : "/v1/responses"}`;
    body = JSON.stringify({ model, input: "ping", max_output_tokens: 1, stream: false });
    if (authValue !== undefined) headers.authorization = authValue;
  } else if (apiForm === "anthropic-messages") {
    // 版本段感知（复核 R2-F5/F6）：baseUrl 依调研原文携带 /v1（如 models.dev
    // 的 api.minimax.io/anthropic/v1）时不再重复拼接。
    url = `${base}${endsWithVersionSegment(base) ? "/messages" : "/v1/messages"}`;
    body = JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 });
    if (authValue !== undefined) headers.authorization = authValue;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    url = `${base}${endsWithVersionSegment(base) ? "/models" : "/v1beta/models"}/${encodeURIComponent(model)}:generateContent`;
    body = JSON.stringify({
      contents: [{ parts: [{ text: "ping" }] }],
      generationConfig: { maxOutputTokens: 1 },
    });
    if (authValue !== undefined) headers["x-goog-api-key"] = authValue;
  }

  // 5) 发送（整体超时 AbortController；结果级返回 + 请求详情与非 2xx 正文摘录）。
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
    if (authValue !== undefined && excerpt.includes(authValue)) excerpt = "(redacted)";
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
      error: timedOut ? "request timed out" : summarizeError(err, authValue),
    };
  } finally {
    clearTimeout(timer);
  }
}
