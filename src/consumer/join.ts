// 使用方三入口凭据逻辑（consumer spec「三入口凭据模型」）：
// - joinDevice：dweb1. 令牌设备入网（Fabric.joinWithToken，仅入网无密钥）；
// - addKey：裸密钥入环（定位已入网提供者，未找到报错指引先 join/import）；
// - importLink：aifly1. 组合信封（新设备=兑换+入环；老设备=fabric 身份已存在则
//   Fabric.open 校验后跳过兑换直接入环）；--preview 离线解析零网络零 Fabric 构造。
// 正交意图：
// - 链接解码 schema 自带（车道隔离：不 import provider/link.ts）；服务条目形状复用
//   wire/frames.ts（两侧引擎共同契约，与 share-link spec 对齐）；
// - Fabric 全部经注入的 FabricFactory 构造（vitest 禁 SDK 原生模块运行时 import）；
// - 失败清理：任何失败不留半初始化状态（staging 目录/新目录整体回收）。

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { decodeZ32, randomZ32 } from "../wire/z32.ts";
import { SERVICE_ENTRY_SCHEMA } from "../wire/frames.ts";
import { CliError } from "../cli/errors.ts";
import {
  fabricDir,
  findKeyringDir,
  hasFabricIdentity,
  keyringDir,
  loadKeyring,
  mergeImportView,
  saveKeyring,
  upsertKey,
  type Keyring,
} from "./store.ts";
import type { FabricFactory, FabricLike, FabricMember } from "./providers.ts";

// ---------------------------------------------------------------------------
// aifly1. 链接解码（schema 自带）
// ---------------------------------------------------------------------------

export const SHARE_LINK_PREFIX = "aifly1.";
export const KEY_PREFIX = "sk-aifly-";
export const INVITE_PREFIX = "dweb1.";

/** base64url 字符集（解码前先做形态校验，拒绝 Buffer 宽容解析）。 */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export const LINK_PAYLOAD_SCHEMA = z.strictObject({
  v: z.literal(1),
  invite: z.string().refine((s) => s.startsWith(INVITE_PREFIX) && s.length > INVITE_PREFIX.length, {
    message: `invite must be a '${INVITE_PREFIX}' token`,
  }),
  key: z.string().refine((s) => s.startsWith(KEY_PREFIX) && s.length > KEY_PREFIX.length, {
    message: `key must be a '${KEY_PREFIX}' secret`,
  }),
  keyId: z.string().min(1).max(128),
  provider: z.strictObject({
    alias: z.string().min(1).max(256),
    endpointId: z.string().min(8).max(128),
    relayUrls: z.array(z.string().min(1).max(2048)),
  }),
  group: z.string().min(1).max(256),
  services: z.array(SERVICE_ENTRY_SCHEMA).max(256),
});

export type LinkPayload = z.infer<typeof LINK_PAYLOAD_SCHEMA>;

/** 解码 aifly1.<base64url(payload JSON)>；任何坏形态以 CliError（退出码 1）报出。 */
export function decodeShareLink(link: string): LinkPayload {
  if (!link.startsWith(SHARE_LINK_PREFIX)) {
    throw new CliError(`error: not an ai-fly share link (expected '${SHARE_LINK_PREFIX}<base64url>)`);
  }
  const body = link.slice(SHARE_LINK_PREFIX.length);
  if (body.length === 0 || !BASE64URL_RE.test(body)) {
    throw new CliError("error: share link payload is not valid base64url");
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new CliError("error: share link payload is not valid JSON");
  }
  const parsed = LINK_PAYLOAD_SCHEMA.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? ` at ${first.path.join(".")}` : "";
    throw new CliError(`error: share link payload failed validation${where}: ${first?.message ?? "unknown"}`);
  }
  return parsed.data;
}

/** --preview 摘要（纯文本、英文 ASCII、零网络）。 */
export function formatLinkPreview(payload: LinkPayload): string[] {
  const lines: string[] = [];
  lines.push(`provider : ${payload.provider.alias} (${payload.provider.endpointId})`);
  lines.push(`group    : ${payload.group}`);
  lines.push(`key id   : ${payload.keyId}`);
  lines.push(`relay    : ${payload.provider.relayUrls.length > 0 ? payload.provider.relayUrls.join(", ") : "(none)"}`);
  lines.push(`services :`);
  for (const s of payload.services) {
    const match = s.match.map((m) => `${m.type}:${m.value}`).join("|");
    lines.push(`  - ${s.name}  [${s.serviceId}]  default port ${s.defaultPort}${match ? `  (${match})` : ""}`);
  }
  lines.push("note: this link embeds a secret key - treat it like a password");
  return lines;
}

