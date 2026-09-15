// 提供方本地密钥库（secrets.json）：rewrite `$secret:<name>` 引用与 auth.secret
// 槽的唯一取值面。
// hooks-lifecycle 5.2（Owner 裁决 2026-09-15）：**bearerPrefix 条目字段退役**——
// 值为原样存储的字符串（裸 key 或完整头值均可），请求期的 Bearer 前缀拼接由
// 消费方服务的 auth 槽 `bearer` 开关唯一决定（默认拼、已带 Bearer 不重复、
// 关则原样）；旧文件内的 bearerPrefix 字段加载时剥离（zod strip 未知字段语义，
// 下次写入自然落成新形状）。resolve() 因此退化为原样取值的兼容壳（headerValue
// 形状保留给既有调用点）。
// 正交意图（本文件不实现）：
// - 请求期解析（rewrite.ts 的 resolveLiteralHeaderValue / resolveAuthSlotValue；
//   本文件只做存取）；
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

/** 密钥清单条目（RPC list 投影；value 由设计不出现；bearerPrefix 已退役）。 */
export interface SecretEntryView {
  name: string;
  createdAt: number;
  updatedAt: number;
}

/** 解析结果（$secret:/auth.secret 注入用的原样值；Bearer 前缀归 auth 槽）。 */
export interface ResolvedSecret {
  headerValue: string;
}

/** 文件形状：{ version: 1, secrets: { [name]: { value, createdAt, updatedAt } } }。
 *  条目对象为 strip 语义（未知字段剥除）——旧文件的 bearerPrefix 字段加载即剥离。 */
const SECRETS_FILE_SCHEMA = z.strictObject({
  version: z.literal(1),
  secrets: z.record(
    SECRET_NAME_SCHEMA,
    z.object({
      value: z.string().min(1).max(8192),
      createdAt: z.number().int().min(0),
      updatedAt: z.number().int().min(0),
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

  /** 清单（名称/时间戳；按名称排序稳定输出；值绝不出现）。 */
  list(): SecretEntryView[] {
    const { secrets } = this.read();
    return Object.entries(secrets)
      .map(([name, entry]) => ({
        name,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** 取值（未知名返回 undefined——由调用方决定失败语义，如 secret_missing）。 */
  get(name: string): string | undefined {
    const entry = this.read().secrets[name];
    return entry === undefined ? undefined : entry.value;
  }

  /** 解析为注入值：**原样**（Bearer 前缀由消费方服务 auth 槽 bearer 开关拼——
   *  hooks-lifecycle 5.2 起 resolve 不再做任何前缀加工；headerValue 形状保留
   *  给既有调用点）。$secret:/test 与连通测试草稿一律走这里或 get()。 */
  resolve(name: string): ResolvedSecret | undefined {
    const entry = this.read().secrets[name];
    if (entry === undefined) return undefined;
    return { headerValue: entry.value };
  }

  /** 新增/覆写（原样值；createdAt 首次落定时固定，覆写只动 updatedAt。
   *  hooks-lifecycle 5.2：不再接受 bearerPrefix 参数）。 */
  set(name: string, value: string): SecretEntryView {
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
    const entry = {
      value,
      createdAt: previous === undefined ? now : previous.createdAt,
      updatedAt: now,
    };
    data.secrets[name] = entry;
    this.write(data);
    return { name, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
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
