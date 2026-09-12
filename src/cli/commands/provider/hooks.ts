// `ai-fly hooks list|get|add|remove|run`：hooks 脚本资源域（与 group/secret 同构；
// cli-hook 管理面）。脚本 = 可枚举资产：内建库（随包）+ 用户库 ~/.aifly/hooks/
// （同名覆盖内建）。函数名命名规范即钩子清单（authHeader 为当前消费点）。
// run 不回显原值（凭据法则：只报 ok/长度/掩码首尾）。

import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { parseArgv } from "../../args.ts";
import { UsageError, reportCliError } from "../../errors.ts";
import {
  discoverHooks,
  disposeHookSubscriptions,
  installUserHook,
  readHookScript,
  removeUserHook,
  resolveHookValue,
} from "../../../provider/hook.ts";
import { SecretsStore } from "../../../provider/secrets.ts";
import { resolveDataDir, str } from "./common.ts";

const SPEC = {
  data: { type: "string", tilde: true },
  file: { type: "string", tilde: true },
  stdin: { type: "boolean" },
  "arg": { type: "multi" },
  bearer: { type: "boolean" },
} as const;

const USAGE = `usage:
  ai-fly hooks list
  ai-fly hooks get <name>
  ai-fly hooks add <name> [--file <path> | --stdin]
  ai-fly hooks remove <name>
  ai-fly hooks run <name> <fn> [--arg k=v]... [--bearer]
hooks 脚本：内建库 + ~/.aifly/hooks/<name>.cjs（用户覆盖内建）；
导出函数名 = 钩子清单（authHeader 为 HTTP 认证头钩子）。`;

export async function run(argv: string[], ctx: { homedir?: string } = {}): Promise<number> {
  const home = ctx.homedir ?? homedir();
  try {
    const sub = argv[0];
    const rest = argv.slice(1);
    switch (sub) {
      case undefined:
      case "list":
        return list(rest, home);
      case "get":
        return get(rest, home);
      case "add":
        return add(rest, home);
      case "remove":
        return remove(rest, home);
      case "run":
        return await runHook(rest, home);
      default:
        throw new UsageError(`error: unknown hooks subcommand '${sub}'\n${USAGE}`);
    }
  } catch (err) {
    return reportCliError(err);
  }
}

function parse(rest: readonly string[], home: string): ReturnType<typeof parseArgv> {
  const { options, positionals } = parseArgv([...rest], SPEC, { homedir: home });
  if (positionals.length > 2) {
    throw new UsageError(`error: unexpected argument '${positionals[2]}'`);
  }
  return { options, positionals };
}

function list(rest: readonly string[], home: string): number {
  parse(rest, home);
  const scripts = discoverHooks(home);
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  out(`hooks scripts (${scripts.length})`);
  for (const s of scripts) {
    out(`  ${s.name.padEnd(16)} [${s.source}]  ${s.fns.join(", ")}`);
  }
  if (scripts.length > 0) {
    out(`use: ai-fly service add <name> --preset <id> --hooks <script>  |  ai-fly hooks run <name> <fn>`);
  } else {
    out("(install one: ai-fly hooks add <name> --file <path.cjs>)");
  }
  return 0;
}

function get(rest: readonly string[], home: string): number {
  const { positionals } = parse(rest, home);
  const name = positionals[0];
  if (name === undefined) throw new UsageError("error: hooks get requires a <name> argument");
  const found = readHookScript(name, home);
  if (found === undefined) {
    throw new UsageError(`error: hook script '${name}' not found (see: ai-fly hooks list)`);
  }
  process.stdout.write(`hooks script '${name}' [${found.source}]\n  path: ${found.path}\n`);
  process.stdout.write(found.content);
  if (!found.content.endsWith("\n")) process.stdout.write("\n");
  return 0;
}

function add(rest: readonly string[], home: string): number {
  const { options, positionals } = parse(rest, home);
  const name = positionals[0];
  if (name === undefined) throw new UsageError("error: hooks add requires a <name> argument");
  let content: string | undefined = options.stdin === true ? undefined : str(options.file) === undefined ? undefined : readContent(str(options.file)!);
  if (options.stdin === true) {
    content = readStdin();
  }
  if (content === undefined) {
    throw new UsageError("error: hooks add requires --file <path> or --stdin for the script content");
  }
  const installed = installUserHook(name, content, home);
  process.stdout.write(
    `hooks script installed: ${installed.name}\n  path: ${installed.path}\n  fns : ${installed.fns.join(", ")}\n`,
  );
  return 0;
}

function readContent(path: string): string {
  return readFileSync(path, "utf8");
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8"); // fd 0 同步读（管道/重定向）
  } catch {
    throw new UsageError("error: --stdin requires piped input (cat script.cjs | ai-fly hooks add <name> --stdin)");
  }
}

function remove(rest: readonly string[], home: string): number {
  const { positionals } = parse(rest, home);
  const name = positionals[0];
  if (name === undefined) throw new UsageError("error: hooks remove requires a <name> argument");
  const removed = removeUserHook(name, home);
  process.stdout.write(`hooks script removed: ${name}\n  path: ${removed.path}\n`);
  return 0;
}

async function runHook(rest: readonly string[], home: string): Promise<number> {
  const { options, positionals } = parse(rest, home);
  const [name, fn] = positionals;
  if (name === undefined || fn === undefined) {
    throw new UsageError("error: hooks run requires <name> <fn> arguments (see: ai-fly hooks list)");
  }
  const args: Record<string, string> = {};
  for (const raw of (options.arg as string[] | undefined) ?? []) {
    const idx = raw.indexOf("=");
    if (idx <= 0) throw new UsageError(`error: --arg expects k=v (got '${raw}')`);
    args[raw.slice(0, idx)] = raw.slice(idx + 1);
  }
  // secrets 访问器接 provider 密钥库（--data 可指定数据目录）
  const store = SecretsStore.open(resolveDataDir(str(options.data), home));
  let value: string | undefined;
  try {
    value = await resolveHookValue(fn, { script: name, home, args, secrets: (n) => store.resolve(n)?.headerValue });
  } catch {
    value = undefined;
  } finally {
    // 订阅模式后台迭代器回收（await：CLI 一次性进程干净退出）
    await disposeHookSubscriptions();
  }
  if (value === undefined) {
    process.stderr.write(`error: hook '${name}.${fn}' did not yield a value (script/fn missing, args invalid, or credential absent)\n`);
    return 1;
  }
  if (options.bearer === true) value = `Bearer ${value}`;
  // 凭据法则：不回显原值——只报长度与首尾掩码
  const masked =
    value.length <= 6
      ? "*".repeat(value.length)
      : `${value.slice(0, 2)}${"*".repeat(Math.min(value.length - 4, 12))}${value.slice(-2)} (len ${value.length})`;
  process.stdout.write(`ok: ${name}.${fn} -> ${masked}\n`);
  // 一次性 CLI：订阅迭代器的 pending next 可能滞留事件循环——显式退出
  process.exit(0);
}
