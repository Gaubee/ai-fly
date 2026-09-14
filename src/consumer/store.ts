// 使用方钥环存储（design A7）：~/.aifly/consumers/<endpointId 前 8 字符>/ 下
// keyring.json（0600 原子写，密钥原文）+ fabric/（SDK dataDir，由 Fabric 自管，
// 本层只记录/拼接路径）。目录 0700 / 文件 0600。
// 正交意图：
// - 本文件只做持久化形状与合并语义：加载/保存/合并/删除/端口记录，不含任何网络、
//   Fabric 构造与帧语义；
// - 合并语义以 (提供者, keyId) 为幂等键（重复 keyId 更新而非追加）；裸密钥（key add）
//   无 keyId/group 元数据，以 keyId="" 占位入环，待 AUTH_OK 目录回填（providers.ts）；
// - keyring 的服务视图（services 含 detail）由 AUTH_OK 全量替换刷新；import 链接
//   携带的初始视图按 serviceId 并入（不覆盖既有 AUTH_OK 视图中其它分组的服务）。

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { randomZ32 } from "../wire/z32.ts";
import { SERVICE_ENTRY_SCHEMA, type ServiceEntry } from "../wire/frames.ts";
import { CliError } from "../cli/errors.ts";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// 形状与 schema
// ---------------------------------------------------------------------------

/** 钥环中的一枚密钥：keyId/group 为目录元数据；裸密钥入环时以 "" 占位。 */
export interface KeyringKey {
  keyId: string;
  key: string;
  group: string;
}

export interface Keyring {
  alias: string;
  endpointId: string;
  relayUrls: string[];
  keys: KeyringKey[];
  services: ServiceEntry[];
  ports: Record<string, number>;
  /** 网关最近一次实际监听端口（自动错开回写；区别于 ports 的用户偏好）。 */
  actualPorts: Record<string, number>;
  /**
   * 本地停用的服务（serviceId 集合，service-lifecycle）：「移除+可复活」语义——
   * 目录全量替换不复活停用服务，但条目变更仍随同步更新；服务从目录消失时
   * 停用记录一并修剪（applyCatalog）。
   */
  disabledServices: string[];
  /**
   * 环级停用（service-lifecycle 提供方级）：true = 该提供方全部服务不物化监听
   * （keyring 保留、目录同步照常更新）；恢复时单服务停用保持叠加。
   */
  disabled: boolean;
}

export const KEYRING_SCHEMA = z.object({
  alias: z.string().min(1).max(256),
  endpointId: z.string().min(8).max(128),
  relayUrls: z.array(z.string().min(1).max(2048)),
  keys: z.array(
    z.strictObject({
      keyId: z.string().max(128),
      key: z.string().min(8).max(256),
      group: z.string().max(256),
    }),
  ),
  services: z.array(SERVICE_ENTRY_SCHEMA),
  ports: z.record(z.string(), z.number().int().min(0).max(65535)),
  actualPorts: z.record(z.string(), z.number().int().min(0).max(65535)).default({}),
  disabledServices: z.array(z.string().min(1).max(128)).default([]),
  disabled: z.boolean().default(false),
});

/** 目录刷新载荷（AUTH_OK / import 视图）应用于钥环时的输入。 */
export interface CatalogPatch {
  alias?: string;
  relayUrls: string[];
  services: ServiceEntry[];
}

// ---------------------------------------------------------------------------
// 路径规则
// ---------------------------------------------------------------------------

/** 消费侧数据根：默认 ~/.aifly/consumers；--data <dir> 时以 <dir> 为根（CLI 语义）。 */
export function consumersRoot(dataDir?: string, base = homedir()): string {
  if (dataDir !== undefined && dataDir !== "") return dataDir;
  return join(base, ".aifly", "consumers");
}

/** 提供者钥环目录：<root>/<endpointId 前 8 字符>。 */
export function keyringDir(root: string, endpointId: string): string {
  return join(root, endpointId.slice(0, 8));
}

export function keyringPath(root: string, endpointId: string): string {
  return join(keyringDir(root, endpointId), "keyring.json");
}

/** 该提供者的 Fabric dataDir（SDK 自管；本层只负责路径形状）。 */
export function fabricDir(root: string, endpointId: string): string {
  return join(keyringDir(root, endpointId), "fabric");
}

/** 本机是否已有该提供者的 fabric 身份目录（import 老设备判定）。 */
export function hasFabricIdentity(root: string, endpointId: string): boolean {
  return existsSync(fabricDir(root, endpointId));
}

