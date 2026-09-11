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
import { loadCuratedPresets } from "../../../../presets/models-dev.ts";

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
  // cli-parity B1：路由参数（--route local=up[@forms] 前缀；--route-pattern
  // match=template 模式）+ --secret 糖 + --preset 预填
  route: { type: "multi" },
  "route-pattern": { type: "multi" },
  secret: { type: "string" },
  preset: { type: "string" },
  // service test 子命令
  form: { type: "string" },
  content: { type: "string" },
  model: { type: "string" },
  "local-prefix": { type: "string" },
} as const;

const USAGE = `usage:
  ai-fly service add <name> [--upstream <url> | --preset <id>] [--port <n>]
                      [--route <localPrefix>=<upPrefix>[@form1,form2]]... [--route-pattern <match>=<template>]...
                      [--secret <name>] [--match <exact|suffix|regex>:<value>]...
                      [--host <host>] [--strip <prefix>] [--append <prefix>]
                      [--header-set <name>=<value|$env:VAR|$secret:name>]... [--header-remove <name>]... [--data <dir>]
  ai-fly service list [--data <dir>]
  ai-fly service get <name> [--data <dir>]
  ai-fly service remove <name> [--data <dir>]
  ai-fly service test <name> [--form openai-chat|openai-responses|anthropic] [--content <text>]
                       [--model <id>] [--local-prefix /v1] [--data <dir>]`

export async function run(argv: string[], ctx: { homedir?: string } = {}): Promise<number> {
  try {
    const home = ctx.homedir ?? homedir();
    const { options, positionals } = parseArgv(argv, SPEC, { homedir: home });
    const sub = positionals[0];
    if (sub === "add") return add(options, positionals, home);
    if (sub === "list") return list(options, home);
    if (sub === "get") return get(options, positionals, home);
    if (sub === "remove") return remove(options, positionals, home);
    if (sub === "test") return await test(options, positionals, home);
    if (sub === undefined) throw new UsageError(USAGE);
    throw new UsageError(`error: unknown service subcommand '${sub}' (known: add, list, get, remove, test)`);
  } catch (err) {
    return reportCliError(err);
  }
}

