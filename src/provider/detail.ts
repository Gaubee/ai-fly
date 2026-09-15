// 服务脱敏披露视图（hooks-lifecycle v2 四槽）：把服务配置投影为 wire 目录载荷
// （AUTH_OK 与分享链接共用）的 ServiceEntry / ServiceDetail。
// 正交意图：
// - 只做"披露投影"，不校验、不落盘（schema 形状由 wire/frames.ts 锁定，槽位语义
//   由 provider/lifecycle.ts 单源冻结）；
// - 脱敏规则（v2）：auth 槽整值掩码 ●（secret 名 / script 绑定 / literal 值均为
//   凭证语义——名称与值都不出网），bearer 开关可见；headers.set 的 $env:/$secret:
//   间接引用整体掩码（引用名与值都不出），纯字面量原样披露（"除凭据值外无隐藏"）；
//   headers.script / request / response 的脚本绑定掩码（无脚本名与 args）；
// - upstream 与 match 全集原样披露；rewrite 仅剩 host/prefix（头改写能力已迁出
//   至 headers 槽）；输入为结构化形状（store v2 四槽；v1 过渡期字段被忽略）。

import type { ServiceDetail, ServiceEntry } from "../wire/frames.ts";
import { routeLocalPrefix } from "../shared/rpc-contract.ts";
import type { ServiceConfig } from "./store.ts";
import {
  SERVICE_VALUE_MASK,
  type AuthSlot,
  type HeadersSlot,
  type ServiceLifecycleSlots,
} from "./lifecycle.ts";

// 间接引用语义单源在 lifecycle.ts；此处 re-export 维持既有 import 面
// （rewrite.ts 等消费方不变）。
export {
  ENV_REF_PREFIX,
  SECRET_REF_PREFIX,
  SERVICE_VALUE_MASK,
  isEnvRef,
  isMaskedRef,
  isSecretRef,
} from "./lifecycle.ts";

/** $env/$secret 间接引用的脱敏掩码（payload 内使用；终端展示另用 ASCII 形式）。 */
export const ENV_VALUE_MASK = SERVICE_VALUE_MASK;

/**
 * 投影输入（结构化形状）：接受 store v2 服务配置（四槽 + 瘦身 rewrite），v1
 * 过渡期配置（rewrite.headerSet 等额外字段）结构兼容——额外字段被本投影忽略。
 */
export type ServiceDisclosureSource = Pick<ServiceConfig, "upstream" | "match"> &
  Partial<Pick<ServiceConfig, "rewrite" | "routes">> &
  ServiceLifecycleSlots;

/** 前缀重写规则的披露形态：strip:/a 与 append:/b 的组合标记。 */
function prefixDisclosure(rewrite: NonNullable<ServiceConfig["rewrite"]>): string | undefined {
  const tokens: string[] = [];
  if (rewrite.pathPrefixStrip !== undefined) tokens.push(`strip:${rewrite.pathPrefixStrip}`);
  if (rewrite.pathPrefixAppend !== undefined) tokens.push(`append:${rewrite.pathPrefixAppend}`);
  return tokens.length === 0 ? undefined : tokens.join(" ");
}

/** auth 槽脱敏：三族整值掩码 ●（凭证语义——密钥名/脚本绑定/字面量值都不出网）。 */
function maskAuthSlot(auth: AuthSlot): NonNullable<ServiceDetail["auth"]> {
  const bearer = "bearer" in auth && auth.bearer !== undefined ? { bearer: auth.bearer } : {};
  if ("secret" in auth) return { secret: SERVICE_VALUE_MASK, ...bearer };
  if ("script" in auth) return { script: SERVICE_VALUE_MASK, ...bearer };
  return { literal: SERVICE_VALUE_MASK, ...bearer };
}

/** headers 槽脱敏：引用型字面量 → ●（名与值都不出）；纯字面量原样；脚本绑定掩码。 */
function maskHeadersSlot(slot: HeadersSlot): NonNullable<ServiceDetail["headers"]> {
  const out: NonNullable<ServiceDetail["headers"]> = {};
  if (slot.remove !== undefined) out.remove = [...slot.remove];
  if (slot.set !== undefined) {
    out.set = Object.fromEntries(
      Object.entries(slot.set).map(([name, value]) => [
        name,
        value.startsWith("$env:") || value.startsWith("$secret:") ? SERVICE_VALUE_MASK : value,
      ]),
    );
  }
  if (slot.script !== undefined) out.script = { name: SERVICE_VALUE_MASK };
  return out;
}

