// 消费侧连通测试（M3-r4）：对本机网关端口按 API 标准发最小请求——这是唯一
// 走完整 wire 链路（本地网关 → fabric → 提供方引擎 → upstream）的测试面；
// 提供方侧的 services.test 只覆盖 provider-local 段。
// 凭据语义：本请求不携带 authorization（本地网关本就剥离凭据头；跨网凭据由
// 提供方 rewrite.headerSet 注入）——这正是与 provider-local 测试的关键差异。
// 正交意图：模型挑选（models.dev 缓存/显式）在 rpc-router 侧完成后经入参传入；
// 本模块只负责「按标准构造最小请求 + 走端口 + 归纳结果」。fetch/now 可注入。

import { ROUTE_LOCAL_PREFIX, type RouteForm } from "../shared/rpc-contract.ts";

export interface LocalTestInput {
  /** 本机网关端口（运行时实际监听值）。 */
  port: number;
  form: RouteForm;
  /** 该标准路由规则的本地前缀（缺省 = 规范前缀；版本段粒度如 /v1）。 */
  localPrefix?: string | undefined;
  /** 已解析的模型名（显式或 models.dev；缺省省略 model 字段——上游 4xx 也能证明链路通）。 */
  model?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  now?: (() => number) | undefined;
}

export interface LocalTestResult {
  ok: boolean;
  latencyMs: number;
  request: { method: "POST"; url: string; model?: string };
  httpStatus?: number;
  error?: string;
  bodyExcerpt?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const BODY_EXCERPT_MAX = 300;
const ERROR_SUMMARY_MAX = 200;

/** 各标准的探测端点与最小请求形状（M3-r6：localPrefix 已含版本段——openai
 *  家族追加版本后缀；anthropic 剥 localPrefix 尾部版本段后由 client 惯例
 *  补 /v1/messages）。 */
function formRequest(
  port: number,
  form: RouteForm,
  localPrefix: string,
  model: string | undefined,
): { url: string; body: Record<string, unknown>; headers: Record<string, string> } {
  const headers: Record<string, string> = { "content-type": "application/json" };
  switch (form) {
    case "openai-chat":
      return {
        url: `http://127.0.0.1:${port}${localPrefix}/chat/completions`,
        headers,
        body: {
          ...(model !== undefined ? { model } : {}),
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        },
      };
    case "openai-responses":
      return {
        url: `http://127.0.0.1:${port}${localPrefix}/responses`,
        headers,
        body: { ...(model !== undefined ? { model } : {}), input: "ping" },
      };
    case "anthropic":
      return {
        url: `http://127.0.0.1:${port}${localPrefix.replace(/\/v\d+$/, "")}/v1/messages`,
        headers: { ...headers, "anthropic-version": "2023-06-01" },
        body: {
          ...(model !== undefined ? { model } : {}),
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        },
      };
  }
}

export async function testLocalService(input: LocalTestInput): Promise<LocalTestResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = now();
  const { url, body, headers } = formRequest(
    input.port,
    input.form,
    input.localPrefix ?? ROUTE_LOCAL_PREFIX[input.form],
    input.model,
  );
  const request = {
    method: "POST" as const,
    url,
    ...(input.model !== undefined ? { model: input.model } : {}),
  };
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Math.max(0, now() - started);
    const ok = response.status >= 200 && response.status < 300;
    let bodyExcerpt: string | undefined;
    if (!ok) {
      const text = await response.text().catch(() => "");
      if (text !== "") bodyExcerpt = text.slice(0, BODY_EXCERPT_MAX);
    }
    return {
      ok,
      latencyMs,
      request,
      httpStatus: response.status,
      ...(!ok && response.status >= 500 ? { error: `upstream/gateway error (HTTP ${response.status})` } : {}),
      ...(bodyExcerpt !== undefined ? { bodyExcerpt } : {}),
    };
  } catch (error) {
    const latencyMs = Math.max(0, now() - started);
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      latencyMs,
      request,
      error: message.slice(0, ERROR_SUMMARY_MAX) || "request failed",
    };
  }
}