function add(options: Readonly<Record<string, OptionValue>>, positionals: readonly string[], home: string): number {
  const name = positionals[1];
  if (name === undefined) throw new UsageError("error: service add requires a <name> argument");
  // --preset 预填：upstream/match/routes/defaultPort 缺省项由此而来（显式旗标优先）
  const preset =
    options.preset === undefined
      ? undefined
      : loadCuratedPresets().find((candidate) => candidate.id === str(options.preset));
  if (options.preset !== undefined && preset === undefined) {
    throw new UsageError(`error: unknown preset '${str(options.preset)}' (see: ai-fly presets)`);
  }
  const upstream = str(options.upstream) ?? preset?.baseUrl;
  if (upstream === undefined) throw new UsageError("error: service add requires --upstream <url> (or --preset <id>)");
  const matchSpecs =
    options.match !== undefined
      ? multi(options.match).map(parseMatchSpec)
      : (preset?.matchDomains ?? []).map((domain) => ({ type: "suffix" as const, value: domain }));
  if (matchSpecs.length === 0) {
    throw new UsageError("error: service add requires at least one --match (or --preset carrying match domains)");
  }
  const routes = [
    ...multi(options.route).map(parseRouteSpec),
    ...multi(options["route-pattern"]).map(parseRoutePatternSpec),
    ...(preset !== undefined && options.route === undefined && options["route-pattern"] === undefined
      ? (preset.routes ?? [])
      : []),
  ];
  const headerSetSpecs = multi(options["header-set"]).map(parseHeaderSetSpec);
  if (options.secret !== undefined) {
    headerSetSpecs.push({ name: "authorization", value: `\$secret:${str(options.secret)}` });
  }
  const dataDir = resolveDataDir(str(options.data), home);
  const store = openStore(dataDir);
  const service = store.addService({
    name,
    upstream,
    match: matchSpecs,
    ...(routes.length > 0 ? { routes } : {}),
    defaultPort:
      options.port === undefined
        ? preset?.defaultPort
        : parsePortNumber(str(options.port)!, "port"),
    rewrite: buildRewrite({
      host: str(options.host),
      strip: str(options.strip),
      append: str(options.append),
      headerSet: headerSetSpecs,
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
      ...(service.routes !== undefined && service.routes.length > 0
        ? [`  routes     : ${service.routes.map(routeSummary).join(" | ")}`]
        : []),
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

// ── cli-parity B1：路由参数解析 ────────────────────────────────────────────

/** forms 合法集（与契约 ROUTE_FORM 一致的名词法）。 */
const ROUTE_FORMS = ["openai-chat", "openai-responses", "anthropic"] as const;
type RouteFormLiteral = (typeof ROUTE_FORMS)[number];

function routeSummary(route: { mode?: "pattern" | "prefix" | undefined; localPrefix?: string | undefined; upstreamPrefix?: string | undefined; matchPattern?: string | undefined; template?: string | undefined }): string {
  if (route.mode === "pattern") return `${route.matchPattern} => ${route.template}`;
  return `${route.localPrefix}=${route.upstreamPrefix}`;
}

/** --route <localPrefix>=<upPrefix>[@form1,form2]；forms 缺省按前缀语义
 *  （含 anthropic → [anthropic]，否则 openai 家族两条）。 */
function parseRouteSpec(raw: string): {
  forms: RouteFormLiteral[];
  localPrefix: string;
  upstreamPrefix: string;
} {
  const atForms = raw.split("@");
  const body = atForms[0]!;
  const eq = body.indexOf("=");
  if (eq <= 0 || eq === body.length - 1) {
    throw new UsageError(`error: --route expects <localPrefix>=<upstreamPrefix>[@forms] (got '${raw}')`);
  }
  const localPrefix = normalizePrefix(body.slice(0, eq), raw);
  const upstreamPrefix = normalizePrefix(body.slice(eq + 1), raw);
  let forms: RouteFormLiteral[];
  if (atForms.length > 1) {
    forms = atForms.slice(1).join("@").split(",").map((form) => {
      if (!ROUTE_FORMS.includes(form as RouteFormLiteral)) {
        throw new UsageError(`error: unknown route form '${form}' (known: ${ROUTE_FORMS.join(", ")})`);
      }
      return form as RouteFormLiteral;
    });
  } else {
    forms = localPrefix.includes("anthropic") ? ["anthropic"] : ["openai-chat", "openai-responses"];
  }
  return { forms, localPrefix, upstreamPrefix };
}

function normalizePrefix(prefix: string, raw: string): string {
  const trimmed = prefix.trim();
  if (trimmed === "") return "/";
  if (!trimmed.startsWith("/")) {
    throw new UsageError(`error: route prefixes must start with '/' (got '${raw}')`);
  }
  return trimmed.replace(/\/+$/, "") || "/";
}

/** --route-pattern <match>=<template>（= 只切第一处——模板含 = 也不误伤）。 */
function parseRoutePatternSpec(raw: string): {
  forms: RouteFormLiteral[];
  mode: "pattern";
  matchPattern: string;
  template: string;
} {
  const eq = raw.indexOf("=");
  if (eq <= 0 || eq === raw.length - 1) {
    throw new UsageError(`error: --route-pattern expects <match>=<template> (got '${raw}')`);
  }
  const matchPattern = raw.slice(0, eq).trim();
  const template = raw.slice(eq + 1).trim();
  if (!matchPattern.startsWith("/")) {
    throw new UsageError(`error: route match must start with '/' (got '${raw}')`);
  }
  return {
    forms: ["openai-chat", "openai-responses"],
    mode: "pattern",
    matchPattern,
    template,
  };
}

function get(options: Readonly<Record<string, OptionValue>>, positionals: readonly string[], home: string): number {
  const name = positionals[1];
  if (name === undefined) throw new UsageError("error: service get requires a <name> argument");
  const store = openStore(resolveDataDir(str(options.data), home));
  const service = store.getServiceByName(name);
  if (service === undefined) throw new UsageError(`error: service '${name}' not found`);
  const lines = [
    `${service.name}  [${service.serviceId}]`,
    `  upstream   : ${service.upstream}`,
    `  defaultPort: ${service.defaultPort}`,
    `  match      : ${service.match.map((m) => `${m.type}:${m.value}`).join(", ")}`,
  ];
  if (service.routes !== undefined && service.routes.length > 0) {
    lines.push(`  routes     : ${service.routes.map(routeSummary).join(" | ")}`);
  }
  if (service.rewrite !== undefined) {
    const rewrite: string[] = [];
    if (service.rewrite.hostHeader !== undefined) rewrite.push(`host: ${service.rewrite.hostHeader}`);
    if (service.rewrite.pathPrefixStrip !== undefined) rewrite.push(`strip: ${service.rewrite.pathPrefixStrip}`);
    if (service.rewrite.pathPrefixAppend !== undefined) rewrite.push(`append: ${service.rewrite.pathPrefixAppend}`);
    for (const [headerName, value] of Object.entries(service.rewrite.headerSet ?? {})) {
      rewrite.push(`header ${headerName}: ${value}`);
    }
    for (const headerName of service.rewrite.headerRemove ?? []) {
      rewrite.push(`remove header ${headerName}`);
    }
    if (rewrite.length > 0) lines.push(`  rewrite    : ${rewrite.join(" | ")}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

/** service test：与 GUI 行内 test 同引擎（路由命中 + rewrite 注入 + 直打上游）。 */
async function test(options: Readonly<Record<string, OptionValue>>, positionals: readonly string[], home: string): Promise<number> {
  const name = positionals[1];
  if (name === undefined) throw new UsageError("error: service test requires a <name> argument");
  const formRaw = options.form === undefined ? "openai-chat" : str(options.form)!;
  if (!ROUTE_FORMS.includes(formRaw as RouteFormLiteral)) {
    throw new UsageError(`error: --form must be one of ${ROUTE_FORMS.join(", ")}`);
  }
  const dataDir = resolveDataDir(str(options.data), home);
  const store = openStore(dataDir);
  const service = store.getServiceByName(name);
  if (service === undefined) throw new UsageError(`error: service '${name}' not found`);
  const { testServiceRoute } = await import("../../../provider/route-test.ts");
  const { SecretsStore } = await import("../../../provider/secrets.ts");
  const secretsStore = SecretsStore.open(dataDir);
  const result = await testServiceRoute({
    service,
    form: formRaw as RouteFormLiteral,
    ...(options["local-prefix"] !== undefined ? { localPrefix: str(options["local-prefix"])! } : {}),
    ...(options.model !== undefined ? { model: str(options.model)! } : {}),
    ...(options.content !== undefined ? { content: str(options.content)! } : {}),
    secrets: (secretName: string) => secretsStore.resolve(secretName)?.headerValue,
  });
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  out(`${result.ok ? "ok" : "failed"}${result.httpStatus !== undefined ? ` (HTTP ${result.httpStatus})` : ""} - ${result.latencyMs}ms`);
  out(`POST ${result.request.url}`);
  if (result.error !== undefined) out(`error: ${result.error}`);
  if (result.bodyExcerpt !== undefined) out(result.bodyExcerpt.slice(0, 1200));
  return result.ok ? 0 : 1;
}
