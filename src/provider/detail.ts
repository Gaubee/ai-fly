// 服务脱敏披露视图：把 store 的 ServiceConfig 投影为 wire 目录载荷（AUTH_OK 与
// 分享链接共用）的 ServiceEntry / ServiceDetail。
// 正交意图：
// - 只做"披露投影"，不校验、不落盘（schema 形状由 wire/frames.ts 锁定）；
// - 脱敏规则：rewrite.headerSet 中 `$env:` 引用的值输出 `●`（变量名也不显示——
//   环境变量名本身就是部署侧信息），literal 值原样披露（"除凭据值外无隐藏"）；
// - upstream 与 match 全集原样披露；
// - wire detail schema 只有 host/prefix/headerSet 三字段，headerRemove 无法进帧
//   （schema 已冻结，见任务报告），此处按 schema 形状输出。

import type { ServiceDetail, ServiceEntry } from "../wire/frames.ts";
import type { ServiceConfig } from "./store.ts";

/** $env 间接引用的脱敏掩码（payload 内使用；终端展示另用 ASCII 形式）。 */
export const ENV_VALUE_MASK = "\u25cf"; // ●

export const ENV_REF_PREFIX = "$env:";

/** $secret 引用前缀（密钥库名；与 $env 同样按引用整体掩码）。 */
export const SECRET_REF_PREFIX = "$secret:";

export function isEnvRef(value: string): boolean {
  return value.startsWith(ENV_REF_PREFIX);
}

export function isSecretRef(value: string): boolean {
  return value.startsWith(SECRET_REF_PREFIX);
}

/** 引用型头值（$env:/$secret:）——披露时统一掩码（名与值都不出）。 */
export function isMaskedRef(value: string): boolean {
  return isEnvRef(value) || isSecretRef(value);
}

/** 前缀重写规则的披露形态：strip:/a 与 append:/b 的组合标记。 */
function prefixDisclosure(service: ServiceConfig): string | undefined {
  const rewrite = service.rewrite;
  if (rewrite === undefined) return undefined;
  const tokens: string[] = [];
  if (rewrite.pathPrefixStrip !== undefined) tokens.push(`strip:${rewrite.pathPrefixStrip}`);
  if (rewrite.pathPrefixAppend !== undefined) tokens.push(`append:${rewrite.pathPrefixAppend}`);
  return tokens.length === 0 ? undefined : tokens.join(" ");
}

/** 服务完整配置的脱敏披露（$env 头值 -> ●，变量名不显示）。 */
export function buildServiceDetail(service: ServiceConfig): ServiceDetail {
  // wire schema 中 rewrite 为必填对象（子字段可选）：无重写配置时输出空 rewrite。
  const rewrite: NonNullable<ServiceDetail["rewrite"]> = {};
  if (service.rewrite !== undefined) {
    if (service.rewrite.hostHeader !== undefined) rewrite.host = service.rewrite.hostHeader;
    const prefix = prefixDisclosure(service);
    if (prefix !== undefined) rewrite.prefix = prefix;
    if (service.rewrite.headerSet !== undefined) {
      rewrite.headerSet = Object.entries(service.rewrite.headerSet).map(([name, value]) => ({
        name,
        value: isMaskedRef(value) ? ENV_VALUE_MASK : value,
      }));
    }
  }
  return {
    upstream: service.upstream,
    match: service.match.map((m) => ({ type: m.type, value: m.value })),
    rewrite,
    ...(service.routes !== undefined && service.routes.length > 0
      ? { routes: service.routes.map((r) => ({ form: r.form, upstreamPrefix: r.upstreamPrefix })) }
      : {}),
  };
}

/** 目录服务条目（含 detail 脱敏披露）。 */
export function buildServiceEntry(service: ServiceConfig): ServiceEntry {
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
 * 在终端侧替换为 <hidden>——$env 与 $secret 掩码同形，无法区分，用中性词）。
 */
export function detailDisplayLines(detail: ServiceDetail): string[] {
  const lines: string[] = [`upstream: ${detail.upstream}`];
  for (const m of detail.match) lines.push(`match: ${m.type} ${m.value}`);
  for (const r of detail.routes ?? []) {
    lines.push(`route: ${r.form} -> ${r.upstreamPrefix === "" ? "(root)" : r.upstreamPrefix}`);
  }
  if (detail.rewrite !== undefined) {
    const r = detail.rewrite;
    if (r.host !== undefined) lines.push(`host: ${r.host}`);
    if (r.prefix !== undefined) lines.push(`prefix: ${r.prefix}`);
    for (const h of r.headerSet ?? []) {
      lines.push(`header-set: ${h.name}: ${h.value === ENV_VALUE_MASK ? "<hidden>" : h.value}`);
    }
  }
  return lines;
}
