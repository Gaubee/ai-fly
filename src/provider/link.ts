// aifly1. 分享链接：`aifly1.<base64url(payload JSON)>`——自包含组合信封（1 fabric 邀请
// 令牌 + 1 分组访问密钥 + 提供方元数据 + 服务脱敏视图）。
// 正交意图（本文件不实现）：
// - 邀请令牌签发（fabric.invite；由 CLI/serve 层调用后传入）；
// - 兑换与导入（consumer 侧）；
// - 网络请求（decode/preview 离线完成，无任何 IO）。
// 前置检查：分组存在且非空（无服务则链接无意义）；密钥有效（密钥哈希不可逆，故每次
// share 签发新钥——复用旧钥在提供方侧无法再现原文，见任务报告裁决）；relay 未配置时
// 警告并附稳定入口部署指引。链接即凭证：payload 含密钥原文。

import { z } from "zod";
import { SERVICE_ENTRY_SCHEMA } from "../wire/frames.ts";
import type { ServiceEntry } from "../wire/frames.ts";
import type { ProviderStore } from "./store.ts";
import { StoreError } from "./store.ts";
import { buildServiceEntry } from "./detail.ts";

export const SHARE_LINK_PREFIX = "aifly1.";

/** TTL 值域（share-link spec：1s..30d；默认 60min）。 */
export const SHARE_TTL_MIN_MS = 1_000;
export const SHARE_TTL_MAX_MS = 30 * 86_400_000;
export const SHARE_TTL_DEFAULT_MS = 60 * 60_000;

/** 用户面提示（英文 ASCII）：链接等同密钥。 */
export const SHARE_LINK_SECRET_HINT =
  "WARNING: this link contains a secret access key. Treat it like a password.";

/** relay 缺失时的稳定入口部署指引（英文 ASCII）。 */
export const STABLE_ENTRY_HINT =
  "Hint: configure a relay on a stable address (domain or tunnel) so the entry URL never changes; opendweb relays are self-hostable.";

export const SHARE_LINK_PAYLOAD_SCHEMA = z.strictObject({
  v: z.literal(1),
  invite: z.string().min(1).max(8192),
  key: z.string().min(8).max(256),
  keyId: z.string().min(1).max(128),
  provider: z.strictObject({
    alias: z.string().min(1).max(256),
    endpointId: z.string().min(1).max(256),
    relayUrls: z.array(z.string().min(1).max(2048)),
  }),
  group: z.string().min(1).max(256),
  services: z.array(SERVICE_ENTRY_SCHEMA).max(64),
});

export type ShareLinkPayload = z.infer<typeof SHARE_LINK_PAYLOAD_SCHEMA>;

/** 链接构造失败（用户面 message 英文 ASCII）。 */
export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkError";
  }
}

export function encodeShareLink(payload: ShareLinkPayload): string {
  return SHARE_LINK_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeShareLink(text: string): ShareLinkPayload {
  const trimmed = text.trim();
  if (!trimmed.startsWith(SHARE_LINK_PREFIX)) {
    throw new LinkError(`error: not an ai-fly share link (expected ${SHARE_LINK_PREFIX} prefix)`);
  }
  let json: string;
  try {
    json = Buffer.from(trimmed.slice(SHARE_LINK_PREFIX.length), "base64url").toString("utf8");
  } catch {
    throw new LinkError("error: share link payload is not valid base64url");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new LinkError("error: share link payload is not valid JSON");
  }
  const result = SHARE_LINK_PAYLOAD_SCHEMA.safeParse(parsed);
  if (!result.success) {
    throw new LinkError(`error: share link payload failed validation: ${result.error.message}`);
  }
  return result.data;
}

/** 离线预览（不发起任何网络请求）。 */
export interface ShareLinkPreview {
  alias: string;
  endpointId: string;
  group: string;
  keyId: string;
  relayUrls: string[];
  services: Array<{ serviceId: string; name: string; defaultPort: number; matchCount: number }>;
}

export function previewShareLink(text: string): ShareLinkPreview {
  const payload = decodeShareLink(text);
  return {
    alias: payload.provider.alias,
    endpointId: payload.provider.endpointId,
    group: payload.group,
    keyId: payload.keyId,
    relayUrls: [...payload.provider.relayUrls],
    services: payload.services.map((s) => ({
      serviceId: s.serviceId,
      name: s.name,
      defaultPort: s.defaultPort,
      matchCount: s.match.length,
    })),
  };
}

// ---------------------------------------------------------------------------
// 生成（前置检查 + 新钥签发）
// ---------------------------------------------------------------------------

export interface ShareBuildInput {
  store: ProviderStore;
  group: string;
  invite: string;
  endpointId: string;
  alias?: string | undefined;
  relayUrls?: readonly string[] | undefined;
}

export interface ShareBuildResult {
  payload: ShareLinkPayload;
  link: string;
  warnings: string[];
  keyId: string;
}

/**
 * 构造分享链接：前置检查（组存在且非空）-> 签发新钥（每次 share 一枚；旧钥不可再现）
 * -> 组内服务脱敏视图 -> payload + link + 警告。
 */
export function buildShareLink(input: ShareBuildInput): ShareBuildResult {
  const group = input.store.getGroup(input.group);
  if (group === undefined) {
    throw new StoreError("not-found", `error: group '${input.group}' not found`);
  }
  const services = input.store.groupServices(input.group);
  if (services.length === 0) {
    throw new StoreError("invalid", `error: group '${input.group}' has no services; a share link would be meaningless`);
  }
  const issued = input.store.issueKey(input.group);
  const serviceEntries: ServiceEntry[] = services.map(buildServiceEntry);
  const relayUrls = input.relayUrls === undefined ? [] : [...input.relayUrls];
  const payload: ShareLinkPayload = {
    v: 1,
    invite: input.invite,
    key: issued.key,
    keyId: issued.keyId,
    provider: {
      alias: input.alias ?? input.store.alias ?? "provider",
      endpointId: input.endpointId,
      relayUrls,
    },
    group: input.group,
    services: serviceEntries,
  };
  const warnings: string[] = [];
  if (relayUrls.length === 0) {
    warnings.push(
      "WARNING: no relay is configured; consumers may be unable to reach you. " + STABLE_ENTRY_HINT,
    );
  }
  return { payload, link: encodeShareLink(payload), warnings, keyId: issued.keyId };
}
