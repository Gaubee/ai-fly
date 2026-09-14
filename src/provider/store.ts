// 提供方本地存储（services.json）：服务 / 分组 / 密钥哈希三类实体的唯一持久化面。
// 正交意图（本文件不实现）：
// - 网络与协议（AUTH 校验语义在 auth.ts、目录披露在 detail.ts；本文件只提供
//   verifyKey 的常数时间原语与数据查询）；
// - 限额执行（limits.ts；分组 limits 字段仅在此存取）；
// - 密钥原文的二次输出：签发时返回一次，此后只余哈希（SHA-256 + 固定 salt），
//   任何路径都不可再现原文；
// - match 的正则仅在保存期做语法编译检查（match 是纯展示元数据，无运行时执行面，
//   无 ReDoS 暴露——语法合法即可，不做人脸检查）；
// - defaultPort 规则：上游端口 <1024 时必须显式声明（避免使用方侧连环冲突与
//   特权端口占用）。
// 存储：目录 0700 / 文件 0600 / 原子写 tmp+rename；revision 每次 save 自增，
// 供 daemon 侧 watcher 判定文件变更（CLI 与 serve 是不同进程，靠文件同步）。

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ROUTE_LOCAL_PREFIX } from "../shared/rpc-contract.ts";
import { compileMatchPattern } from "./match-pattern.ts";
import { validateUriTemplate } from "./uri-template.ts";
import { join } from "node:path";
import { z } from "zod";
import { randomZ32 } from "../wire/z32.ts";

// ---------------------------------------------------------------------------
// 常量与错误
// ---------------------------------------------------------------------------

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** 密钥哈希固定 salt（所有提供方实例一致；防直接彩虹表对照 sk-aifly- 空间）。 */
const KEY_HASH_SALT = "aifly-provider-key-v1:";

export const KEY_MATERIAL_PREFIX = "sk-aifly-";
export const SERVICE_ID_BYTES = 8; // randomZ32(8) -> 13 字符
export const KEY_ID_BYTES = 8;
export const KEY_MATERIAL_BYTES = 32; // randomZ32(32) -> 52 字符

/** 存储层错误（用户面 message 为英文 ASCII，直接透出 CLI）。 */
export class StoreError extends Error {
  readonly code: "duplicate" | "not-found" | "invalid" | "corrupt" | "conflict";

