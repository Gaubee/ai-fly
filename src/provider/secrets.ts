// 提供方本地密钥库（secrets.json）：rewrite `$secret:<name>` 引用的唯一取值面。
// 正交意图（本文件不实现）：
// - 请求期解析（rewrite.ts 的 resolveHeaderValue；本文件只做存取）；
// - RPC 面（rpc-router 直连本 store；list 只投影名称与时间戳，值绝不跨 RPC）；
// - $env: 语义（process.env；与本库并存于不同头）。
// 设计裁决（跨进程一致性）：store 不持有内存态——每次操作重读 secrets.json。
// UI daemon（RPC 写）与 provider daemon（转发读）是同进程不同实例或跨进程实例，
// 无内存缓存即无失效问题（与 services.json 的 revision/watcher 机制相比更简单：
// 密钥库只被密钥面板低频写、被 $secret 引用的请求低频读，每请求一次小文件读可接受；
// 无 $secret 引用的服务零额外 IO）。
// 存储：与 services.json 同目录约定（~/.aifly/provider/secrets.json），目录 0700 /
// 文件 0600 / 原子写 tmp+rename（复用 store.ts 原语）。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SECRET_NAME_SCHEMA } from "../shared/rpc-contract.ts";
import { StoreError, atomicWriteFileSync, ensurePrivateDir } from "./store.ts";

/** 密钥清单条目（RPC list 投影；value 由设计不出现）。 */
export interface SecretEntryView {
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 注入时自动拼 "Bearer " 前缀（默认 true；Owner 裁决 2026-09-10：密钥值默认
   *  是裸 key，不再要求用户手写完整头值；非 Bearer 站点关闭即可）。 */
  bearerPrefix: boolean;
}

/** 解析结果（$secret:/test 注入用的最终头值）。 */
export interface ResolvedSecret {
  headerValue: string;
}

/** 文件形状：{ version: 1, secrets: { [name]: { value, createdAt, updatedAt, bearerPrefix } } }。
 *  旧文件无 bearerPrefix 字段按 true 读入（zod default，写入时补齐）。 */
const SECRETS_FILE_SCHEMA = z.strictObject({
  version: z.literal(1),
  secrets: z.record(
    SECRET_NAME_SCHEMA,
    z.strictObject({
      value: z.string().min(1).max(8192),
      createdAt: z.number().int().min(0),
      updatedAt: z.number().int().min(0),
      bearerPrefix: z.boolean().default(true),
    }),
  ),
});

type SecretsFile = z.infer<typeof SECRETS_FILE_SCHEMA>;

const SECRETS_VALUE_MAX = 8192;

export class SecretsStore {
  readonly dataDir: string;

  private constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  static filePath(dataDir: string): string {
    return join(dataDir, "secrets.json");
  }

  /** 打开（确保目录存在；文件不存在视为空库——首次 set 时落盘）。 */
  static open(dataDir: string): SecretsStore {
    ensurePrivateDir(dataDir);
    return new SecretsStore(dataDir);
  }

  /** 读盘 + 校验（不存在 → 空库；损坏/非法抛 StoreError(corrupt)）。 */
  private read(): SecretsFile {
    const path = SecretsStore.filePath(this.dataDir);
    if (!existsSync(path)) return { version: 1, secrets: {} };
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
    const result = SECRETS_FILE_SCHEMA.safeParse(parsed);
    if (!result.success) {
      throw new StoreError("corrupt", `error: ${path} failed validation: ${result.error.message}`);
    }
    return result.data;
  }

  private write(data: SecretsFile): void {
    atomicWriteFileSync(SecretsStore.filePath(this.dataDir), `${JSON.stringify(data, null, 2)}\n`);
  }

  /** 清单（名称/时间戳/bearer 开关；按名称排序稳定输出）。 */
  list(): SecretEntryView[] {
    const { secrets } = this.read();
    return Object.entries(secrets)
      .map(([name, entry]) => ({
        name,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        bearerPrefix: entry.bearerPrefix,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** 取值（未知名返回 undefined——由调用方决定失败语义，如 secret_missing）。 */
  get(name: string): string | undefined {
    const entry = this.read().secrets[name];
    return entry === undefined ? undefined : entry.value;
  }

  /** 解析为最终注入头值：bearerPrefix 开启时前拼 "Bearer "（幂等：值已以
   *  Bearer 开头则不再重复拼）。$secret:/test 一律走这里，不直接用 get()。 */
  resolve(name: string): ResolvedSecret | undefined {
    const entry = this.read().secrets[name];
    if (entry === undefined) return undefined;
    const bare = entry.value;
    const headerValue =
      entry.bearerPrefix && !/^Bearer\s/i.test(bare) ? `Bearer ${bare}` : bare;
    return { headerValue };
  }

  /** 新增/覆写（返回清单投影；createdAt 首次落定时固定，覆写只动 updatedAt）。 */
  set(name: string, value: string, opts?: { bearerPrefix?: boolean }): SecretEntryView {
    if (!SECRET_NAME_SCHEMA.safeParse(name).success) {
      throw new StoreError(
        "invalid",
        "error: secret name must be 1..128 chars of lowercase letters, digits, dot, dash, underscore",
      );
    }
    if (value === "" || value.length > SECRETS_VALUE_MAX) {
      throw new StoreError("invalid", `error: secret value must be 1..${SECRETS_VALUE_MAX} chars`);
    }
    const data = this.read();
    const now = Date.now();
    const previous = data.secrets[name];
    const bearerPrefix = opts?.bearerPrefix ?? previous?.bearerPrefix ?? true;
    const entry = {
      value,
      createdAt: previous === undefined ? now : previous.createdAt,
      updatedAt: now,
      bearerPrefix,
    };
    data.secrets[name] = entry;
    this.write(data);
    return { name, createdAt: entry.createdAt, updatedAt: entry.updatedAt, bearerPrefix };
  }

  /** 删除（不存在抛 StoreError(not-found)——RPC 边界映射 NOT_FOUND）。 */
  remove(name: string): void {
    const data = this.read();
    if (data.secrets[name] === undefined) {
      throw new StoreError("not-found", `error: secret '${name}' not found`);
    }
    delete data.secrets[name];
    this.write(data);
  }
}
