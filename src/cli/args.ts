// 参数解析（对齐 opendweb 生态约定）：`--opt value` 与 `--opt=value` 完全等价；
// 布尔 flag 不带值；路径类值做 `~` 展开；未知选项抛 UsageError（退出码 2）并列出
// 已知选项。同时承载时长解析（--ttl / --invite-ttl 等共用）。

import { UsageError, CliError } from "./errors.ts";

/** 单个选项的声明：type=multi 可重复出现收集为数组；tilde 声明路径语义。 */
export interface OptionDecl {
  type: "string" | "boolean" | "multi";
  tilde?: boolean;
}

export type OptionValue = string | boolean | string[];

export interface ParsedArgs {
  options: Readonly<Record<string, OptionValue>>;
  positionals: readonly string[];
}

export function expandTilde(value: string, homedir: string): string {
  if (value === "~") return homedir;
  if (value.startsWith("~/")) return homedir + value.slice(1);
  return value;
}

/**
 * 解析带 ms|s|m|h|d 后缀的时长；裸数字按毫秒（与 opendweb-example 同规）。
 * 语法错误抛 CliError；值域检查由调用方按各选项边界执行。
 */
export function parseDurationMs(raw: string, label: string): number {
  const m = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h|d)?$/.exec(String(raw).trim());
  if (!m) {
    throw new CliError(`error: invalid ${label} value: ${raw} (expected <number>[ms|s|m|h|d])`);
  }
  const n = Number(m[1]);
  const unit = m[2] ?? "ms";
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const ms = n * (mult[unit] ?? 1);
  // 上溢保护：巨大后缀值必须报越界而不是回绕。
  if (!Number.isFinite(ms) || ms > Number.MAX_SAFE_INTEGER) {
    return Number.POSITIVE_INFINITY;
  }
  return ms;
}

export function assertDurationRange(
  ms: number,
  minMs: number,
  maxMs: number,
  label: string,
  rangeText: string,
): void {
  if (!(ms >= minMs && ms <= maxMs)) {
    throw new CliError(`error: ${label} out of range (${rangeText})`);
  }
}

export function parseArgv(
  argv: readonly string[],
  spec: Readonly<Record<string, OptionDecl>>,
  ctx: { homedir?: string } = {},
): ParsedArgs {
  const homedir = ctx.homedir ?? "";
  const options: Record<string, OptionValue> = {};
  const positionals: string[] = [];
  const known = Object.keys(spec);

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--") {
      for (let j = i + 1; j < argv.length; j++) positionals.push(argv[j]!);
      break;
    }
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const name = (eq >= 0 ? tok.slice(2, eq) : tok.slice(2)).trim();
      const inlineValue = eq >= 0 ? tok.slice(eq + 1) : undefined;
      const decl = spec[name];
      if (!decl) {
        throw new UsageError(
          `error: unknown option --${name} (known: ${known.map((k) => `--${k}`).join(", ")})`,
        );
      }
      if (decl.type === "boolean") {
        if (inlineValue !== undefined) {
          throw new UsageError(`error: option --${name} does not take a value`);
        }
        options[name] = true;
      } else {
        let value = inlineValue;
        if (value === undefined) {
          if (i + 1 >= argv.length) {
            throw new UsageError(`error: option --${name} requires a value`);
          }
          value = argv[++i]!;
        }
        if (decl.tilde) value = expandTilde(value, homedir);
        if (decl.type === "multi") {
          const list = Array.isArray(options[name]) ? (options[name] as string[]) : [];
          list.push(value);
          options[name] = list;
        } else {
          options[name] = value;
        }
      }
    } else {
      positionals.push(tok);
    }
  }
  return { options, positionals };
}