  constructor(code: StoreError["code"], message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// zod schema（加载校验）
// ---------------------------------------------------------------------------

export const SERVICE_MATCH_STORE_SCHEMA = z.strictObject({
  type: z.enum(["exact", "suffix", "regex"]),
  value: z.string().min(1).max(2048),
});

export const SERVICE_REWRITE_STORE_SCHEMA = z.strictObject({
  hostHeader: z.string().min(1).max(2048).optional(),
  pathPrefixStrip: z.string().min(1).max(2048).optional(),
  pathPrefixAppend: z.string().min(1).max(2048).optional(),
  headerSet: z
    .record(
      z.string().min(1).max(1024),
      z.union([
        z.string().max(8192),
        z.strictObject({
          hook: z.string().min(1).max(128),
          args: z.record(z.string().min(1).max(128), z.string().max(2048)).optional(),
          bearer: z.boolean().optional(),
        }),
      ]),
    )
    .optional(),
  headerRemove: z.array(z.string().min(1).max(1024)).max(32).optional(),
});

/** 路径路由（M3-r7）：按声明顺序命中的转发规则——prefix 模式（默认，
 *  localPrefix → upstreamPrefix）或 pattern 模式（matchPattern URLPattern
 *  + template RFC 6570）。forms 为 AI 层标注（可为空）。 */
export const SERVICE_ROUTE_STORE_SCHEMA = z.strictObject({
  forms: z.array(z.enum(["openai-chat", "openai-responses", "anthropic"])).max(3),
  mode: z.enum(["prefix", "pattern"]).optional(),
  localPrefix: z.string().min(1).max(2048).optional(),
  upstreamPrefix: z.string().max(2048).optional(),
  matchPattern: z.string().min(1).max(2048).optional(),
  template: z.string().min(1).max(2048).optional(),
});

export const SERVICE_STORE_SCHEMA = z.strictObject({
  serviceId: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  match: z.array(SERVICE_MATCH_STORE_SCHEMA).max(64),
  upstream: z.string().min(1).max(2048),
  rewrite: SERVICE_REWRITE_STORE_SCHEMA.optional(),
  /** 选中的 hooks 脚本名（内建库或 ~/.aifly/hooks/<name>.cjs）。 */
  hooks: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
  routes: z.array(SERVICE_ROUTE_STORE_SCHEMA).max(3).optional(),
  defaultPort: z.number().int().min(1).max(65535),
  /** 停用开关（service-lifecycle）：false = 临时停暴露（配置保留，目录同步
   *  排除该服务→消费端端口关停），请求按 unknown_service 拒。旧文件缺省 true。 */
  enabled: z.boolean().default(true),
});

export const GROUP_LIMITS_STORE_SCHEMA = z.strictObject({
  maxConcurrency: z.number().int().min(1).optional(),
  dailyRequests: z.number().int().min(1).optional(),
});

export const GROUP_STORE_SCHEMA = z.strictObject({
  name: z.string().min(1).max(256),
  serviceIds: z.array(z.string().min(1).max(128)).max(256),
  limits: GROUP_LIMITS_STORE_SCHEMA.optional(),
});

export const KEY_STORE_SCHEMA = z.strictObject({
  keyId: z.string().min(1).max(128),
  group: z.string().min(1).max(256),
  hash: z.string().regex(/^[0-9a-f]{64}$/, "key hash must be 64 hex chars"),
  /** key 名（Owner 裁决 2026-09-13：签发时必填，GUI 分组视图按名展示；
   *  旧记录无此字段——迁移容忍，GUI 显示为未命名）。 */
  name: z.string().min(1).max(128).optional(),
  /** key 原文（Owner 裁决 2026-09-13：可随时复制取代仅签发时可见——本机
   *  个人工具与密钥库明文同一威胁模型；旧记录只存哈希，无法补录）。 */
  key: z.string().min(8).max(256).optional(),
  createdAt: z.number().int().min(0),
  revokedAt: z.number().int().min(0).optional(),
});

/** key 名规则（同 SECRET_NAME_SCHEMA 词汇：小写开头，点横杠下划线）。 */
export const KEY_NAME_SCHEMA = /^[a-z0-9][a-z0-9._-]*$/;

export const STORE_FILE_SCHEMA = z.strictObject({
  revision: z.number().int().min(0),
  meta: z.strictObject({ alias: z.string().min(1).max(256).optional() }).optional(),
  services: z.array(SERVICE_STORE_SCHEMA).max(1024),
  groups: z.array(GROUP_STORE_SCHEMA).max(256),
  keys: z.array(KEY_STORE_SCHEMA).max(1024),
});

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type ServiceMatchRule = z.infer<typeof SERVICE_MATCH_STORE_SCHEMA>;
export type ServiceRewrite = z.infer<typeof SERVICE_REWRITE_STORE_SCHEMA>;
export type ServiceRoute = z.infer<typeof SERVICE_ROUTE_STORE_SCHEMA>;
export type ServiceConfig = z.infer<typeof SERVICE_STORE_SCHEMA>;
export type GroupLimits = z.infer<typeof GROUP_LIMITS_STORE_SCHEMA>;
export type GroupConfig = z.infer<typeof GROUP_STORE_SCHEMA>;
export type KeyRecord = z.infer<typeof KEY_STORE_SCHEMA>;
export type StoreData = z.infer<typeof STORE_FILE_SCHEMA>;

/** addService 的输入（defaultPort 规则见 store 顶部注释）。 */
export interface ServiceInput {
  name: string;
  upstream: string;
  match: ServiceMatchRule[];
  defaultPort?: number | undefined;
  rewrite?: ServiceRewrite | undefined;
  routes?: ServiceRoute[] | undefined;
  /** hooks 脚本名（见 SERVICE_STORE_SCHEMA.hooks）。 */
  hooks?: string | undefined;
  /** 编辑重建（remove+add）时保留原停用态；缺省 true（service-lifecycle）。 */
  enabled?: boolean | undefined;
}

/** verifyKey 结果：有效（含定位）/ 无效 / 已撤销。 */
export type KeyCheck =
  | { status: "valid"; keyId: string; group: string }
  | { status: "revoked"; keyId: string; group: string }
  | { status: "invalid" };

// ---------------------------------------------------------------------------
// 私有目录 / 原子写（供 limits.ts 复用）
// ---------------------------------------------------------------------------

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    // 某些文件系统不支持 chmod；尽力而为
  }
}