// ---------------------------------------------------------------------------
// 读写（0600 原子写：tmp + rename）
// ---------------------------------------------------------------------------

function ensureDirMode(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    // 个别文件系统不支持 chmod；尽力而为（mkdir mode 已尽力收紧）
  }
}

/** 原子写 keyring.json：同目录 tmp 落盘 → chmod 0600 → rename 覆盖。 */
export function saveKeyring(root: string, ring: Keyring): string {
  const dir = keyringDir(root, ring.endpointId);
  ensureDirMode(root);
  ensureDirMode(dir);
  const finalPath = join(dir, "keyring.json");
  const tmpPath = join(dir, `.keyring.json.tmp-${randomZ32(4)}`);
  writeFileSync(tmpPath, `${JSON.stringify(ring, null, 2)}\n`, { mode: FILE_MODE });
  try {
    chmodSync(tmpPath, FILE_MODE);
  } catch {
    // 同上：尽力而为
  }
  renameSync(tmpPath, finalPath);
  return finalPath;
}

function readRingAt(dir: string): Keyring | undefined {
  const p = join(dir, "keyring.json");
  if (!existsSync(p)) return undefined; // 目录存在但钥环未写（join/import 中间态）
  const raw = readFileSync(p, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const result = KEYRING_SCHEMA.safeParse(parsed);
  if (!result.success) {
    throw new CliError(`error: keyring ${p} failed validation: ${result.error.message}`);
  }
  return result.data;
}

/** 严格加载单个钥环（按 endpointId 或 ≥8 字符前缀或别名定位）；不存在返回 undefined。 */
export function loadKeyring(root: string, ref: string): Keyring | undefined {
  const found = findKeyringDir(root, ref);
  if (found === undefined) return undefined;
  return readRingAt(found);
}

/** 列出全部钥环；无 keyring.json 的目录静默跳过，损坏/非法的计入 warnings。 */
export function listKeyrings(root: string): { rings: Keyring[]; warnings: string[] } {
  const rings: Keyring[] = [];
  const warnings: string[] = [];
  if (!existsSync(root)) return { rings, warnings };
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    let ring: Keyring | undefined;
    try {
      ring = readRingAt(join(root, ent.name));
    } catch (err) {
      warnings.push((err as Error).message);
      continue;
    }
    if (ring === undefined) continue; // 中间态目录（仅 fabric 或留空）
    rings.push(ring);
  }
  rings.sort((a, b) => a.alias.localeCompare(b.alias));
  return { rings, warnings };
}

/**
 * 定位钥环目录：完整 endpointId 精确匹配 → 目录名（endpointId 前 8 字符）前缀匹配
 * （≥8 字符，歧义报错）→ 别名精确匹配。未命中返回 undefined。
 */