// ---------------------------------------------------------------------------
// 入口 1：joinDevice（令牌 → 设备入网）
// ---------------------------------------------------------------------------

export interface JoinResult {
  ring: Keyring;
  provider: FabricMember;
  /** true = 本机此前已入网（既有身份保留，本次新兑换的身份已丢弃）。 */
  alreadyJoined: boolean;
}

/**
 * 设备入网：staging 目录先行兑换（失败即弃），成功后从名册识别提供者（root：
 * 非自身成员中 sinceMs 最早者），把 fabric 身份目录归位到 <endpointId8>/fabric 并
 * 写入空钥环骨架。既有身份则丢弃 staging 并提示（令牌已被消耗属 fabric 语义）。
 */
export async function joinDevice(
  token: string,
  root: string,
  deps: { fabric: FabricFactory },
): Promise<JoinResult> {
  if (!token.startsWith(INVITE_PREFIX)) {
    throw new CliError(`error: not a fabric invite token (expected '${INVITE_PREFIX}...')`);
  }
  const staging = join(root, `.join-staging-${randomZ32(4)}`);
  let fabric: FabricLike;
  try {
    mkdirSync(staging, { recursive: true }); // 兑换前先建目录（SDK 向其写入身份）
    fabric = await deps.fabric.joinWithToken({ dataDir: staging }, token);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw new CliError(`error: join failed: ${(err as Error).message}`);
  }
  try {
    const me = fabric.endpointId;
    const members = await fabric.members();
    const others = members.filter((m) => m.endpointId !== me).sort((a, b) => a.sinceMs - b.sinceMs);
    const provider = others[0];
    if (provider === undefined) {
      throw new CliError("error: joined fabric has no provider member (nothing to consume)");
    }
    const target = keyringDir(root, provider.endpointId);
    if (hasFabricIdentity(root, provider.endpointId)) {
      // 已入网：保留既有身份，丢弃本次兑换出的新身份（token 已被消耗，如实提示）
      const existing = loadKeyring(root, provider.endpointId);
      const alias = existing?.alias ?? provider.displayName ?? provider.endpointId.slice(0, 8);
      const ring: Keyring = existing ?? {
        alias,
        endpointId: provider.endpointId,
        relayUrls: [],
        keys: [],
        services: [],
        ports: {},
        actualPorts: {},
      };
      if (existing === undefined) saveKeyring(root, ring);
      return { ring, provider, alreadyJoined: true };
    }
    // 归位：staging → <endpointId8>/fabric，写入钥环骨架（alias 取名册 displayName）
    mkdirSync(keyringDir(root, provider.endpointId), { recursive: true });
    rmSync(join(target, "fabric"), { recursive: true, force: true });
    renameSync(staging, fabricDir(root, provider.endpointId));
    const ring: Keyring = {
      alias: provider.displayName && provider.displayName.length > 0 ? provider.displayName : provider.endpointId.slice(0, 8),
      endpointId: provider.endpointId,
      relayUrls: [],
      keys: [],
      services: [],
      ports: {},
      actualPorts: {},
    };
    const existing = loadKeyring(root, provider.endpointId);
    saveKeyring(root, existing ?? ring);
    return { ring: existing ?? ring, provider, alreadyJoined: false };
  } finally {
    await fabric.shutdown().catch(() => undefined);
    rmSync(staging, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 入口 2：addKey（裸密钥 → 已入网提供者的钥环）
// ---------------------------------------------------------------------------

export interface AddKeyResult {
  ring: Keyring;
  added: boolean;
}

/** 裸密钥格式校验：sk-aifly-<z32(32B)>（z32 严格解码拒绝非规范形）。 */
export function assertKeyFormat(key: string): void {
  if (!key.startsWith(KEY_PREFIX)) {
    throw new CliError(`error: not an ai-fly key (expected '${KEY_PREFIX}<z32>)`);
  }
  const body = key.slice(KEY_PREFIX.length);
  try {
    const bytes = decodeZ32(body);
    if (bytes.length !== 32) {
      throw new Error(`expected 32 bytes, got ${bytes.length}`);
    }
  } catch (err) {
    throw new CliError(`error: invalid key format: ${(err as Error).message}`);
  }
}

/**
 * 裸密钥入环：定位已入网提供者（endpointId / 8 字符前缀 / 别名；要求已有 fabric
 * 身份或既有钥环），未找到报错并指引先 join/import。keyId/group 由下次 AUTH_OK 回填。
 */
export function addKey(key: string, providerRef: string, root: string): AddKeyResult {
  assertKeyFormat(key);
  const dir = findKeyringDir(root, providerRef);
  if (dir === undefined) {
    throw new CliError(
      `error: provider '${providerRef}' is not joined on this machine - run 'ai-fly join <invite>' or 'ai-fly import <link>' first (a bare key carries no network info)`,
    );
  }
  const ring = loadKeyring(root, providerRef);
  if (ring === undefined) {
    throw new CliError(`error: provider '${providerRef}' has no readable keyring at ${dir}`);
  }
  if (!hasFabricIdentity(root, ring.endpointId)) {
    throw new CliError(
      `error: provider '${ring.alias}' has keys but no fabric identity - run 'ai-fly join <invite>' first`,
    );
  }
  const result = upsertKey(ring, { keyId: "", key, group: "" });
  saveKeyring(root, result.ring);
  return { ring: result.ring, added: result.added };
}

// ---------------------------------------------------------------------------
// 入口 3：importLink（组合信封 → 兑换/复用 + 入环）
// ---------------------------------------------------------------------------

export interface ImportOptions {
  consumersRoot: string;
  fabric: FabricFactory;
}

export interface ImportResult {
  ring: Keyring;
  payload: LinkPayload;
  /** true = 本次发生了令牌兑换（新设备）；false = 复用既有身份跳过兑换。 */
  redeemed: boolean;
}

/**
 * 组合链接导入：本机已有该 endpointId 的 fabric 目录 → Fabric.open 校验既有身份、
 * 跳过兑换；否则 Fabric.joinWithToken 兑换（失败整体回收新目录）。两种路径统一
 * 将链接内 {key,keyId,group} 入环、链接服务视图并入后持久化。
 */
export async function importLink(link: string, opts: ImportOptions): Promise<ImportResult> {
  const payload = decodeShareLink(link);
  const root = opts.consumersRoot;
  const target = keyringDir(root, payload.provider.endpointId);
  const fabricPath = fabricDir(root, payload.provider.endpointId);
  let redeemed = false;
  if (hasFabricIdentity(root, payload.provider.endpointId)) {
    // 老设备：令牌不消耗；open 仅校验既有身份可加载（随后立即关闭）
    try {
      const fabric = await opts.fabric.open({ dataDir: fabricPath });
      await fabric.shutdown().catch(() => undefined);
    } catch (err) {
      throw new CliError(
        `error: existing fabric identity for '${payload.provider.alias}' failed to load: ${(err as Error).message}`,
      );
    }
  } else {
    // 新设备：兑换；失败仅回收本次新建的目录（既有钥环目录不动，不留半初始化状态）
    redeemed = true;
    const created = !existsSync(target);
    try {
      mkdirSync(target, { recursive: true });
      const fabric = await opts.fabric.joinWithToken({ dataDir: fabricPath }, payload.invite);
      await fabric.shutdown().catch(() => undefined);
    } catch (err) {
      if (created) rmSync(target, { recursive: true, force: true });
      else rmSync(fabricPath, { recursive: true, force: true }); // 仅回收本次新建的 fabric 子目录
      throw new CliError(`error: import failed: ${(err as Error).message}`);
    }
  }
  const existing = loadKeyring(root, payload.provider.endpointId);
  const { ring } = mergeImportView(
    existing,
    { ...payload.provider, services: payload.services },
    { keyId: payload.keyId, key: payload.key, group: payload.group },
  );
  saveKeyring(root, ring);
  return { ring, payload, redeemed };
}

/** 导入/入环后打印的钥环摘要行（别名/EndpointId/relay/分组服务与默认端口）。 */
export function formatKeyringSummary(ring: Keyring, extra?: string[]): string[] {
  const lines: string[] = [];
  lines.push(`provider  : ${ring.alias} (${ring.endpointId})`);
  lines.push(`relay     : ${ring.relayUrls.length > 0 ? ring.relayUrls.join(", ") : "(none)"}`);
  lines.push(`keyring   : ${ring.keys.length} key(s)${ring.keys.length > 0 ? ` - ${[...new Set(ring.keys.map((k) => k.group).filter((g) => g !== ""))].join(", ")}` : ""}`);
  lines.push(`services  :`);
  if (ring.services.length === 0) {
    lines.push(`  (none yet - run 'ai-fly run' to connect and fetch the catalog)`);
  }
  for (const s of ring.services) {
    lines.push(`  - ${s.name}  [${s.serviceId}]  default port ${s.defaultPort}`);
  }
  if (extra !== undefined) lines.push(...extra);
  return lines;
}