/** 原子写：同目录 tmp + rename（失败残留 tmp 不影响旧文件）。 */
export function atomicWriteFileSync(path: string, contents: string, mode = FILE_MODE): void {
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, contents, { mode });
  try {
    chmodSync(tmp, mode);
  } catch {
    // 尽力而为
  }
  renameSync(tmp, path);
}

export function hashKeyMaterial(material: string): string {
  return createHash("sha256").update(KEY_HASH_SALT + material).digest("hex");
}

// ---------------------------------------------------------------------------
// 上游 URL 校验
// ---------------------------------------------------------------------------

const PRIVILEGED_PORT_MAX = 1023;

/** 解析并校验上游 URL：http/https、必须有主机名、禁 userinfo/query/fragment。 */
export function parseUpstreamUrl(upstream: string): URL {
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    throw new StoreError("invalid", `error: invalid upstream URL: ${upstream}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new StoreError("invalid", "error: upstream URL scheme must be http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new StoreError("invalid", "error: upstream URL must not embed credentials (user:pass@)");
  }
  if (url.hostname === "") {
    throw new StoreError("invalid", "error: upstream URL must have a hostname");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new StoreError("invalid", "error: upstream URL must not contain query or fragment");
  }
  return url;
}

/** 上游生效端口（显式或缺省scheme端口）。 */
export function upstreamEffectivePort(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

// ---------------------------------------------------------------------------
// ProviderStore
// ---------------------------------------------------------------------------

export class ProviderStore {
  readonly dataDir: string;
  private data: StoreData;

  private constructor(dataDir: string, data: StoreData) {
    this.dataDir = dataDir;
    this.data = data;
  }

  static filePath(dataDir: string): string {
    return join(dataDir, "services.json");
  }

  /** 打开（不存在则初始化空存储）；损坏/非法文件抛 StoreError(corrupt)。 */
  static open(dataDir: string): ProviderStore {
    ensurePrivateDir(dataDir);
    const path = ProviderStore.filePath(dataDir);
    if (!existsSync(path)) {
      return new ProviderStore(dataDir, {
        revision: 0,
        services: [],
        groups: [],
        keys: [],
      });
    }
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      throw new StoreError("corrupt", `error: cannot read ${path}: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StoreError("corrupt", `error: ${path} is not valid JSON (fix or remove it manually)`);
    }
    const result = STORE_FILE_SCHEMA.safeParse(parsed);
    if (!result.success) {
      throw new StoreError("corrupt", `error: ${path} failed validation: ${result.error.message}`);
    }
    return new ProviderStore(dataDir, result.data);
  }

  /** 当前文件 revision（watcher 判重入用）。 */
  get revision(): number {
    return this.data.revision;
  }

  // -----------------------------------------------------------------------
  // 服务
  // -----------------------------------------------------------------------

  listServices(): ServiceConfig[] {
    return this.data.services.map((s) => ({ ...s }));
  }

  getService(serviceId: string): ServiceConfig | undefined {
    const found = this.data.services.find((s) => s.serviceId === serviceId);
    return found === undefined ? undefined : { ...found };
  }

  getServiceByName(name: string): ServiceConfig | undefined {
    const found = this.data.services.find((s) => s.name === name);
    return found === undefined ? undefined : { ...found };
  }

  addService(input: ServiceInput): ServiceConfig {
    const name = input.name.trim();
    if (name === "" || name.length > 256) {
      throw new StoreError("invalid", "error: service name must be 1..256 chars");
    }
    if (this.data.services.some((s) => s.name === name)) {
      throw new StoreError("duplicate", `error: service '${name}' already exists`);
    }
    if (input.match.length === 0) {
      throw new StoreError("invalid", "error: service must declare at least one match rule");
    }
    if (input.match.length > 64) {
      throw new StoreError("invalid", "error: service match rules exceed 64 entries");
    }
    // 正则规则保存期编译检查（语法合法即可，无运行时执行面）。
    for (const rule of input.match) {
      if (rule.type === "regex") {
        try {
          new RegExp(rule.value);
        } catch (err) {
          throw new StoreError(
            "invalid",
            `error: invalid regex '${rule.value}': ${(err as Error).message}`,
          );
        }
      }
    }
    const upstreamUrl = parseUpstreamUrl(input.upstream);
    // defaultPort 规则：上游端口 <1024 必须显式；缺省继承上游端口。
    let defaultPort: number;
    if (input.defaultPort === undefined) {
      const eff = upstreamEffectivePort(upstreamUrl);
      if (eff <= PRIVILEGED_PORT_MAX) {
        throw new StoreError(
          "invalid",
          `error: upstream port ${eff} is privileged; declare an explicit consumer-side default port (--port <n>)`,
        );
      }
      defaultPort = eff;
    } else {
      if (!Number.isInteger(input.defaultPort) || input.defaultPort < 1 || input.defaultPort > 65535) {
        throw new StoreError("invalid", "error: default port must be an integer in 1..65535");
      }
      defaultPort = input.defaultPort;
    }
    const rewrite = input.rewrite === undefined ? undefined : normalizeRewrite(input.rewrite);
    const routes = normalizeRoutes(input.routes);
    let serviceId: string;
    do {
      serviceId = randomZ32(SERVICE_ID_BYTES);
    } while (this.data.services.some((s) => s.serviceId === serviceId));
    const service: ServiceConfig = {
      serviceId,
      name,
      match: input.match.map((m) => ({ ...m })),
      upstream: upstreamUrl.href,
      rewrite,
      ...(input.hooks !== undefined ? { hooks: input.hooks } : {}),
      ...(routes !== undefined ? { routes } : {}),
      defaultPort,
      enabled: input.enabled ?? true,
    };
    this.data.services.push(service);
    this.save();
    return { ...service };
  }

  removeService(name: string): void {
    const idx = this.data.services.findIndex((s) => s.name === name);
    if (idx < 0) {
      throw new StoreError("not-found", `error: service '${name}' not found`);
    }
    const [removed] = this.data.services.splice(idx, 1);
    // 同步清出所有分组引用。
    for (const group of this.data.groups) {
      group.serviceIds = group.serviceIds.filter((id) => id !== removed!.serviceId);
    }
    this.save();
  }

  /** 停用/启用（service-lifecycle）：幂等；返回是否发生变更。 */
  setServiceEnabled(serviceId: string, enabled: boolean): { changed: boolean } {
    const idx = this.data.services.findIndex((s) => s.serviceId === serviceId);
    if (idx < 0) {
      throw new StoreError("not-found", `error: service '${serviceId}' not found`);
    }
    if (this.data.services[idx]!.enabled === enabled) return { changed: false };
    this.data.services[idx] = { ...this.data.services[idx]!, enabled };
    this.save();
    return { changed: true };
  }

  // -----------------------------------------------------------------------
  // 分组
  // -----------------------------------------------------------------------

  listGroups(): GroupConfig[] {
    return this.data.groups.map((g) => ({ ...g, serviceIds: [...g.serviceIds] }));
  }

  getGroup(name: string): GroupConfig | undefined {
    const found = this.data.groups.find((g) => g.name === name);
    return found === undefined
      ? undefined
      : { ...found, serviceIds: [...found.serviceIds], limits: found.limits ? { ...found.limits } : undefined };
  }

  /** 组内服务视图（引用不存在的服务Id 自动跳过——防手工编辑残留）。 */
  groupServices(groupName: string): ServiceConfig[] {
    const group = this.getGroup(groupName);
    if (group === undefined) return [];
    const out: ServiceConfig[] = [];
    for (const id of group.serviceIds) {
      const svc = this.getService(id);
      // 停用服务不进目录视图（service-lifecycle）：AUTH_OK 分组载荷与分享链接
      // 初始视图都经此投影——消费端端口自然关停。
      if (svc !== undefined && svc.enabled !== false) out.push(svc);
    }
    return out;
  }

  addGroup(name: string, serviceNames: readonly string[], limits?: GroupLimits | undefined): GroupConfig {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.length > 256) {
      throw new StoreError("invalid", "error: group name must be 1..256 chars");
    }
    if (this.data.groups.some((g) => g.name === trimmed)) {
      throw new StoreError("duplicate", `error: group '${trimmed}' already exists`);
    }
    const serviceIds = this.resolveServiceIds(serviceNames);
    if (limits !== undefined) validateLimits(limits);
    const group: GroupConfig = {
      name: trimmed,
      serviceIds,
      limits: limits === undefined ? undefined : { ...limits },
    };
    this.data.groups.push(group);
    this.save();
    return { ...group, serviceIds: [...serviceIds] };
  }

  /** 更新既有分组的服务引用（整表替换；未知服务名报错）。 */
  setGroupServices(name: string, serviceNames: readonly string[]): GroupConfig {
    const group = this.data.groups.find((g) => g.name === name);
    if (group === undefined) {
      throw new StoreError("not-found", `error: group '${name}' not found`);
    }
    group.serviceIds = this.resolveServiceIds(serviceNames);
    this.save();
    return { ...group, serviceIds: [...group.serviceIds] };
  }

  /** 更新分组限额（undefined = 清除限额变无限）。 */
  setGroupLimits(name: string, limits: GroupLimits | undefined): GroupConfig {
    const group = this.data.groups.find((g) => g.name === name);
    if (group === undefined) {
      throw new StoreError("not-found", `error: group '${name}' not found`);
    }
    if (limits !== undefined) validateLimits(limits);
    group.limits = limits === undefined ? undefined : { ...limits };
    this.save();
    return { ...group, serviceIds: [...group.serviceIds] };
  }

  /** 删除分组（仍有未撤销密钥时拒绝——孤儿密钥会以 key_all_invalid 形态困扰
   *  持钥消费方；先 revoke 再删。Owner 验收 2026-09-10：group 管理对齐 keys）。 */
  removeGroup(name: string): void {
    const index = this.data.groups.findIndex((g) => g.name === name);
    if (index === -1) {
      throw new StoreError("not-found", `error: group '${name}' not found`);
    }
    const activeKeys = this.data.keys.filter((k) => k.group === name && k.revokedAt === undefined);
    if (activeKeys.length > 0) {
      throw new StoreError(
        "conflict",
        `error: group '${name}' still has ${activeKeys.length} active key(s) - revoke them first`,
      );
    }
    this.data.groups.splice(index, 1);
    this.save();
  }

  private resolveServiceIds(serviceNames: readonly string[]): string[] {
    const serviceIds: string[] = [];
    for (const svcName of serviceNames) {
      const svc = this.getServiceByName(svcName);
      if (svc === undefined) {
        throw new StoreError("not-found", `error: service '${svcName}' not found`);
      }
      if (!serviceIds.includes(svc.serviceId)) serviceIds.push(svc.serviceId);
    }
    return serviceIds;
  }

  // -----------------------------------------------------------------------
  // 密钥
  // -----------------------------------------------------------------------

  listKeys(): KeyRecord[] {
    return this.data.keys.map((k) => ({ ...k }));
  }

  /** 签发：name 缺省 "default"；原文随记录落库（Owner 2026-09-13：随时
   *  可复制）。name 是展示标签非身份（keyId 唯一），同组可重名。 */
  issueKey(groupName: string, name = "default"): { keyId: string; key: string; createdAt: number } {
    if (this.getGroup(groupName) === undefined) {
      throw new StoreError("not-found", `error: group '${groupName}' not found`);
    }
    if (!KEY_NAME_SCHEMA.test(name)) {
      throw new StoreError("invalid", "error: key name must match /^[a-z0-9][a-z0-9._-]*$/");
    }
    let keyId: string;
    do {
      keyId = randomZ32(KEY_ID_BYTES);
    } while (this.data.keys.some((k) => k.keyId === keyId));
    const key = KEY_MATERIAL_PREFIX + randomZ32(KEY_MATERIAL_BYTES);
    const createdAt = Date.now();
    this.data.keys.push({ keyId, group: groupName, hash: hashKeyMaterial(key), name, key, createdAt });
    this.save();
    return { keyId, key, createdAt };
  }

  /** key 原文取回（旧记录只存哈希 → undefined；撤销/不存在 → undefined）。 */
  getKeyMaterial(keyId: string): string | undefined {
    const found = this.data.keys.find((k) => k.keyId === keyId);
    if (found === undefined || found.revokedAt !== undefined) return undefined;
    return found.key;
  }

  /** 撤销（幂等：已撤销为 no-op）。 */
  revokeKey(keyId: string): KeyRecord {
    const found = this.data.keys.find((k) => k.keyId === keyId);
    if (found === undefined) {
      throw new StoreError("not-found", `error: key '${keyId}' not found`);
    }
    if (found.revokedAt === undefined) {
      found.revokedAt = Date.now();
      this.save();
    }
    return { ...found };
  }

  /**
   * 校验密钥原文：SHA-256(salt+原文) 后对全表 timingSafeEqual 扫描（不因命中
   * 提前退出，时序与表内容无关节）。命中后按 revokedAt 区分 valid/revoked。
   */
  verifyKey(material: string): KeyCheck {
    const digest = Buffer.from(hashKeyMaterial(material), "hex");
    let match: KeyRecord | undefined;
    for (const record of this.data.keys) {
      const stored = Buffer.from(record.hash, "hex");
      if (digest.length === stored.length && timingSafeEqual(digest, stored)) {
        match = record;
      }
    }
    if (match === undefined) return { status: "invalid" };
    const located = { keyId: match.keyId, group: match.group };
    return match.revokedAt === undefined
      ? { status: "valid", ...located }
      : { status: "revoked", ...located };
  }

  // -----------------------------------------------------------------------
  // 别名（AUTH_OK.alias / 分享链接 provider.alias）
  // -----------------------------------------------------------------------

  get alias(): string | undefined {
    return this.data.meta?.alias;
  }

  setAlias(alias: string): void {
    const trimmed = alias.trim();
    if (trimmed === "" || trimmed.length > 256) {
      throw new StoreError("invalid", "error: alias must be 1..256 chars");
    }
    this.data.meta = { ...(this.data.meta ?? {}), alias: trimmed };
    this.save();
  }

  /** 只读快照（引擎/测试）。 */
  snapshot(): StoreData {
    return JSON.parse(JSON.stringify(this.data)) as StoreData;
  }

  // -----------------------------------------------------------------------
  // 内部
  // -----------------------------------------------------------------------

  private save(): void {
    this.data.revision += 1;
    atomicWriteFileSync(ProviderStore.filePath(this.dataDir), `${JSON.stringify(this.data, null, 2)}\n`);
  }
}

