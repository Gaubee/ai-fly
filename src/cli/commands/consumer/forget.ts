// `ai-fly forget <endpointId|8字符前缀|别名> [--data <dir>]`：移除整个导入——
// 钥环与 fabric 身份目录一并删除；提供方侧撤销属提供方操作（两级撤销语义）。
// 正交意图：参数解析 + 摘要；删除逻辑在 consumer/store.ts。

import { homedir } from "node:os";
import { parseArgv } from "../../args.ts";
import { UsageError } from "../../errors.ts";
import { consumersRoot, removeKeyring } from "../../../consumer/store.ts";
import { ctxHomedir, ctxOut, type CommandContext } from "./common.ts";

export async function run(argv: readonly string[], ctx: CommandContext = {}): Promise<number> {
  const { options, positionals } = parseArgv(
    argv,
    { data: { type: "string", tilde: true } },
    { homedir: ctx.homedir ?? homedir() },
  );
  const ref = positionals[0];
  if (ref === undefined) {
    throw new UsageError("error: forget requires a provider reference\nusage: ai-fly forget <endpointId|8-char-prefix|alias> [--data <dir>]");
  }
  const out = ctxOut(ctx);
  const root = consumersRoot(options.data as string | undefined, ctxHomedir(ctx));
  const removed = removeKeyring(root, ref);
  out(`forgot provider '${removed.ring.alias}' (${removed.ring.endpointId})`);
  out(`removed ${removed.dir} (keyring + fabric identity)`);
  out("note: provider-side revocation must be done on the provider (ai-fly key revoke / ai-fly revoke)");
  return 0;
}