/** 服务完整配置的脱敏披露（v2 四槽：脚本/密钥/引用注入位 → ●）。 */
export function buildServiceDetail(service: ServiceDisclosureSource): ServiceDetail {
  // wire schema 中 rewrite 为必填对象（子字段可选）：无重写配置时输出空 rewrite。
  const rewrite: NonNullable<ServiceDetail["rewrite"]> = {};
  if (service.rewrite !== undefined) {
    if (service.rewrite.host !== undefined) rewrite.host = service.rewrite.host;
    const prefix = prefixDisclosure(service.rewrite);
    if (prefix !== undefined) rewrite.prefix = prefix;
  }
  const detail: ServiceDetail = {
    upstream: service.upstream,
    match: service.match.map((m) => ({ type: m.type, value: m.value })),
    rewrite,
    ...(service.routes !== undefined && service.routes.length > 0
      ? {
          routes: service.routes.map((r) =>
            r.mode === "pattern"
              ? { forms: r.forms, mode: "pattern" as const, matchPattern: r.matchPattern, template: r.template }
              : {
                  forms: r.forms,
                  localPrefix: routeLocalPrefix(r),
                  upstreamPrefix: r.upstreamPrefix ?? "",
                },
          ),
        }
      : {}),
  };
  if (service.auth !== undefined) detail.auth = maskAuthSlot(service.auth);
  if (service.headers !== undefined) detail.headers = maskHeadersSlot(service.headers);
  if (service.request !== undefined) detail.request = { script: SERVICE_VALUE_MASK };
  if (service.response !== undefined) detail.response = { script: SERVICE_VALUE_MASK };
  return detail;
}

/** 目录服务条目输入：披露源 + 条目身份字段。 */
export type ServiceEntrySource = ServiceDisclosureSource &
  Pick<ServiceConfig, "serviceId" | "name" | "defaultPort">;

/** 目录服务条目（含 detail 脱敏披露）。 */
export function buildServiceEntry(service: ServiceEntrySource): ServiceEntry {
  return {
    serviceId: service.serviceId,
    name: service.name,
    match: service.match.map((m) => ({ type: m.type, value: m.value })),
    defaultPort: service.defaultPort,
    detail: buildServiceDetail(service),
  };
}

/**
 * detail 的 ASCII 展示形（CLI status --verbose 用；用户面文案码位 < 128，故 ●
 * 在终端侧替换为 <hidden>——掩码位统一中性词）。按生命周期阶段输出。
 */
export function detailDisplayLines(detail: ServiceDetail): string[] {
  const lines: string[] = [`upstream: ${detail.upstream}`];
  for (const m of detail.match) lines.push(`match: ${m.type} ${m.value}`);
  for (const r of detail.routes ?? []) {
    const forms = r.forms.length > 0 ? ` (${r.forms.join("+")})` : "";
    if (r.mode === "pattern") {
      lines.push(`route: ${r.matchPattern} => ${r.template}${forms}`);
    } else {
      const to = r.upstreamPrefix === "" ? "(root)" : r.upstreamPrefix;
      lines.push(`route: ${r.localPrefix} -> ${to}${forms}`);
    }
  }
  if (detail.rewrite !== undefined) {
    const r = detail.rewrite;
    if (r.host !== undefined) lines.push(`host: ${r.host}`);
    if (r.prefix !== undefined) lines.push(`prefix: ${r.prefix}`);
  }
  if (detail.auth !== undefined) {
    const a = detail.auth;
    const kind = "secret" in a ? "secret" : "script" in a ? "script" : "literal";
    const bearer = "bearer" in a && a.bearer === false ? " (bearer off)" : "";
    lines.push(`auth: ${kind} <hidden>${bearer}`);
  }
  if (detail.headers !== undefined) {
    const h = detail.headers;
    for (const [name, value] of Object.entries(h.set ?? {})) {
      lines.push(`header-set: ${name}: ${value === SERVICE_VALUE_MASK ? "<hidden>" : value}`);
    }
    for (const name of h.remove ?? []) lines.push(`header-remove: ${name}`);
    if (h.script !== undefined) lines.push(`headers-script: <hidden>`);
  }
  if (detail.request !== undefined) lines.push(`request: script <hidden>`);
  if (detail.response !== undefined) lines.push(`response: script <hidden>`);
  return lines;
}
