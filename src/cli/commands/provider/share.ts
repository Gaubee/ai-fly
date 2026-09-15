// `ai-fly share --group <name> [--ttl <dur>]`：组合链接（1 令牌 + 1 新密钥 + 服务
// 脱敏视图）。TTL CLI 层校验 1s..30d（默认 60min）；invite 无 relay 时按 SDK
// 逃生阀语义处理（--allow-relayless）；relay 未配置输出稳定入口指引。

import { homedir } from "node:os";
import { assertDurationRange, parseArgv, parseDurationMs } from "../../args.ts";
import { UsageError, CliError, reportCliError } from "../../errors.ts";
import { openExistingFabric } from "../../../provider/serve.ts";
import { resolveHttpProxy } from "../../proxy.ts";
import {
  SHARE_LINK_SECRET_HINT,
  SHARE_TTL_DEFAULT_MS,
  SHARE_TTL_MAX_MS,
  SHARE_TTL_MIN_MS,
  buildShareLink,
} from "../../../provider/link.ts";
import { openStore, resolveDataDir, requireString, resolvedRelayUrls, str } from "./common.ts";

const SPEC = {
  data: { type: "string", tilde: true },
  group: { type: "string" },
  ttl: { type: "string" },
  relay: { type: "multi" },
  "allow-relayless": { type: "boolean" },
  "key-id": { type: "string" },
  "key-name": { type: "string" },
} as const;

export async function run(argv: string[], ctx: { homedir?: string } = {}): Promise<number> {
  let fabric: Awaited<ReturnType<typeof openExistingFabric>> | undefined;
  try {
    const home = ctx.homedir ?? homedir();
    const { options } = parseArgv(argv, SPEC, { homedir: home });
    const group = requireString(str(options.group), "group");
    const dataDir = resolveDataDir(str(options.data), home);
    const ttlMs =
      options.ttl === undefined
        ? SHARE_TTL_DEFAULT_MS
        : parseDurationMs(str(options.ttl)!, "ttl");
    assertDurationRange(ttlMs, SHARE_TTL_MIN_MS, SHARE_TTL_MAX_MS, "ttl", "1s..30d");

    const store = openStore(dataDir, home);
    // legacy 门禁前置（复核 R1-F6）：invite 是有外部副作用的资源，先于组网/
    // 签发拒绝，避免「invite 已消费但链接构建失败」。
    if (store.legacy !== null) {
      process.stderr.write(
        "error: provider store is legacy (pre-v2); remove legacy services and re-add before sharing\n",
      );
      return 1;
    }
    const resolvedRelay = resolvedRelayUrls(options, home);
    if (resolvedRelay === undefined) {
      // 实机踩坑（2026-09-09）：serve --relay <自定> 而 share 未带 --relay 时，链接
      // 会内嵌 SDK 公网默认 relay——兑换可能成功但消费方连接永败。此处显式警示。
      process.stdout.write(
        "warning: no relay configured for this command (flag/env/config); the link will carry public default relays - if the provider daemon runs on a custom relay, pass a matching --relay\n",
      );
    }
    fabric = await openExistingFabric(dataDir, resolvedRelay, resolveHttpProxy(undefined));

    const invite = await issueInvite(fabric, ttlMs, options["allow-relayless"] === true);
    const relayStatus = await fabric.relayStatus();
    const result = buildShareLink({
      store,
      group,
      invite,
      endpointId: fabric.endpointId,
      relayUrls: relayStatus.urls,
      keyId: str(options["key-id"]),
      keyName: str(options["key-name"]),
    });

    process.stdout.write(
      [
        `share link for group '${group}' (keyId ${result.keyId}, ttl ${describeTtl(ttlMs)}):`,
        "",
        result.link,
        "",
        ...result.warnings,
        SHARE_LINK_SECRET_HINT,
        "",
      ].join("\n"),
    );
    return 0;
  } catch (err) {
    return reportCliError(err);
  } finally {
    await fabric?.shutdown().catch(() => undefined);
  }
}

async function issueInvite(
  fabric: NonNullable<Awaited<ReturnType<typeof openExistingFabric>>>,
  ttlMs: number,
  allowRelayless: boolean,
): Promise<string> {
  try {
    return await fabric.invite(ttlMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("[invite-without-relay]")) {
      if (!allowRelayless) {
        throw new CliError(
          "error: invite needs a relay (or advertiseAddrs); pass --allow-relayless to issue a relayless invite",
        );
      }
      return await fabric.invite(ttlMs, undefined, { allowRelayless: true });
    }
    throw err;
  }
}

function describeTtl(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms}ms`;
}
