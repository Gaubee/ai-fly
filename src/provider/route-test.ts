// 提供方侧按标准路由测试（Owner 裁决 2026-09-11：Advanced services 行内
// test 与 connect ③ 同形态）：构造最小 AI-API 请求 → 本地路由命中
// （buildUpstreamRequest：prefix/pattern + 白名单）→ rewrite 注入
// （$secret/$env）→ 直打 upstream → 归纳结果（成功也读回复摘录）。
// 与消费侧 testLocalService 的差异：不经本地网关/fabric——验证的是提供方
// 自己的服务配置（路由表 + 凭据注入 + upstream 连通）。
// 正交意图：模型挑选在 rpc-router 侧完成后经入参传入；fetch/now/env/secrets
// 可注入。

import { formProbe } from "../consumer/local-test.ts";
import { ROUTE_LOCAL_PREFIX, type RouteForm } from "../shared/rpc-contract.ts";
import type { ReqHeader } from "../wire/frames.ts";
import { buildUpstreamRequest, PathNotOfferedError } from "./rewrite.ts";
import type { EnvSource, SecretSource } from "./rewrite.ts";
import type { ServiceConfig } from "./store.ts";

export interface RouteTestInput {
  service: ServiceConfig;
  form: RouteForm;
  /** 显式端点路径（缺省 = 规范前缀）。 */
  localPrefix?: string | undefined;
  model?: string | undefined;
  /** 单轮提示词（缺省 "hi"）。 */
  content?: string | undefined;
  env?: EnvSource | undefined;
  secrets?: SecretSource | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  now?: (() => number) | undefined;
}

export interface RouteTestResult {
  ok: boolean;
  latencyMs: number;
  request: { method: "POST"; url: string; model?: string };
  httpStatus?: number;
  error?: string;
  bodyExcerpt?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const BODY_EXCERPT_MAX = 2000;

export async function testServiceRoute(input: RouteTestInput): Promise<RouteTestResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const started = now();
  const probe = formProbe(
    input.form,
    input.localPrefix ?? ROUTE_LOCAL_PREFIX[input.form],
    input.model,
    input.content?.trim() !== "" && input.content !== undefined ? input.content : "hi",
  );
  const baseRequest = {
    method: "POST" as const,
    url: probe.path,
    ...(input.model !== undefined ? { model: input.model } : {}),
  };
  // 帧头按 wire 形状组装（id/serviceId 仅占位——不进 fabric，本地构造即弃）
  const req: ReqHeader = {
    v: 1,
    id: "provider-route-test",
    serviceId: input.service.serviceId,
    method: "POST",
    path: probe.path,
    headers: probe.headers,
    contentType: "application/json",
    bodyLen: 0,
  };
  try {
    const plan = await buildUpstreamRequest(input.service, req, input.env, input.secrets);
    // UpstreamPlan.host（rewrite.hostHeader 覆盖）是网关职责；undici fetch 亦
    // 禁改 Host 头——测试请求用 URL 本身的主机（缺省即上游 host）
    const response = await fetchImpl(plan.url, {
      method: "POST",
      headers: plan.headers,
      body: JSON.stringify(probe.body),
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const latencyMs = Math.max(0, now() - started);
    const ok = response.status >= 200 && response.status < 300;
    const text = await response.text().catch(() => "");
    const bodyExcerpt = text === "" ? undefined : text.slice(0, BODY_EXCERPT_MAX);
    return {
      ok,
      latencyMs,
      request: { ...baseRequest, url: plan.url.toString() },
      httpStatus: response.status,
      ...(!ok && response.status >= 500 ? { error: `upstream error (HTTP ${response.status})` } : {}),
      ...(bodyExcerpt !== undefined ? { bodyExcerpt } : {}),
    };
  } catch (error) {
    const latencyMs = Math.max(0, now() - started);
    const message =
      error instanceof PathNotOfferedError
        ? `path not offered - ${probe.path} matches no declared route (whitelist)`
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, latencyMs, request: baseRequest, error: message };
  }
}
