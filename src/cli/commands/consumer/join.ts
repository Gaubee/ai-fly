// `ai-fly join <dweb1令牌> [--data <dir>] [--relay <url>…]`：设备入网（fabric 层，
// 仅入网不含服务授权）。staging 兑换成功后归位 fabric 身份并写入空钥环骨架。
// 正交意图：参数解析 + 摘要打印；逻辑在 consumer/join.ts。

import { homedir } from "node:os";
import { parseArgv } from "../../args.ts";
import { UsageError } from "../../errors.ts";
import { consumersRoot } from "../../../consumer/store.ts";
import { joinDevice } from "../../../consumer/join.ts";
import { createSdkFabricFactory, ctxHomedir, ctxOut, type CommandContext } from "./common.ts";

export async function run(argv: readonly string[], ctx: CommandContext = {}): Promise<number> {
  const { options, positionals } = parseArgv(
    argv,
    { data: { type: "string", tilde: true }, relay: { type: "multi" }, proxy: { type: "string" } },
    { homedir: ctx.homedir ?? homedir() },
  );
  const token = positionals[0];
  if (token === undefined) {
    throw new UsageError("error: join requires an invite token argument\nusage: ai-fly join <dweb1-token> [--data <dir>]");
  }
  const out = ctxOut(ctx);
  const root = consumersRoot(options.data as string | undefined, ctxHomedir(ctx));
  const factory = await createSdkFabricFactory(
    options.relay as string[] | undefined,
    ctx,
    undefined,
    options.proxy as string | undefined,
  );
  const result = await joinDevice(token, root, { fabric: factory });
  if (result.alreadyJoined) {
    out(`already joined to provider '${result.ring.alias}' (${result.ring.endpointId})`);
    out("note: the invite token was consumed by this redemption; the existing identity was kept");
  } else {
    out(`joined to provider '${result.ring.alias}' (${result.ring.endpointId})`);
    out(`fabric identity: ${root}/${result.ring.endpointId.slice(0, 8)}/fabric`);
    out("no keys in the keyring yet - get a share link (ai-fly import <aifly1.>) or a bare key (ai-fly key add)");
  }
  return 0;
}
