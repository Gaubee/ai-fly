// `ai-fly hooks list|get|add|remove|run`：hooks 脚本资源域（与 group/secret 同构；
// cli-hook 管理面）。脚本 = 可枚举资产：内建库（随包）+ 用户库 ~/.aifly/hooks/
// （同名覆盖内建）。阶段矩阵（hooks-lifecycle 6.1）：脚本按四阶段导出名归类
// （onRequestBearerAuthentication/onRequestHeaders/onRequest/onResponse）；旧导出名
// （如 v1 authHeader）不在矩阵内——显示为无阶段导出并提示重写。
// run 按阶段语义调对应阶段函数：① 三态取值（string/Promise/AsyncIterable 订阅），
// ② 输出 {set?, remove?} 对象；③④ 以合成请求/响应 ctx 冒烟调用并呈现返回形状。
// ① 不回显原值（凭据法则：只报长度与首尾掩码）。

import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { parseArgv } from "../../args.ts";
import { UsageError, reportCliError } from "../../errors.ts";
import {
  discoverHooks,
  disposeHookSubscriptions,
  HookMissingError,
  HookStageError,
  installUserHook,
  loadHookScript,
  readHookScript,
  removeUserHook,
  resolveHookValue,
  resolveStageHeaders,
  resolveStageRequest,
  resolveStageResponse,
  stageFnsOf,
  STAGE_FN_NAMES,
} from "../../../provider/hook.ts";
import type { StageFnName } from "../../../provider/hook.ts";
import { SecretsStore } from "../../../provider/secrets.ts";
import { resolveDataDir, str } from "./common.ts";

const SPEC = {
  data: { type: "string", tilde: true },
  file: { type: "string", tilde: true },
  stdin: { type: "boolean" },
  "arg": { type: "multi" },
  bearer: { type: "boolean" },
  stage: { type: "string" },
  // ②③④ 冒烟调用的合成请求面（缺省 GET / 空 body；③ 的 url 缺省 localhost）。
  method: { type: "string" },
  path: { type: "string" },
  url: { type: "string" },
  body: { type: "string" },
} as const;

const USAGE = `usage:
  ai-fly hooks list
  ai-fly hooks get <name>
  ai-fly hooks add <name> [--file <path> | --stdin]
  ai-fly hooks remove <name>
  ai-fly hooks run <name> --stage <onRequestBearerAuthentication|onRequestHeaders|onRequest|onResponse>
                     [--arg k=v]... [--bearer]
                     [--method GET] [--path /] [--url http://localhost/] [--body <text>]
hooks 脚本：内建库 + ~/.aifly/hooks/<name>.cjs（用户覆盖内建）；
阶段导出名 = 钩子清单（按 onRequestBearerAuthentication / onRequestHeaders /
onRequest / onResponse 四阶段归类；旧导出名如 authHeader 需按新契约重写）。`;

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
  if (positionals.length > 1) {
    throw new UsageError(`error: unexpected argument '${positionals[1]}'`);
  }
  return { options, positionals };
}

/** 阶段矩阵的展示形：无阶段导出的脚本给重写提示（v1 authHeader 等旧名）。 */
function stagesDisplay(stages: readonly StageFnName[]): string {
  return stages.length > 0 ? stages.join(", ") : "(no stage exports - rewrite to stage names)";
}

