// CLI 错误体系：UsageError（用户敲错命令/选项，退出码 2）与 CliError（运行期失败，
// 退出码 1）。message 面向终端用户，一律英文 ASCII（产品约定，码位 < 128）。

export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = "UsageError";
  }
}

/** 顶层兜底：把 Error 映射为终端输出 + 退出码；CliError 按其携带码，其余按 1。 */
export function reportCliError(err: unknown): number {
  if (err instanceof CliError) {
    process.stderr.write(`${err.message}\n`);
    return err.exitCode;
  }
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  return 1;
}