// ---------------------------------------------------------------------------

function validateLimits(limits: GroupLimits): void {
  for (const [key, value] of Object.entries(limits)) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new StoreError("invalid", `error: limit '${key}' must be a positive integer`);
    }
  }
}

/**
 * 路由表规范化（M3-r7）：空表→undefined；模式字段按 mode 归一——
 * prefix：localPrefix 补 / 去尾斜杠（缺省按首个 form 规范前缀）+ upstreamPrefix；
 * pattern：matchPattern 编译校验（{name}→:name 兼容翻译）+ template RFC 6570
 * 解析校验（写入期 fail-fast，运行期零重复解析）。不做语义限制。
 */
function normalizeRoutes(routes: ServiceRoute[] | undefined): ServiceRoute[] | undefined {
  if (routes === undefined) return undefined;
  const cleaned = routes.filter((r) => r !== null && r !== undefined);
  if (cleaned.length === 0) return undefined;
  const out: ServiceRoute[] = [];
  for (const route of cleaned) {
    const forms = [...new Set(route.forms ?? [])];
    if (route.mode === "pattern") {
      const matchPattern = route.matchPattern?.trim() ?? "";
      const template = route.template?.trim() ?? "";
      if (matchPattern === "" || template === "") {
        throw new StoreError("invalid", "error: pattern route requires matchPattern and template");
      }
      try {
        compileMatchPattern(matchPattern);
      } catch (err) {
        throw new StoreError("invalid", `error: invalid matchPattern '${matchPattern}': ${(err as Error).message}`);
      }
      try {
        validateUriTemplate(template);
      } catch (err) {
        throw new StoreError("invalid", `error: invalid template '${template}': ${(err as Error).message}`);
      }
      out.push({ forms, mode: "pattern", matchPattern, template });
      continue;
    }
    let local = route.localPrefix?.trim() ?? "";
    if (local !== "") {
      if (!local.startsWith("/")) local = `/${local}`;
      local = local.replace(/\/+$/, "");
    }
    if (local === "") local = ROUTE_LOCAL_PREFIX[forms[0] ?? "openai-chat"];
    let up = route.upstreamPrefix?.trim() ?? "";
    if (up !== "") {
      if (!up.startsWith("/")) up = `/${up}`;
      up = up.replace(/\/+$/, "");
    }
    out.push({ forms, localPrefix: local, upstreamPrefix: up });
  }
  return out;
}

