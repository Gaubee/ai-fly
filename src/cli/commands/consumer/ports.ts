// `ai-fly ports [--data <dir>] [<serviceId> --port <n>]`：端口偏好读写。
// 无参 = 全部服务端口清单（显式偏好标记 pinned，其余 default）；带 serviceId =
// 持久化端口偏好（运行中网关不热应用，下次 run 生效）。
// 正交意图：参数解析与展示；规则与校验在 consumer/ports.ts / consumer/store.ts。

import { homedir } from "node:os";
import { parseArgv } from "../../args.ts";
import { UsageError } from "../../errors.ts";
import { consumersRoot, listKeyrings, setPort } from "../../../consumer/store.ts";
import { desiredPortFor, validatePortArg } from "../../../consumer/ports.ts";
import { ctxHomedir, ctxOut, type CommandContext } from "./common.ts";

export async function run(argv: readonly string[], ctx: CommandContext = {}): Promise<number> {
  const { options, positionals } = parseArgv(
    argv,
    { data: { type: "string", tilde: true }, port: { type: "string" } },
    { homedir: ctx.homedir ?? homedir() },
  );
  const out = ctxOut(ctx);
  const root = consumersRoot(options.data as string | undefined, ctxHomedir(ctx));
  const { rings, warnings } = listKeyrings(root);
  for (const w of warnings) out(`warning: ${w}`);

  const serviceId = positionals[0];
  if (serviceId === undefined) {
    // 读：全部服务的端口清单
    if (rings.length === 0) {
      out("no providers imported yet");
      return 0;
    }
    for (const ring of rings) {
      out(`provider ${ring.alias} (${ring.endpointId}):`);
      if (ring.services.length === 0) out("  (no services known yet - run the gateway to fetch the catalog)");
      for (const s of ring.services) {
        const pinned = ring.ports[s.serviceId] !== undefined;
        out(`  ${s.serviceId}  ${s.name}  port ${desiredPortFor(s, ring.ports)}  [${pinned ? "pinned" : `default ${s.defaultPort}`}]`);
      }
    }
    return 0;
  }

  // 写：setPort（serviceId 必须存在于某个钥环）
  const rawPort = options.port as string | undefined;
  if (rawPort === undefined) {
    throw new UsageError(`error: --port is required when a serviceId is given\nusage: ai-fly ports <serviceId> --port <n>`);
  }
  const port = validatePortArg(rawPort);
  const owner = rings.find((r) => r.services.some((s) => s.serviceId === serviceId));
  if (owner === undefined) {
    throw new UsageError(`error: unknown service '${serviceId}' (see 'ai-fly ports' for the list)`);
  }
  const updated = setPort(root, owner.endpointId, serviceId, port);
  out(`service ${serviceId} (${owner.alias}) pinned to port ${port}`);
  out("note: a running gateway picks this up on next start");
  void updated;
  return 0;
}
