// UI daemon 侧统一领域错误（router 边界映射为 ORPCError；码表见 shared 契约）。
// 照抄 skill-creator-v2 的 DomainError 语义：有限词汇、英文 ASCII message、
// 只在 RPC 根边界转换一次。

import type { RpcErrorCode } from "../shared/rpc-contract.ts";

/** 领域错误：码必须落在共享契约的有限词汇内。 */
export class DomainError extends Error {
  readonly code: RpcErrorCode;

  constructor(code: RpcErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

/** M1 引擎错误到领域错误的统一映射（StoreError/CliError/UsageError/LinkError → 码表）。 */
export function toDomainError(err: unknown): DomainError {
  if (err instanceof DomainError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // ASCII 化：M1 文案本身已是英文 ASCII；非 Error 值兜底
  const safeMessage = /^[\x20-\x7e]*$/.test(message) ? message : "engine error";
  const name = err instanceof Error ? err.name : "";
  if (name === "StoreError") {
    const code = (err as { code?: string }).code;
    if (code === "duplicate") return new DomainError("CONFLICT", safeMessage);
    if (code === "not-found") return new DomainError("NOT_FOUND", safeMessage);
    if (code === "invalid") return new DomainError("INVALID_INPUT", safeMessage);
    return new DomainError("INTERNAL", safeMessage); // corrupt
  }
  if (name === "UsageError") return new DomainError("INVALID_INPUT", safeMessage);
  if (name === "LinkError") return new DomainError("INVALID_INPUT", safeMessage);
  if (name === "CliError") {
    // CLI 错误多为 usage/not-found 语义；按前缀归并，其余落 INVALID_INPUT
    if (safeMessage.includes("not found")) return new DomainError("NOT_FOUND", safeMessage);
    return new DomainError("INVALID_INPUT", safeMessage);
  }
  return new DomainError("INTERNAL", "internal error");
}
