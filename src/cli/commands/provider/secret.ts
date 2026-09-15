// `ai-fly secret set|list|remove`（cli-parity B2）：provider 侧密钥库的 CLI 面
// （与 GUI 密钥库同源 SecretsStore）。法则：值永不出库——没有 get 子命令；
// set 缺 --value/--stdin 且在 TTY 上时隐藏交互输入（回显 *）。
// hooks-lifecycle 5.2：bearerPrefix 退役——值原样存储，Bearer 前缀由服务的
// auth 槽 bearer 开关决定（--no-bearer 旗标已删除）。

import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import process from "node:process";
import { parseArgv } from "../../args.ts";
import { UsageError, reportCliError } from "../../errors.ts";
import { resolveDataDir, str } from "./common.ts";
import { SecretsStore } from "../../../provider/secrets.ts";

const SPEC = {
  data: { type: "string", tilde: true },
  value: { type: "string" },
  stdin: { type: "boolean" },
} as const;

const USAGE = `usage:
  ai-fly secret set <name> [--value <v> | --stdin] [--data <dir>]
  ai-fly secret list [--data <dir>]
  ai-fly secret remove <name> [--data <dir>]
(the raw value is never displayed or returned - there is no 'secret get';
 the Bearer prefix is decided by each service's auth slot, not the store)`;

export async function run(argv: string[], ctx: { homedir?: string } = {}): Promise<number> {
  try {
    const home = ctx.homedir ?? homedir();
    const { options, positionals } = parseArgv(argv, SPEC, { homedir: home });
    const sub = positionals[0];
    if (sub === "set") return await set(options, positionals, home);
    if (sub === "list") return list(options, home);
    if (sub === "remove") return remove(options, positionals, home);
    if (sub === undefined) throw new UsageError(USAGE);
    throw new UsageError(`error: unknown secret subcommand '${sub}' (known: set, list, remove)`);
  } catch (err) {
    return reportCliError(err);
  }
}

/** 隐藏输入（TTY）：回显屏蔽为 *；非 TTY 无 --value/--stdin 即报错。 */
async function readHidden(prompt: string): Promise<string> {
  const muted = new Writable({
    write(chunk, _enc, callback): void {
      process.stdout.write(/\r|\n/.test(String(chunk)) ? "\n" : "*");
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  const answer = await new Promise<string>((resolve) => {
    rl.question(prompt, (value) => resolve(value));
  });
  rl.close();
  return answer;
}

async function set(options: Readonly<Record<string, unknown>>, positionals: readonly string[], home: string): Promise<number> {
  const name = positionals[1];
  if (name === undefined) throw new UsageError("error: secret set requires a <name> argument");
  let value: string | undefined = options.value === undefined ? undefined : String(options.value);
  if (options.stdin === true) {
    value = await readFileSyncStdin();
  } else if (value === undefined) {
    if (!process.stdin.isTTY) {
      throw new UsageError("error: no TTY - pass --value <v> or --stdin for the secret value");
    }
    value = (await readHidden(`value for '${name}': `)).trim();
  }
  if (value === "") throw new UsageError("error: secret value must not be empty");
  const store = SecretsStore.open(resolveDataDir(str(options.data as string | undefined), home));
  const entry = store.set(name, value);
  process.stdout.write(
    `secret set: ${entry.name} - inject with service auth slot {secret: ${entry.name}} (Bearer prefix per auth.bearer)\n`,
  );
  return 0;
}

async function readFileSyncStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function list(options: Readonly<Record<string, unknown>>, home: string): number {
  const store = SecretsStore.open(resolveDataDir(str(options.data as string | undefined), home));
  const secrets = store.list();
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  out(`secrets (${secrets.length})`);
  for (const entry of secrets) {
    const created = new Date(entry.createdAt).toISOString().slice(0, 16).replace("T", " ");
    const updated = entry.updatedAt === entry.createdAt ? "" : ` updated ${new Date(entry.updatedAt).toISOString().slice(0, 16).replace("T", " ")}`;
    out(`  ${entry.name.padEnd(24)} ${created}${updated}`);
  }
  return 0;
}

function remove(options: Readonly<Record<string, unknown>>, positionals: readonly string[], home: string): number {
  const name = positionals[1];
  if (name === undefined) throw new UsageError("error: secret remove requires a <name> argument");
  const store = SecretsStore.open(resolveDataDir(str(options.data as string | undefined), home));
  store.remove(name);
  process.stdout.write(`secret removed: ${name}\n`);
  return 0;
}