export function findKeyringDir(root: string, ref: string): string | undefined {
  if (!existsSync(root)) return undefined;
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name);
  // 1) 完整 endpointId：目录名即前 8 字符，要求目录内 keyring.endpointId 全等
  for (const name of dirs) {
    const dir = join(root, name);
    if (ref.startsWith(name)) {
      try {
        const ring = readRingAt(dir);
        if (ring !== undefined && ring.endpointId === ref) return dir;
      } catch {
        // 校验失败留给前缀/别名分支或上层报错
      }
    }
  }
  // 2) 8+ 字符前缀（spec：endpointId 或 8 字符前缀）；仅计含钥环的目录
  if (ref.length >= 8) {
    const hasRing = (name: string): boolean => {
      try {
        return readRingAt(join(root, name)) !== undefined;
      } catch {
        return false;
      }
    };
    const hits = dirs.filter((name) => name.length <= ref.length && ref.startsWith(name) && hasRing(name));
    if (hits.length > 1) {
      throw new CliError(`error: ambiguous provider prefix '${ref}' (matches: ${hits.join(", ")})`);
    }
    if (hits.length === 1) return join(root, hits[0]!);
  }
  // 3) 别名
  for (const name of dirs) {
    try {
      const ring = readRingAt(join(root, name));
      if (ring !== undefined && ring.alias === ref) return join(root, name);
    } catch {
      // 跳过损坏目录
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 纯合并语义（测试直测；IO 包装在其上）
// ---------------------------------------------------------------------------

/**
 * 密钥入环（幂等）：
 * - keyId 非空：按 keyId 定位，命中则原位更新（key/group 覆盖）；
 * - keyId 空（裸密钥）：按 key 原文定位，命中则仅在环内元数据为空时回填；
 * - 未命中：追加。
 */
export function upsertKey(ring: Keyring, entry: KeyringKey): { ring: Keyring; added: boolean } {
  const keys = [...ring.keys];
  let idx = -1;
  if (entry.keyId !== "") {
    idx = keys.findIndex((k) => k.keyId === entry.keyId);
  }
  if (idx < 0) {
    idx = keys.findIndex((k) => k.key === entry.key);
  }
  if (idx >= 0) {
    const prev = keys[idx]!;
    keys[idx] = {
      keyId: entry.keyId !== "" ? entry.keyId : prev.keyId,
      key: entry.key,
      group: entry.group !== "" ? entry.group : prev.group,
    };
    return { ring: { ...ring, keys }, added: false };
  }
  keys.push(entry);
  return { ring: { ...ring, keys }, added: true };
}

/**
 * import 链接视图并入：alias/relayUrls 以链接为准（更新元数据），services 按
 * serviceId 并入（链接版本胜出，保留环内其它分组服务），key 走 upsertKey。
 */
export function mergeImportView(
  base: Keyring | undefined,
  payload: { alias: string; endpointId: string; relayUrls: string[]; services: ServiceEntry[] },
  key: KeyringKey,
): { ring: Keyring; keyAdded: boolean } {
  const ring: Keyring = base ?? {
    alias: payload.alias,
    endpointId: payload.endpointId,
    relayUrls: [],
    keys: [],
    services: [],
    ports: {},
    actualPorts: {},
    disabledServices: [],

    disabled: false,
  };
  const merged = new Map(ring.services.map((s) => [s.serviceId, s]));
  for (const s of payload.services) merged.set(s.serviceId, s); // 链接版本胜出
  const { ring: withKey, added } = upsertKey(
    {
      ...ring,
      alias: payload.alias,
      relayUrls: [...payload.relayUrls],
      services: [...merged.values()],
    },
    key,
  );
  return { ring: withKey, keyAdded: added };
}

/**
 * 目录全量替换（AUTH_OK 初次/refresh 同构）：services、relayUrls 整体替换，
 * alias 可选更新；ports 修剪到存活服务（被删服务的端口记录一并移除）。
 * disabledServices 跨同步保留（可复活语义）但修剪到存活条目。
 */
export function applyCatalog(ring: Keyring, patch: CatalogPatch): Keyring {
  const alive = new Set(patch.services.map((s) => s.serviceId));
  const ports: Record<string, number> = {};
  for (const [serviceId, port] of Object.entries(ring.ports)) {
    if (alive.has(serviceId)) ports[serviceId] = port;
  }
  const actualPorts: Record<string, number> = {};
  for (const [serviceId, port] of Object.entries(ring.actualPorts ?? {})) {
    if (alive.has(serviceId)) actualPorts[serviceId] = port;
  }
  const disabledServices = ring.disabledServices.filter((id) => alive.has(id));
  const next: Keyring = {
    ...ring,
    relayUrls: [...patch.relayUrls],
    services: [...patch.services],
    ports,
    actualPorts,
    disabledServices,
  };
  if (patch.alias !== undefined && patch.alias !== "") next.alias = patch.alias;
  return next;
}

/** AUTH_OK 回填：groups[].{keyId,group} 对位到环内密钥（含裸密钥占位回填）。 */
export function reconcileKeyMetadata(
  ring: Keyring,
  groups: ReadonlyArray<{ keyId: string; group: string }>,
): Keyring {
  const known = new Set(ring.keys.filter((k) => k.keyId !== "").map((k) => k.keyId));
  const unmatched = groups.filter((g) => !known.has(g.keyId));
  const empties = ring.keys.filter((k) => k.keyId === "");
  if (unmatched.length === 0 || unmatched.length !== empties.length) {
    // 数量不齐时无法确定对应关系（rejected 载荷不含 keyId，无法排除法）——保守不动
    return ring;
  }
  // 逐个空位顺序配对（同一批仅一枚未知密钥的常见路径精确成立）
  let i = 0;
  const keys = ring.keys.map((k): KeyringKey => {
    if (k.keyId !== "") return k;
    const g = unmatched[i++]!;
    return { keyId: g.keyId, key: k.key, group: g.group };
  });
  return { ...ring, keys };
}

// ---------------------------------------------------------------------------
// IO 包装
// ---------------------------------------------------------------------------

/** 密钥并入指定提供者钥环并持久化。 */
export function addKeyToRing(root: string, endpointId: string, key: KeyringKey): { ring: Keyring; added: boolean } {
  const existing = loadKeyring(root, endpointId);
  if (existing === undefined) {
    throw new CliError(`error: provider '${endpointId}' not found`);
  }
  const result = upsertKey(existing, key);
  saveKeyring(root, result.ring);
  return result;
}

/** 目录刷新全量替换并持久化（含 relayUrls 更新）。 */
export function updateServices(root: string, endpointId: string, patch: CatalogPatch): Keyring {
  const existing = loadKeyring(root, endpointId);
  if (existing === undefined) {
    throw new CliError(`error: provider '${endpointId}' not found`);
  }
  const next = applyCatalog(existing, patch);
  saveKeyring(root, next);
  return next;
}

/** 记录服务端口偏好（ports 命令写路径）。 */
export function setPort(root: string, endpointId: string, serviceId: string, port: number): Keyring {
  const existing = loadKeyring(root, endpointId);
  if (existing === undefined) {
    throw new CliError(`error: provider '${endpointId}' not found`);
  }
  if (!existing.services.some((s) => s.serviceId === serviceId)) {
    throw new CliError(`error: unknown service '${serviceId}' for provider '${existing.alias}'`);
  }
  const next = { ...existing, ports: { ...existing.ports, [serviceId]: port } };
  saveKeyring(root, next);
  return next;
}

/**
 * 服务停用/启用（services stop|start / rm 写路径，service-lifecycle）：
 * 幂等；服务须存在于目录（含已停用条目——可复活语义）。返回是否发生变更。
 */
export function setServiceEnabled(root: string, ref: string, serviceId: string, enabled: boolean): { ring: Keyring; changed: boolean } {
  const existing = loadKeyring(root, ref);
  if (existing === undefined) {
    throw new CliError(`error: provider '${ref}' not found`);
  }
  if (!existing.services.some((s) => s.serviceId === serviceId)) {
    throw new CliError(`error: unknown service '${serviceId}' for provider '${existing.alias}'`);
  }
  const currentlyDisabled = existing.disabledServices.includes(serviceId);
  const nextDisabled = enabled
    ? existing.disabledServices.filter((id) => id !== serviceId)
    : currentlyDisabled
      ? existing.disabledServices
      : [...existing.disabledServices, serviceId];
  // 提前返回（无变化）：当前停用状态 === 目标停用状态（四种组合的真值表）
  if (currentlyDisabled === !enabled) return { ring: existing, changed: false };
  const next = { ...existing, disabledServices: nextDisabled };
  saveKeyring(root, next);
  return { ring: next, changed: true };
}

/**
 * 环级停用/启用（提供方级，service-lifecycle）：幂等；目录同步不受影响
 * （applyCatalog 保留环自身属性）。返回是否发生变更。
 */
export function setProviderEnabled(root: string, ref: string, enabled: boolean): { ring: Keyring; changed: boolean } {
  const existing = loadKeyring(root, ref);
  if (existing === undefined) {
    throw new CliError(`error: provider '${ref}' not found`);
  }
  if (existing.disabled === !enabled) return { ring: existing, changed: false };
  const next = { ...existing, disabled: !enabled };
  saveKeyring(root, next);
  return { ring: next, changed: true };
}

/** 网关实际监听端口回写（引擎启动路径；整体替换并修剪到存活服务）。 */
export function setActualPorts(root: string, endpointId: string, actual: Readonly<Record<string, number>>): Keyring {
  const existing = loadKeyring(root, endpointId);
  if (existing === undefined) {
    throw new CliError(`error: provider '${endpointId}' not found`);
  }
  const alive = new Set(existing.services.map((s) => s.serviceId));
  const actualPorts: Record<string, number> = {};
  for (const [serviceId, port] of Object.entries(actual)) {
    if (alive.has(serviceId)) actualPorts[serviceId] = port;
  }
  const next = { ...existing, actualPorts };
  saveKeyring(root, next);
  return next;
}

/** forget：整环删除（钥环 + fabric 身份目录；提供方侧撤销需提供方操作）。 */
export function removeKeyring(root: string, ref: string): { dir: string; ring: Keyring } {
  const dir = findKeyringDir(root, ref);
  if (dir === undefined) {
    throw new CliError(`error: provider '${ref}' not found`);
  }
  // 防御：只允许删除 root 的一级子目录
  const stat = statSync(dir, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) {
    throw new CliError(`error: provider '${ref}' not found`);
  }
  const ring = readRingAt(dir);
  rmSync(dir, { recursive: true, force: true });
  if (ring !== undefined) return { dir, ring };
  // 目录在而钥环缺（中间态）：仍按整目录删除，返回最小描述
  return { dir, ring: { alias: ref, endpointId: ref, relayUrls: [], keys: [], services: [], ports: {}, actualPorts: {}, disabledServices: [], disabled: false } };
}
