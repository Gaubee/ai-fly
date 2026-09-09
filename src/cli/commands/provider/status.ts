// `ai-fly status [--verbose]`：提供方状态快照——存储摘要（服务/分组/密钥）+ fabric
// 身份（EndpointId/fabric-id/relay 状态/成员数）；--verbose 含服务 detail（ASCII
// 展示形，$env/$secret 引用头值显示为 <hidden>）。

import { homedir } from "node:os";
import { parseArgv } from "../../args.ts";
import { reportCliError } from "../../errors.ts";
import { openExistingFabric } from "../../../provider/serve.ts";
import { buildServiceDetail, detailDisplayLines } from "../../../provider/detail.ts";
import { openStore, resolveDataDir, resolvedRelayUrls, str } from "./common.ts";

const SPEC = {
  data: { type: "string", tilde: true },
  relay: { type: "multi" },
  verbose: { type: "boolean" },
} as const;

export async function run(argv: string[], ctx: { homedir?: string } = {}): Promise<number> {
  let fabric: Awaited<ReturnType<typeof openExistingFabric>> | undefined;
  try {
    const home = ctx.homedir ?? homedir();
    const { options } = parseArgv(argv, SPEC, { homedir: home });
    const verbose = options.verbose === true;
    const dataDir = resolveDataDir(str(options.data), home);
    const store = openStore(dataDir);

    const services = store.listServices();
    const groups = store.listGroups();
    const keys = store.listKeys();
    const lines: string[] = [];
    lines.push(`ai-fly provider status (${dataDir})`);
    lines.push(`  alias   : ${store.alias ?? "(unset)"}`);
    lines.push(`  services: ${services.length}`);
    lines.push(`  groups  : ${groups.length}`);
    lines.push(
      `  keys    : ${keys.filter((k) => k.revokedAt === undefined).length} active, ${keys.filter((k) => k.revokedAt !== undefined).length} revoked`,
    );

    if (verbose) {
      for (const s of services) {
        lines.push(`  ${s.name} [${s.serviceId}] defaultPort=${s.defaultPort}`);
        for (const line of detailDisplayLines(buildServiceDetail(s))) lines.push(`    ${line}`);
      }
    }

    // fabric 身份（存在时；打开失败降级为提示而非失败——状态命令不应被 SDK 问题挡死）。
    try {
      fabric = await openExistingFabric(dataDir, resolvedRelayUrls(options, home));
      const fabricIdHex = await fabric.fabricIdHex();
      const members = await fabric.members();
      const relay = await fabric.relayStatus();
      lines.push(`  endpoint: ${fabric.endpointId}`);
      lines.push(`  fabric  : ${fabricIdHex}`);
      lines.push(`  members: ${members.length}`);
      lines.push(
        `  relay   : ${relay.mode}${relay.urls.length > 0 ? ` ${relay.urls.join(", ")}` : " (none)"}${relay.online === true ? " [online]" : relay.online === false ? " [offline]" : ""}`,
      );
    } catch (err) {
      lines.push(`  fabric  : unavailable (${(err as Error).message})`);
    }

    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  } catch (err) {
    return reportCliError(err);
  } finally {
    await fabric?.shutdown().catch(() => undefined);
  }
}
