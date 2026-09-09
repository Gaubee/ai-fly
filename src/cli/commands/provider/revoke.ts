// `ai-fly revoke <endpointId>`：fabric 级踢出设备（名册移除 + 断开 + 后续连接被
// 门控拒绝）。与撤钥（key revoke，应用层）语义分离：踢人不撤钥。

import { homedir } from "node:os";
import { parseArgv } from "../../args.ts";
import { UsageError, reportCliError } from "../../errors.ts";
import { openExistingFabric } from "../../../provider/serve.ts";
import { resolveDataDir, resolvedRelayUrls, str } from "./common.ts";

const SPEC = {
  data: { type: "string", tilde: true },
  relay: { type: "multi" },
} as const;

export async function run(argv: string[], ctx: { homedir?: string } = {}): Promise<number> {
  let fabric: Awaited<ReturnType<typeof openExistingFabric>> | undefined;
  try {
    const home = ctx.homedir ?? homedir();
    const { options, positionals } = parseArgv(argv, SPEC, { homedir: home });
    const endpointId = positionals[0];
    if (endpointId === undefined || endpointId === "") {
      throw new UsageError("error: revoke requires an <endpointId> argument");
    }
    if (positionals.length > 1) {
      throw new UsageError(`error: unexpected argument '${positionals[1]}'`);
    }
    const dataDir = resolveDataDir(str(options.data), home);
    fabric = await openExistingFabric(dataDir, resolvedRelayUrls(options, home));
    await fabric.revoke(endpointId);
    process.stdout.write(`member revoked: ${endpointId}\n`);
    return 0;
  } catch (err) {
    return reportCliError(err);
  } finally {
    await fabric?.shutdown().catch(() => undefined);
  }
}
