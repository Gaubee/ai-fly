// `ai-fly test`（cli-parity B4）：消费侧经本机网关的单轮 AI 请求——GUI
// connect ③ test 的 CLI 面。命中的是运行中的网关端口（`ai-fly run`）；
// 网关未起则连接拒绝，报错明示先起 run。正交意图：参数与呈现；请求构造
// 与结果归纳复用 consumer/local-test（与 GUI 同引擎）。

import { homedir } from "node:os";
import { parseArgv } from "../../args.ts";
import { UsageError, reportCliError } from "../../errors.ts";
import { consumersRoot, listKeyrings } from "../../../consumer/store.ts";
import { desiredPortFor } from "../../../consumer/ports.ts";
import { testLocalService } from "../../../consumer/local-test.ts";
import { ROUTE_LOCAL_PREFIX, type RouteForm } from "../../../shared/rpc-contract.ts";

const SPEC = {
  data: { type: "string", tilde: true },
  service: { type: "string" },
  form: { type: "string" },
  content: { type: "string" },
  model: { type: "string" },
  "local-prefix": { type: "string" },
} as const;

const FORMS: readonly RouteForm[] = ["openai-chat", "openai-responses", "anthropic"];

const USAGE = `usage:
  ai-fly test [--data <dir>] [--service <name>] [--form openai-chat|openai-responses|anthropic]
              [--content <text>] [--model <id>] [--local-prefix /v1]
(the consumer gateway must be running: 'ai-fly run')`;

export async function run(argv: string[], ctx: { homedir?: string } = {}): Promise<number> {
  try {
    const home = ctx.homedir ?? homedir();
    const { options, positionals } = parseArgv(argv, SPEC, { homedir: home });
    if (positionals.length > 0) {
      throw new UsageError(`error: unexpected argument '${positionals[0]}'`);
    }
    const formRaw = options.form === undefined ? "openai-chat" : String(options.form);
    if (!FORMS.includes(formRaw as RouteForm)) {
      throw new UsageError(`error: --form must be one of ${FORMS.join(", ")}`);
    }
    const form = formRaw as RouteForm;

    const root = consumersRoot(options.data === undefined ? undefined : String(options.data), home);
    const { rings } = listKeyrings(root);
    const flat = rings.flatMap((ring) =>
      ring.services.map((svc) => ({ ring, svc })),
    );
    if (flat.length === 0) {
      throw new UsageError("error: no imported services - 'ai-fly import <link>' first");
    }
    const serviceName = options.service === undefined ? undefined : String(options.service);
    const target =
      serviceName === undefined
        ? flat[0]
        : flat.find(({ svc }) => svc.name === serviceName || svc.serviceId === serviceName);
    if (target === undefined) {
      throw new UsageError(`error: service '${serviceName}' not found (imported: ${flat.map((f) => f.svc.name).join(", ")})`);
    }
    // 网关实际端口优先（自动错开回写 actualPorts），其次 pin（ring.ports），最后 defaultPort
    const port = target.ring.actualPorts[target.svc.serviceId] ?? desiredPortFor(target.svc, target.ring.ports);

    const result = await testLocalService({
      port,
      form,
      ...(options["local-prefix"] !== undefined ? { localPrefix: String(options["local-prefix"]) } : {}),
      ...(options.model !== undefined ? { model: String(options.model) } : {}),
      ...(options.content !== undefined ? { content: String(options.content) } : {}),
    });

    const out = (line: string): void => {
      process.stdout.write(`${line}\n`);
    };
    out(`${result.ok ? "ok" : "failed"}${result.httpStatus !== undefined ? ` (HTTP ${result.httpStatus})` : ""} - ${result.latencyMs}ms`);
    out(`POST ${result.request.url}`);
    if (result.error !== undefined) out(`error: ${result.error}`);
    if (result.bodyExcerpt !== undefined) out(result.bodyExcerpt.slice(0, 1200));
    if (!result.ok && result.error !== undefined && result.error.includes("ECONNREFUSED")) {
      out(`(is the consumer gateway running? start it with 'ai-fly run')`);
    }
    return result.ok ? 0 : 1;
  } catch (err) {
    return reportCliError(err);
  }
}
