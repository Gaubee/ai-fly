// `ai-fly group <add|set-services|list>`：分组管理（服务引用 + 可选分组级限额）。
// 限额结构 {maxConcurrency?, dailyRequests?} 由 limits.ts 执行，此处只写入 store。

import { homedir } from "node:os";
import { parseArgv, type OptionValue } from "../../args.ts";
import { UsageError, reportCliError } from "../../errors.ts";
import { multi, openStore, parsePositiveInt, resolveDataDir, str } from "./common.ts";

const SPEC = {
  data: { type: "string", tilde: true },
  service: { type: "multi" },
  "max-concurrency": { type: "string" },
  "daily-requests": { type: "string" },
} as const;

const USAGE = `usage:
  ai-fly group add <name> [--service <serviceName>]... [--max-concurrency <n>] [--daily-requests <n>] [--data <dir>]
  ai-fly group set-services <name> [--service <serviceName>]... [--data <dir>]
  ai-fly group list [--data <dir>]`;

export async function run(argv: string[], ctx: { homedir?: string } = {}): Promise<number> {
  try {
    const home = ctx.homedir ?? homedir();
    const { options, positionals } = parseArgv(argv, SPEC, { homedir: home });
    const sub = positionals[0];
    if (sub === "add") return add(options, positionals, home);
    if (sub === "set-services") return setServices(options, positionals, home);
    if (sub === "list") return list(options, home);
    if (sub === undefined) throw new UsageError(USAGE);
    throw new UsageError(`error: unknown group subcommand '${sub}' (known: add, set-services, list)`);
  } catch (err) {
    return reportCliError(err);
  }
}

function add(options: Readonly<Record<string, OptionValue>>, positionals: readonly string[], home: string): number {
  const name = positionals[1];
  if (name === undefined) throw new UsageError("error: group add requires a <name> argument");
  const services = multi(options.service);
  const maxConcurrency = options["max-concurrency"] === undefined ? undefined : parsePositiveInt(str(options["max-concurrency"])!, "max-concurrency");
  const dailyRequests = options["daily-requests"] === undefined ? undefined : parsePositiveInt(str(options["daily-requests"])!, "daily-requests");
  const store = openStore(resolveDataDir(str(options.data), home));
  const group = store.addGroup(
    name,
    services,
    maxConcurrency === undefined && dailyRequests === undefined ? undefined : { maxConcurrency, dailyRequests },
  );
  const limits =
    group.limits === undefined
      ? "unlimited"
      : `maxConcurrency=${group.limits.maxConcurrency ?? "-"}, dailyRequests=${group.limits.dailyRequests ?? "-"}`;
  process.stdout.write(
    [
      `group added: ${group.name}`,
      `  services: ${services.length > 0 ? services.join(", ") : "(none yet)"}`,
      `  limits  : ${limits}`,
      "",
    ].join("\n"),
  );
  return 0;
}

function setServices(
  options: Readonly<Record<string, OptionValue>>,
  positionals: readonly string[],
  home: string,
): number {
  const name = positionals[1];
  if (name === undefined) throw new UsageError("error: group set-services requires a <name> argument");
  const services = multi(options.service);
  if (services.length === 0) {
    throw new UsageError("error: group set-services requires at least one --service <serviceName> (use the store API to empty a group)");
  }
  const store = openStore(resolveDataDir(str(options.data), home));
  const group = store.setGroupServices(name, services);
  const names = group.serviceIds.map((id) => store.getService(id)?.name ?? id).join(", ");
  process.stdout.write(`group updated: ${group.name}\n  services: ${names}\n`);
  return 0;
}

function list(options: Readonly<Record<string, OptionValue>>, home: string): number {
  const store = openStore(resolveDataDir(str(options.data), home));
  const groups = store.listGroups();
  if (groups.length === 0) {
    process.stdout.write("no groups configured (see: ai-fly group add)\n");
    return 0;
  }
  const serviceNames = new Map(store.listServices().map((s) => [s.serviceId, s.name]));
  const keys = store.listKeys();
  const lines: string[] = [];
  for (const g of groups) {
    const members = g.serviceIds.map((id) => serviceNames.get(id) ?? id).join(", ");
    const limits =
      g.limits === undefined
        ? "unlimited"
        : `maxConcurrency=${g.limits.maxConcurrency ?? "-"}, dailyRequests=${g.limits.dailyRequests ?? "-"}`;
    const activeKeys = keys.filter((k) => k.group === g.name && k.revokedAt === undefined).length;
    lines.push(`${g.name}  (services: ${members || "(none)"}; keys active: ${activeKeys}; limits: ${limits})`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
