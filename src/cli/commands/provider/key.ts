// `ai-fly key <issue|list|revoke|show>`（提供方侧；`key add` 是使用方侧，另文件接入）：
// issue 带 --name（缺省 default；原文随库存储）；list 含名与状态；show 随时
// 取回原文（Owner 裁决 2026-09-13：可复制取代仅签发时可见）；revoke 即刻生效。

import { homedir } from "node:os";
import { parseArgv, type OptionValue } from "../../args.ts";
import { UsageError, reportCliError } from "../../errors.ts";
import { openStore, resolveDataDir, requireString, str } from "./common.ts";

const SPEC = {
  data: { type: "string", tilde: true },
  group: { type: "string" },
  name: { type: "string" },
} as const;

const USAGE = `usage:
  ai-fly key issue --group <name> [--name <keyName>] [--data <dir>]
  ai-fly key list [--data <dir>]
  ai-fly key show <keyId> [--data <dir>]
  ai-fly key revoke <keyId> [--data <dir>]`;

export async function run(argv: string[], ctx: { homedir?: string } = {}): Promise<number> {
  try {
    const home = ctx.homedir ?? homedir();
    const { options, positionals } = parseArgv(argv, SPEC, { homedir: home });
    const sub = positionals[0];
    if (sub === "issue") return issue(options, home);
    if (sub === "list") return list(options, home);
    if (sub === "show") return show(options, positionals, home);
    if (sub === "revoke") return revoke(options, positionals, home);
    if (sub === undefined) throw new UsageError(USAGE);
    throw new UsageError(`error: unknown key subcommand '${sub}' (known: issue, list, show, revoke)`);
  } catch (err) {
    return reportCliError(err);
  }
}

function issue(options: Readonly<Record<string, OptionValue>>, home: string): number {
  const group = requireString(str(options.group), "group");
  const name = str(options.name) ?? "default";
  const store = openStore(resolveDataDir(str(options.data), home), home);
  const issued = store.issueKey(group, name);
  process.stdout.write(
    [
      `key '${name}' issued for group '${group}'`,
      `  keyId: ${issued.keyId}`,
      `  key : ${issued.key}`,
      "",
      "The raw key is stored locally - re-show it anytime with: ai-fly key show " + issued.keyId,
      "Revoke with: ai-fly key revoke " + issued.keyId,
      "",
    ].join("\n"),
  );
  return 0;
}

function list(options: Readonly<Record<string, OptionValue>>, home: string): number {
  const store = openStore(resolveDataDir(str(options.data), home), home);
  const keys = store.listKeys();
  if (keys.length === 0) {
    process.stdout.write("no keys issued (see: ai-fly key issue --group <name>)\n");
    return 0;
  }
  const lines: string[] = [];
  for (const k of keys) {
    const status = k.revokedAt === undefined ? "active" : `revoked at ${new Date(k.revokedAt).toISOString()}`;
    const name = k.name ?? "(unnamed)";
    lines.push(`${k.keyId}  name=${name}  group=${k.group}  created=${new Date(k.createdAt).toISOString()}  ${status}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

function show(options: Readonly<Record<string, OptionValue>>, positionals: readonly string[], home: string): number {
  const keyId = positionals[1];
  if (keyId === undefined) throw new UsageError("error: key show requires a <keyId> argument");
  const store = openStore(resolveDataDir(str(options.data), home), home);
  const material = store.getKeyMaterial(keyId);
  if (material === undefined) {
    process.stdout.write(
      `key '${keyId}' has no retrievable material (missing, revoked, or issued before raw storage)\n`,
    );
    return 1;
  }
  process.stdout.write(`${material}\n`);
  return 0;
}

function revoke(options: Readonly<Record<string, OptionValue>>, positionals: readonly string[], home: string): number {
  const keyId = positionals[1];
  if (keyId === undefined) throw new UsageError("error: key revoke requires a <keyId> argument");
  const store = openStore(resolveDataDir(str(options.data), home), home);
  const record = store.revokeKey(keyId);
  process.stdout.write(
    record.revokedAt === undefined
      ? `key revoked: ${keyId}\n`
      : `key was already revoked: ${keyId}\n`,
  );
  return 0;
}
