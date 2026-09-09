// `ai-fly service <add|list|remove>`：服务管理（match 展示集 / upstream / rewrite /
// defaultPort）。defaultPort 规则（上游端口 <1024 必须显式 --port）由 store 校验。

import { homedir } from "node:os";
import { parseArgv, type OptionValue } from "../../args.ts";
import { UsageError, reportCliError } from "../../errors.ts";
import {
  buildRewrite,
  multi,
  openStore,
  parseHeaderSetSpec,
  parseMatchSpec,
  parsePortNumber,
  resolveDataDir,
  requireString,
  str,
} from "./common.ts";

const SPEC = {
  data: { type: "string", tilde: true },
  upstream: { type: "string" },
  port: { type: "string" },
  match: { type: "multi" },
  host: { type: "string" },
  strip: { type: "string" },
  append: { type: "string" },
  "header-set": { type: "multi" },
  "header-remove": { type: "multi" },
} as const;

const USAGE = `usage:
  ai-fly service add <name> --upstream <url> [--port <n>] [--match <exact|suffix|regex>:<value>]...
                      [--host <host>] [--strip <prefix>] [--append <prefix>]
                      [--header-set <name>=<value|$env:VAR>]... [--header-remove <name>]... [--data <dir>]
  ai-fly service list [--data <dir>]
  ai-fly service remove <name> [--data <dir>]`;

export async function run(argv: string[], ctx: { homedir?: string } = {}): Promise<number> {
  try {
    const home = ctx.homedir ?? homedir();
    const { options, positionals } = parseArgv(argv, SPEC, { homedir: home });
    const sub = positionals[0];
    if (sub === "add") return add(options, positionals, home);
    if (sub === "list") return list(options, home);
    if (sub === "remove") return remove(options, positionals, home);
    if (sub === undefined) throw new UsageError(USAGE);
    throw new UsageError(`error: unknown service subcommand '${sub}' (known: add, list, remove)`);
  } catch (err) {
    return reportCliError(err);
  }
}

function add(options: Readonly<Record<string, OptionValue>>, positionals: readonly string[], home: string): number {
  const name = positionals[1];
  if (name === undefined) throw new UsageError("error: service add requires a <name> argument");
  const upstream = requireString(str(options.upstream), "upstream");
  const matchSpecs = multi(options.match).map(parseMatchSpec);
  if (matchSpecs.length === 0) {
    throw new UsageError("error: service add requires at least one --match <type>:<value>");
  }
  const dataDir = resolveDataDir(str(options.data), home);
  const store = openStore(dataDir);
  const service = store.addService({
    name,
    upstream,
    match: matchSpecs,
    defaultPort: options.port === undefined ? undefined : parsePortNumber(str(options.port)!, "port"),
    rewrite: buildRewrite({
      host: str(options.host),
      strip: str(options.strip),
      append: str(options.append),
      headerSet: multi(options["header-set"]).map(parseHeaderSetSpec),
      headerRemove: multi(options["header-remove"]).map((n) => n.toLowerCase()),
    }),
  });
  process.stdout.write(
    [
      `service added: ${service.name}`,
      `  serviceId  : ${service.serviceId}`,
      `  upstream   : ${service.upstream}`,
      `  defaultPort: ${service.defaultPort}`,
      `  match      : ${service.match.map((m) => `${m.type}:${m.value}`).join(", ")}`,
      "",
    ].join("\n"),
  );
  return 0;
}

function list(options: Readonly<Record<string, OptionValue>>, home: string): number {
  const store = openStore(resolveDataDir(str(options.data), home));
  const services = store.listServices();
  if (services.length === 0) {
    process.stdout.write("no services configured (see: ai-fly service add)\n");
    return 0;
  }
  const lines: string[] = [];
  for (const s of services) {
    lines.push(`${s.name}  [${s.serviceId}]`);
    lines.push(`  upstream   : ${s.upstream}`);
    lines.push(`  defaultPort: ${s.defaultPort}`);
    lines.push(`  match      : ${s.match.map((m) => `${m.type}:${m.value}`).join(", ")}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

function remove(options: Readonly<Record<string, OptionValue>>, positionals: readonly string[], home: string): number {
  const name = positionals[1];
  if (name === undefined) throw new UsageError("error: service remove requires a <name> argument");
  const store = openStore(resolveDataDir(str(options.data), home));
  store.removeService(name);
  process.stdout.write(`service removed: ${name}\n`);
  return 0;
}