function list(rest: readonly string[], home: string): number {
  parse(rest, home);
  const scripts = discoverHooks(home);
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  out(`hooks scripts (${scripts.length})`);
  for (const s of scripts) {
    out(`  ${s.name.padEnd(16)} [${s.source}]  ${stagesDisplay(s.stages)}`);
  }
  if (scripts.length > 0) {
    out(`stages: ${STAGE_FN_NAMES.join(" | ")}`);
    out(`use: ai-fly service add <name> --auth-script <n> | --headers-script <n> | --request-script <n> | --response-script <n>`);
    out(`      ai-fly hooks run <name> --stage <stage>`);
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
  const mod = loadHookScript(name, home);
  process.stdout.write(`hooks script '${name}' [${found.source}]\n  path: ${found.path}\n`);
  process.stdout.write(`  stages: ${mod !== undefined ? stagesDisplay(stageFnsOf(mod)) : "(unknown)"}\n`);
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
    `hooks script installed: ${installed.name}\n  path  : ${installed.path}\n  stages: ${stagesDisplay(installed.stages)}\n  fns   : ${installed.fns.join(", ")}\n`,
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

/** 凭据法则：不回显原值——只报长度与首尾掩码（① 阶段专用）。 */
function maskValue(value: string): string {
  return value.length <= 6
    ? "*".repeat(value.length)
    : `${value.slice(0, 2)}${"*".repeat(Math.min(value.length - 4, 12))}${value.slice(-2)} (len ${value.length})`;
}

/** 消费一个 body 流并计字节（③④ 返回体冒烟呈现；不回显内容）。 */
async function countBodyBytes(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>): Promise<number> {
  let bytes = 0;
  for await (const chunk of body) bytes += chunk.byteLength;
  return bytes;
}

async function runHook(rest: readonly string[], home: string): Promise<number> {
  const { options, positionals } = parse(rest, home);
  const name = positionals[0];
  if (name === undefined) {
    throw new UsageError(`error: hooks run requires <name> --stage <stage> (known stages: ${STAGE_FN_NAMES.join(", ")})`);
  }
  const stageRaw = str(options.stage);
  if (stageRaw === undefined) {
    throw new UsageError(`error: hooks run requires --stage <${STAGE_FN_NAMES.join("|")}>`);
  }
  if (!(STAGE_FN_NAMES as readonly string[]).includes(stageRaw)) {
    throw new UsageError(`error: unknown stage '${stageRaw}' (known: ${STAGE_FN_NAMES.join(", ")})`);
  }
  const stage = stageRaw as StageFnName;
  const args: Record<string, string> = {};
  for (const raw of (options.arg as string[] | undefined) ?? []) {
    const idx = raw.indexOf("=");
    if (idx <= 0) throw new UsageError(`error: --arg expects k=v (got '${raw}')`);
    args[raw.slice(0, idx)] = raw.slice(idx + 1);
  }
  // secrets 访问器接 provider 密钥库（--data 可指定数据目录）
  const store = SecretsStore.open(resolveDataDir(str(options.data), home));
  const base = { home, secrets: (n: string) => store.resolve(n)?.headerValue };
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  try {
    if (stage === "onRequestBearerAuthentication") {
      // ① 三态取值（string/Promise/AsyncIterable 订阅共用解析面）；不回显原值。
      let value: string | undefined;
      try {
        value = await resolveHookValue(stage, { script: name, home, args, secrets: base.secrets });
      } catch (err) {
        if (err instanceof HookMissingError) {
          process.stderr.write(`error: hook '${name}.${stage}' did not yield a value (script/stage export missing, args invalid, or credential absent)\n`);
          return 1;
        }
        throw err;
      }
      if (value === undefined) {
        process.stderr.write(`error: hook '${name}.${stage}' did not yield a value\n`);
        return 1;
      }
      if (options.bearer === true) value = `Bearer ${value}`;
      out(`ok: ${name}.${stage} -> ${maskValue(value)}`);
      return 0;
    }
    const method = str(options.method) ?? "GET";
    const path = str(options.path) ?? "/";
    if (stage === "onRequestHeaders") {
      // ② 对象返回：{set?, remove?}
      const result = await resolveStageHeaders({ name, args }, { method, path, headers: {} }, base);
      out(`ok: ${name}.${stage} -> ${JSON.stringify(result)}`);
      return 0;
    }
    if (stage === "onRequest") {
      // ③ 合成请求 ctx（url/method/body 可覆写）；呈现 status/headers/body 字节数。
      const url = str(options.url) ?? "http://localhost/";
      const bodyText = str(options.body) ?? "";
      const result = await resolveStageRequest(
        { name, args },
        { url, method, headers: {}, body: new TextEncoder().encode(bodyText), signal: AbortSignal.timeout(60_000) },
        base,
      );
      const bytes = result.body !== undefined ? await countBodyBytes(result.body) : 0;
      out(`ok: ${name}.${stage} -> status ${result.status}, headers ${JSON.stringify(result.headers)}, body ${bytes} bytes`);
      return 0;
    }
    // ④ onResponse：合成响应 ctx（status 200 空 body）；呈现局部覆盖形状。
    const bodyText = str(options.body) ?? "";
    const result = await resolveStageResponse(
      { name, args },
      {
        status: 200,
        headers: {},
        body: (async function* (): AsyncGenerator<Uint8Array> {
          if (bodyText !== "") yield new TextEncoder().encode(bodyText);
        })(),
        signal: AbortSignal.timeout(60_000),
      },
      base,
    );
    const parts: string[] = [];
    if (result.status !== undefined) parts.push(`status ${result.status}`);
    if (result.headers !== undefined) parts.push(`headers ${JSON.stringify(result.headers)}`);
    if (result.body !== undefined) parts.push(`body ${await countBodyBytes(result.body)} bytes`);
    out(`ok: ${name}.${stage} -> ${parts.length > 0 ? parts.join(", ") : "(no-op)"}`);
    return 0;
  } catch (err) {
    if (err instanceof HookStageError) {
      process.stderr.write(`error: hook '${name}.${stage}' failed (stage export missing, threw, or invalid return shape)\n`);
      return 1;
    }
    throw err;
  } finally {
    // 订阅模式后台迭代器回收（await：CLI 一次性进程干净退出）
    await disposeHookSubscriptions();
  }
}
