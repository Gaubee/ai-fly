// AUTH 策略（纯逻辑 + 会话表）：多密钥钥环逐一校验 -> AUTH_OK 目录视图 / AUTH_ERR；
// 撤钥后的会话处置（refresh 剔除 / 无余钥断开）。
// 正交意图（本文件不实现）：
// - 传输与 authed 状态（WireSession 管理；本模块产出帧头，由引擎发送）；
// - 目录内容的组装来源（AuthDirectory 注入：store + alias + relayUrls）；
// - 密钥原文的持有与生命周期（引擎的会话记录持有钥环原文用于撤钥后重算，
//   本模块只做校验与视图重建；密钥 MUST NOT 出现在日志）。
// 语义对齐 wire-protocol spec：全无效 -> AUTH_ERR(key_all_invalid) 单次即断；
// 重复 AUTH 以最后一次为准；rejected 载荷码仅 key_invalid / key_revoked。

import type { AuthErrHeader, AuthHeader, AuthOkHeader, GroupEntry, ServiceEntry } from "../wire/frames.ts";
import { REJECTED_CODE } from "../wire/frames.ts";
import type { ProviderStore, GroupLimits, KeyCheck } from "./store.ts";
import { buildServiceEntry } from "./detail.ts";

/** 有效密钥定位（AUTH_OK.groups 的骨架）。 */
export interface KeyGrant {
  keyId: string;
  group: string;
}

/** 目录数据源（引擎注入；测试可用内存假体）。 */
export interface AuthDirectory {
  alias: string;
  relayUrls: readonly string[];
  verifyKey(key: string): KeyCheck;
  groupLimits(group: string): GroupLimits | undefined;
  groupServices(group: string): ServiceEntry[];
}

export function authDirectoryFromStore(
  store: ProviderStore,
  over: { alias?: string | undefined; relayUrls?: readonly string[] | undefined } = {},
): AuthDirectory {
  return {
    alias: over.alias ?? store.alias ?? "provider",
    relayUrls: over.relayUrls ?? [],
    verifyKey: (key) => store.verifyKey(key),
    groupLimits: (group) => store.getGroup(group)?.limits,
    groupServices: (group) => store.groupServices(group).map(buildServiceEntry),
  };
}

export interface KeyringEvaluation {
  valid: KeyGrant[];
  rejected: Array<{ code: "key_invalid" | "key_revoked" }>;
}

/** 钥环逐一校验（去重后；rejected 上限 64 对齐 wire schema）。 */
export function evaluateKeyring(keys: readonly string[], dir: AuthDirectory): KeyringEvaluation {
  const seen = new Set<string>();
  const valid: KeyGrant[] = [];
  const rejected: KeyringEvaluation["rejected"] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const check = dir.verifyKey(key);
    if (check.status === "valid") {
      valid.push({ keyId: check.keyId, group: check.group });
    } else if (check.status === "revoked") {
      if (rejected.length < 64) rejected.push({ code: REJECTED_CODE.key_revoked });
    } else {
      if (rejected.length < 64) rejected.push({ code: REJECTED_CODE.key_invalid });
    }
  }
  return { valid, rejected };
}

/** 每枚有效密钥 -> {keyId, group, limits, services[含 detail]} 视图。 */
export function buildAuthOk(
  valid: readonly KeyGrant[],
  dir: AuthDirectory,
  opts: { refresh?: boolean | undefined } = {},
): AuthOkHeader {
  const groups: GroupEntry[] = valid.map((grant) => {
    const limits = dir.groupLimits(grant.group) ?? {};
    return {
      keyId: grant.keyId,
      group: grant.group,
      limits,
      services: dir.groupServices(grant.group),
    };
  });
  const header: AuthOkHeader = {
    v: 1,
    alias: dir.alias,
    relayUrls: [...dir.relayUrls],
    groups,
  };
  // exactOptionalPropertyTypes：可选字段仅在存在时落键。
  if (opts.refresh === true) header.refresh = true;
  return header;
}

export type AuthDecision =
  | { kind: "ok"; header: AuthOkHeader; valid: KeyGrant[]; keys: string[] }
  | { kind: "err"; header: AuthErrHeader };

/** AUTH 帧决策（纯）：全无效 -> err（调用方发送后断开）。 */
export function handleAuthFrame(header: AuthHeader, dir: AuthDirectory): AuthDecision {
  const { valid, rejected } = evaluateKeyring(header.keys, dir);
  if (valid.length === 0) {
    return {
      kind: "err",
      header: { v: 1, code: "key_all_invalid", message: "all presented keys are invalid or revoked" },
    };
  }
  const ok = buildAuthOk(valid, dir);
  if (rejected.length > 0) ok.rejected = rejected;
  return { kind: "ok", header: ok, valid, keys: [...new Set(header.keys)] };
}

// ---------------------------------------------------------------------------
// 会话表（keyId -> 持钥会话）：撤钥时定位受影响会话
// ---------------------------------------------------------------------------

/**
 * 持钥会话绑定（引擎实现）：keys 为该会话最近一次 AUTH 呈交的钥环原文（仅内存，
 * 用于撤钥/目录变更后重算授权；MUST NOT 进日志）。
 */
export interface AuthSessionBinding {
  readonly keys: readonly string[];
  /** 当前有效 keyId 集合（撤钥定位用）。 */
  readonly keyIds: ReadonlySet<string>;
  /** 推送 refresh AUTH_OK（全量替换语义）。 */
  pushRefresh(header: AuthOkHeader): Promise<void>;
  /** 断开会话（无余钥）。 */
  disconnect(reason: string): void;
}

export class KeySessionIndex {
  private readonly byKey = new Map<string, Set<AuthSessionBinding>>();

  /** 登记/更新会话的 keyId 归属（重复 AUTH 以最后一次为准）。 */
  track(binding: AuthSessionBinding): void {
    this.untrack(binding);
    for (const keyId of binding.keyIds) {
      let set = this.byKey.get(keyId);
      if (set === undefined) {
        set = new Set();
        this.byKey.set(keyId, set);
      }
      set.add(binding);
    }
  }

  untrack(binding: AuthSessionBinding): void {
    for (const [keyId, set] of this.byKey) {
      set.delete(binding);
      if (set.size === 0) this.byKey.delete(keyId);
    }
  }

  sessionsWithKey(keyId: string): AuthSessionBinding[] {
    return [...(this.byKey.get(keyId) ?? [])];
  }

  size(): number {
    let total = new Set<AuthSessionBinding>();
    for (const set of this.byKey.values()) total = new Set([...total, ...set]);
    return total.size;
  }
}

/**
 * 撤钥后的会话处置（对每个持该钥的在线会话）：
 * - 余钥仍有效 -> 推送 refresh AUTH_OK（剔除被撤组，全量替换）；
 * - 无余钥 -> 断开会话。
 * 返回处置统计（测试与状态上报用）。
 */
export async function applyKeyRevocation(
  keyId: string,
  dir: AuthDirectory,
  index: KeySessionIndex,
): Promise<{ refreshed: number; disconnected: number }> {
  let refreshed = 0;
  let disconnected = 0;
  for (const binding of index.sessionsWithKey(keyId)) {
    const { valid } = evaluateKeyring(binding.keys, dir);
    if (valid.length === 0) {
      binding.disconnect(`key ${keyId} revoked and no valid key remains`);
      disconnected++;
      continue;
    }
    await binding.pushRefresh(buildAuthOk(valid, dir, { refresh: true }));
    refreshed++;
  }
  return { refreshed, disconnected };
}