function normalizeRewrite(rewrite: ServiceRewrite): ServiceRewrite {
  const out: ServiceRewrite = {};
  if (rewrite.hostHeader !== undefined) {
    if (rewrite.hostHeader.trim() === "") {
      throw new StoreError("invalid", "error: rewrite hostHeader must not be empty");
    }
    out.hostHeader = rewrite.hostHeader.trim();
  }
  for (const field of ["pathPrefixStrip", "pathPrefixAppend"] as const) {
    const value = rewrite[field];
    if (value === undefined) continue;
    const norm = value.startsWith("/") ? value : `/${value}`;
    if (norm === "/") {
      throw new StoreError("invalid", `error: rewrite ${field} must not be '/'`);
    }
    out[field] = norm;
  }
  if (rewrite.headerSet !== undefined) {
    const headerSet: Record<string, string | { hook: string; args?: Record<string, string> | undefined; bearer?: boolean | undefined }> = {};
    for (const [name, value] of Object.entries(rewrite.headerSet)) {
      const lower = name.toLowerCase();
      if (lower === "") throw new StoreError("invalid", "error: rewrite headerSet name must not be empty");
      headerSet[lower] = value;
    }
    out.headerSet = headerSet;
  }
  if (rewrite.headerRemove !== undefined) {
    out.headerRemove = [...new Set(rewrite.headerRemove.map((n) => n.toLowerCase()))];
  }
  return out;
}
