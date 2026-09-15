// `ai-fly service <add|list|remove>`：服务管理（match 展示集 / upstream /
// rewrite / 生命周期四槽 / defaultPort）。defaultPort 规则（上游端口 <1024 必须
// 显式 --port）由 store 校验。
// hooks-lifecycle 6.1（正式 v2 旗标面）：--secret → auth.secret；--auth-script/
// --auth-literal/--no-bearer 补齐 auth 三族 + bearer 开关；--header-set（值仅
// 字面量与 $env:/$secret: 引用）/--header-remove/--headers-script → headers 槽；
// --request-script/--response-script → ③④ 槽；--hooks 为预设模式整段绑定
// （rust-fetch-sidecar 恢复：与逐槽旗标互斥，脚本须导出至少一个阶段函数）。
// get/list humanize 按四阶段输出（CLI 面向 owner 本机——显示引用形态而非值）；
// legacy（pre-v2）存储态列失效服务名 + 移除路径提示。

import { homedir } from "node:os";
import { parseArgv, type OptionValue } from "../../args.ts";
import { UsageError, reportCliError } from "../../errors.ts";
import {
  buildHeadersSlot,
  buildRewrite,
  multi,
  openStore,
  parseHeaderSetSpec,
  parseMatchSpec,
  parsePortNumber,
  resolveDataDir,
  str,
} from "./common.ts";
import type { AuthSlot, ServiceConfig } from "../../../provider/store.ts";
import { scriptHasStageExports } from "../../../provider/hook.ts";
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
  // ② headers 槽整段脚本绑定（onRequestHeaders 导出）。
  "headers-script": { type: "string" },
  // ① auth 槽三族旗标（互斥：secret | script | literal）+ bearer 开关。
  secret: { type: "string" },
  "auth-script": { type: "string" },
  "auth-literal": { type: "string" },
  "no-bearer": { type: "boolean" },
  // ③④ 槽脚本绑定（onRequest / onResponse 导出）。
  "request-script": { type: "string" },
  "response-script": { type: "string" },
  // 预设模式整段绑定（rust-fetch-sidecar：脚本自带阶段导出；与逐槽旗标互斥）。
  hooks: { type: "string" },
  // cli-parity B1：路由参数（--route local=up[@forms] 前缀；--route-pattern
  // match=template 模式）+ --preset 预填
  route: { type: "multi" },
  "route-pattern": { type: "multi" },
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
                      [--secret <name> | --auth-script <name> | --auth-literal <v>] [--no-bearer]
                      [--match <exact|suffix|regex>:<value>]...
                      [--host <host>] [--strip <prefix>] [--append <prefix>]
                      [--header-set <name>=<value|$env:VAR|$secret:name>]... [--header-remove <name>]...
                      [--headers-script <name>] [--request-script <name>] [--response-script <name>]
                      [--hooks <name>] [--data <dir>]
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
    if (sub === "stop") return setRunning(options, positionals, home, false);
    if (sub === "start") return setRunning(options, positionals, home, true);
    if (sub === "test") return await test(options, positionals, home);
    if (sub === undefined) throw new UsageError(USAGE);
    throw new UsageError(`error: unknown service subcommand '${sub}' (known: add, list, get, remove, stop, start, test)`);
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
  // 预设模式整段绑定（rust-fetch-sidecar）：--hooks > preset.hooks；与逐槽旗标
  // 互斥（CLI 侧先拒，store 侧兜底）；脚本必须导出至少一个阶段函数。
  const slotFlags = [
    ["--secret", options.secret],
    ["--auth-script", options["auth-script"]],
    ["--auth-literal", options["auth-literal"]],
    ["--headers-script", options["headers-script"]],
    ["--request-script", options["request-script"]],
    ["--response-script", options["response-script"]],
  ] as const;
  const slotFlagsDeclared =
    slotFlags.some(([, v]) => v !== undefined) ||
    options["header-set"] !== undefined ||
    options["header-remove"] !== undefined;
  // preset 的预设模式仅在用户未显式给任何逐槽配置时生效（显式旗标胜 preset
  // ——沿用 CLI 惯例：codex 预设 + --secret = 切回自定义模式）。
  const hooksName = str(options.hooks) ?? (preset?.hooks !== undefined && !slotFlagsDeclared ? preset.hooks.script : undefined);
  if (hooksName !== undefined) {
    const clash = slotFlags.filter(([, v]) => v !== undefined).map(([f]) => f);
    const headerDeclared =
      options["header-set"] !== undefined || options["header-remove"] !== undefined;
    if (clash.length > 0 || headerDeclared) {
      throw new UsageError(
        `error: --hooks (preset mode) is mutually exclusive with per-stage flags: ${[...clash, ...(headerDeclared ? ["--header-set/--header-remove"] : [])].join(", ")}`,
      );
    }
    if (!scriptHasStageExports(hooksName, { home })) {
      throw new UsageError(
        `error: hook script '${hooksName}' exports no lifecycle stage function (see: ai-fly hooks list)`,
      );
    }
  }
  // ① auth 槽组装：显式旗标（三族互斥）> preset.auth（v2 直吐）> preset.keyEnv
  //  的 $env 引用兜底；--no-bearer 关 Bearer 前缀（显式旗标胜 preset 内开关）。
  const authSources = [
    ["--secret", options.secret],
    ["--auth-script", options["auth-script"]],
    ["--auth-literal", options["auth-literal"]],
  ] as const;
  const declared = authSources.filter(([, v]) => v !== undefined);
  if (declared.length > 1) {
    throw new UsageError(
      `error: ${declared.map(([f]) => f).join(", ")} are mutually exclusive (pick one auth source)`,
    );
  }
  let auth: AuthSlot | undefined;
  if (options.secret !== undefined) {
    auth = { secret: str(options.secret)! };
  } else if (options["auth-script"] !== undefined) {
    auth = { script: str(options["auth-script"])! };
  } else if (options["auth-literal"] !== undefined) {
    auth = { literal: str(options["auth-literal"])! };
  } else if (preset?.auth !== undefined) {
    auth = { ...preset.auth };
  } else if (preset?.keyEnv !== undefined) {
    auth = { literal: `$env:${preset.keyEnv}` };
  }
  if (options["no-bearer"] === true) {
    if (auth === undefined) {
      throw new UsageError(
        "error: --no-bearer requires an auth source (--secret, --auth-script, --auth-literal, or a preset carrying auth)",
      );
    }
    auth = { ...auth, bearer: false };
  }
  // ② headers 槽：set/remove 声明 + 整段脚本绑定。
  const headers = buildHeadersSlot({
    headerSet: headerSetSpecs,
    headerRemove: multi(options["header-remove"]).map((n) => n.toLowerCase()),
    ...(options["headers-script"] !== undefined
      ? { headersScript: str(options["headers-script"])! }
      : {}),
  });
  const dataDir = resolveDataDir(str(options.data), home);
  const store = openStore(dataDir, home); // home 同步传入（复核 R2-P1-B：与 preflight 同基准）
  const service = store.addService({
    name,
    upstream,
    match: matchSpecs,
    ...(routes.length > 0 ? { routes } : {}),
    defaultPort:
      options.port === undefined
        ? preset?.defaultPort
        : parsePortNumber(str(options.port)!, "port"),
    ...(auth !== undefined ? { auth } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(options["request-script"] !== undefined
      ? { request: { script: str(options["request-script"])! } }
      : {}),
    ...(options["response-script"] !== undefined
      ? { response: { script: str(options["response-script"])! } }
      : {}),
    ...(hooksName !== undefined ? { hooks: { script: hooksName } } : {}),
    rewrite: buildRewrite({
      host: str(options.host),
      strip: str(options.strip),
      append: str(options.append),
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
      ...(service.hooks !== undefined ? [`  hooks      : ${service.hooks.script} (preset mode)`] : []),
      "",
    ].join("\n"),
  );
  return 0;
}

function list(options: Readonly<Record<string, OptionValue>>, home: string): number {
  const store = openStore(resolveDataDir(str(options.data), home), home);
  // legacy（pre-v2）存储态：失效服务名清单 + 移除路径提示（hooks-lifecycle 2.3/6.1）。
  const legacy = store.legacy;
  if (legacy !== null) {
    const out = (line: string): void => {
      process.stdout.write(`${line}\n`);
    };
    out("services.json uses a legacy (pre-v2) format - all services are inactive");
    for (const name of legacy.serviceNames) out(`  ${name}  [legacy]`);
    out("remove the stale entries one by one to rebuild a clean v2 store: ai-fly service remove <name>");
    return 0;
  }
  const services = store.listServices();
  if (services.length === 0) {
    process.stdout.write("no services configured (see: ai-fly service add)\n");
    return 0;
  }
  const lines: string[] = [];
  for (const s of services) {
    lines.push(`${s.name}  [${s.serviceId}]${s.enabled === false ? "  (stopped)" : ""}`);
    lines.push(`  upstream   : ${s.upstream}`);
    lines.push(`  defaultPort: ${s.defaultPort}`);
    lines.push(`  match      : ${s.match.map((m) => `${m.type}:${m.value}`).join(", ")}`);
    const summary = lifecycleSummary(s);
    if (summary !== undefined) lines.push(`  lifecycle  : ${summary}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

function remove(options: Readonly<Record<string, OptionValue>>, positionals: readonly string[], home: string): number {
  const name = positionals[1];
  if (name === undefined) throw new UsageError("error: service remove requires a <name> argument");
  const store = openStore(resolveDataDir(str(options.data), home), home);
  store.removeService(name);
  process.stdout.write(`service removed: ${name}\n`);
  return 0;
}

/** 停用/启用（service-lifecycle）：按名称定位；daemon 在跑经 services.json watcher 热传导。 */
function setRunning(options: Readonly<Record<string, OptionValue>>, positionals: readonly string[], home: string, running: boolean): number {
  const name = positionals[1];
  if (name === undefined) throw new UsageError(`error: service ${running ? "start" : "stop"} requires a <name> argument`);
  const store = openStore(resolveDataDir(str(options.data), home), home);
  const svc = store.getServiceByName(name);
  if (svc === undefined) throw new UsageError(`error: unknown service '${name}'`);
  const { changed } = store.setServiceEnabled(svc.serviceId, running);
  process.stdout.write(
    changed
      ? `service ${running ? "started" : "stopped"}: ${name} (${running ? "exposed to consumers" : "removed from catalog; requests get 404"})\n`
      : `service '${name}' is already ${running ? "running" : "stopped"}\n`,
  );
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
  const store = openStore(resolveDataDir(str(options.data), home), home);
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
    if (service.rewrite.host !== undefined) rewrite.push(`host: ${service.rewrite.host}`);
    if (service.rewrite.pathPrefixStrip !== undefined) rewrite.push(`strip: ${service.rewrite.pathPrefixStrip}`);
    if (service.rewrite.pathPrefixAppend !== undefined) rewrite.push(`append: ${service.rewrite.pathPrefixAppend}`);
    if (rewrite.length > 0) lines.push(`  rewrite    : ${rewrite.join(" | ")}`);
  }
  // 生命周期四槽 humanize（6.1）：按管线阶段输出——auth 三族 + bearer 开关、
  // headers remove/set/script、request/response 脚本绑定。CLI 面向 owner 本机，
  // 显示引用形态而非值本身（与 v1 风格一致；脱敏投影归 wire/detail 面）。
  if (service.auth !== undefined) {
    const a = service.auth;
    const source =
      "secret" in a ? `secret ${a.secret}` : "script" in a ? `script ${a.script}` : `literal ${a.literal}`;
    const bearer = "bearer" in a && a.bearer === false ? " (bearer off)" : "";
    lines.push(`  auth       : ${source}${bearer}`);
  }
  if (service.headers !== undefined) {
    const parts: string[] = [];
    const setEntries = Object.entries(service.headers.set ?? {});
    if (setEntries.length > 0) parts.push(`set ${setEntries.map(([n, v]) => `${n}=${v}`).join(", ")}`);
    if ((service.headers.remove ?? []).length > 0) parts.push(`remove ${(service.headers.remove ?? []).join(", ")}`);
    if (service.headers.script !== undefined) parts.push(`script ${service.headers.script.name}`);
    lines.push(`  headers    : ${parts.join(" | ")}`);
  }
  if (service.request !== undefined) lines.push(`  request    : script ${service.request.script}`);
  if (service.response !== undefined) lines.push(`  response   : script ${service.response.script}`);
  if (service.hooks !== undefined) lines.push(`  hooks      : ${service.hooks.script} (preset mode)`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

/** list 行的生命周期紧凑摘要（四槽有任一存在才输出）。 */
function lifecycleSummary(service: ServiceConfig): string | undefined {
  const segments: string[] = [];
  if (service.auth !== undefined) {
    const a = service.auth;
    const kind = "secret" in a ? `secret ${a.secret}` : "script" in a ? `script ${a.script}` : `literal ${a.literal}`;
    segments.push(`auth:${kind}${"bearer" in a && a.bearer === false ? " (bearer off)" : ""}`);
  }
  if (service.headers !== undefined) {
    const h = service.headers;
    const parts: string[] = [];
    if (Object.keys(h.set ?? {}).length > 0) parts.push(`set(${Object.keys(h.set!).length})`);
    if ((h.remove ?? []).length > 0) parts.push(`remove(${(h.remove ?? []).length})`);
    if (h.script !== undefined) parts.push(`script:${h.script.name}`);
    if (parts.length > 0) segments.push(`headers:${parts.join(",")}`);
  }
  if (service.request !== undefined) segments.push(`request:script ${service.request.script}`);
  if (service.response !== undefined) segments.push(`response:script ${service.response.script}`);
  if (service.hooks !== undefined) segments.push(`hooks(preset):${service.hooks.script}`);
  return segments.length === 0 ? undefined : segments.join("; ");
}

/** service test：与 GUI 行内 test 同引擎（路由命中 + rewrite 注入 + 直打上游）。 */
async function test(options: Readonly<Record<string, OptionValue>>, positionals: readonly string[], home: string): Promise<number> {
  const name = positionals[1];
  if (name === undefined) throw new UsageError("error: service test requires a <name> argument");
  const dataDir = resolveDataDir(str(options.data), home);
  const store = openStore(dataDir, home);
  const service = store.getServiceByName(name);
  if (service === undefined) throw new UsageError(`error: service '${name}' not found`);
  // 缺省 form：命中路由（--local-prefix 或唯一路由）的首个形态——codex 等
  // responses-only 服务的 test 不必手写 --form
  let formRaw: string;
  if (options.form !== undefined) {
    formRaw = str(options.form)!;
  } else {
    const localPrefix = options["local-prefix"] !== undefined ? str(options["local-prefix"]) : undefined;
    const routes = (service.routes ?? []).filter((r) => r.mode !== "pattern");
    const hit =
      localPrefix !== undefined
        ? routes.find((r) => r.localPrefix === localPrefix)
        : routes.length === 1
          ? routes[0]
          : undefined;
    formRaw = hit?.forms[0] ?? "openai-chat";
  }
  if (!ROUTE_FORMS.includes(formRaw as RouteFormLiteral)) {
    throw new UsageError(`error: --form must be one of ${ROUTE_FORMS.join(", ")}`);
  }
  const { testServiceRoute } = await import("../../../provider/route-test.ts");
  const { SecretsStore } = await import("../../../provider/secrets.ts");
  const secretsStore = SecretsStore.open(dataDir);
  const hitLocalPrefix =
    options["local-prefix"] !== undefined
      ? str(options["local-prefix"])!
      : (() => {
          // 缺省 form 的路由命中也提供缺省 localPrefix（responses-only 服务零参数可测）
          const routes = (service.routes ?? []).filter((r) => r.mode !== "pattern");
          return routes.length === 1 ? routes[0]!.localPrefix : undefined;
        })();
  const result = await testServiceRoute({
    service,
    form: formRaw as RouteFormLiteral,
    ...(hitLocalPrefix !== undefined ? { localPrefix: hitLocalPrefix } : {}),
    ...(options.model !== undefined ? { model: str(options.model)! } : {}),
    ...(options.content !== undefined ? { content: str(options.content)! } : {}),
    // 密钥原样值（hooks-lifecycle 5.2：Bearer 前缀由 auth 槽在头链内拼）。
    secrets: (secretName: string) => secretsStore.get(secretName),
    // home 贯穿（复核 R2-P1-B）：行内 test 与网关转发同一脚本库基准。
    home,
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
