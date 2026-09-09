// `ai-fly key <issue|list|revoke>`（提供方侧；`key add` 是使用方侧，另文件接入）：
// issue 原文一次性展示；list 仅 keyId/创建时间/状态（原文不可再现）；revoke 即刻生效。

import { homedir } from "node:os";
import { parseArgv, type OptionValue } from "../../args.ts";
import { UsageError, reportCliError } from "../../errors.ts";
import { openStore, resolveDataDir, requireString, str } from "./common.ts";

const SPEC = {
  data: { type: "string", tilde: true },
  group: { type: "string" },
} as const;

const USAGE = `usage:
  ai-fly key issue --group <name> [--data <dir>]
  ai-fly key list [--data <dir>]
  ai-fly key revoke <keyId> [--data <dir>]`;

export async function run(argv: string[], ctx: { homedir?: string } = {}): Promise<number> {
  try {
    const home = ctx.homedir ?? homedir();
    const { options, positionals } = parseArgv(argv, SPEC, { homedir: home });
    const sub = positionals[0];
    if (sub === "issue") return issue(options, home);
    if (sub === "list") return list(options, home);
    if (sub === "revoke") return revoke(options, positionals, home);
    if (sub === undefined) throw new UsageError(USAGE);
    throw new UsageError(`error: unknown key subcommand '${sub}' (known: issue, list, revoke)`);
  } catch (err) {
    return reportCliError(err);
  }
}

function issue(options: Readonly<Record<string, OptionValue>>, home: string): number {
  const group = requireString(str(options.group), "group");
  const store = openStore(resolveDataDir(str(options.data), home));
  const issued = store.issueKey(group);
  process.stdout.write(
    [
      `key issued for group '${group}'`,
      `  keyId: ${issued.keyId}`,
      `  key : ${issued.key}`,
      "",
      "This secret is shown only once. Store it now (password manager or share link).",
      "Revoke with: ai-fly key revoke " + issued.keyId,
      "",
    ].join("\n"),
  );
  return 0;
}

function list(options: Readonly<Record<string, OptionValue>>, home: string): number {
  const store = openStore(resolveDataDir(str(options.data), home));
  const keys = store.listKeys();
  if (keys.length === 0) {
    process.stdout.write("no keys issued (see: ai-fly key issue --group <name>)\n");
    return 0;
  }
  const lines: string[] = [];
  for (const k of keys) {
    const status = k.revokedAt === undefined ? "active" : `revoked at ${new Date(k.revokedAt).toISOString()}`;
    lines.push(`${k.keyId}  group=${k.group}  created=${new Date(k.createdAt).toISOString()}  ${status}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

function revoke(options: Readonly<Record<string, OptionValue>>, positionals: readonly string[], home: string): number {
  const keyId = positionals[1];
  if (keyId === undefined) throw new UsageError("error: key revoke requires a <keyId> argument");
  const store = openStore(resolveDataDir(str(options.data), home));
  const record = store.revokeKey(keyId);
  process.stdout.write(
    record.revokedAt === undefined
      ? `key revoked: ${keyId}\n`
      : `key was already revoked: ${keyId}\n`,
  );
  return 0;
}
