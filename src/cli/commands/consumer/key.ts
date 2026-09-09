// `ai-fly key add <sk-aifly-密钥> --provider <endpointId|前缀|别名>`：裸密钥入环
// （使用方侧）。issue/list/revoke 是提供方侧子命令（另一车道），此处不实现、
// 明确指引。正交意图：参数分流；入环逻辑在 consumer/join.ts。

import { homedir } from "node:os";
import { parseArgv } from "../../args.ts";
import { UsageError } from "../../errors.ts";
import { consumersRoot } from "../../../consumer/store.ts";
import { addKey, formatKeyringSummary } from "../../../consumer/join.ts";
import { ctxHomedir, ctxOut, type CommandContext } from "./common.ts";

export async function run(argv: readonly string[], ctx: CommandContext = {}): Promise<number> {
  const sub = argv[0];
  if (sub === undefined) {
    throw new UsageError(
      "error: key requires a subcommand\nusage (consumer): ai-fly key add <sk-aifly-key> --provider <id|alias>\nusage (provider): ai-fly key issue|list|revoke --group <name>",
    );
  }
  if (sub !== "add") {
    throw new UsageError(
      `error: 'key ${sub}' is a provider-side subcommand (issue/list/revoke run on the provider machine)\nusage (consumer): ai-fly key add <sk-aifly-key> --provider <id|alias>`,
    );
  }
  const { options, positionals } = parseArgv(
    argv.slice(1),
    { data: { type: "string", tilde: true }, provider: { type: "string" } },
    { homedir: ctx.homedir ?? homedir() },
  );
  const key = positionals[0];
  if (key === undefined) {
    throw new UsageError("error: key add requires a key argument\nusage: ai-fly key add <sk-aifly-key> --provider <id|alias>");
  }
  const provider = options.provider as string | undefined;
  if (provider === undefined) {
    throw new UsageError("error: --provider is required (endpointId, 8-char prefix, or alias)");
  }
  const out = ctxOut(ctx);
  const root = consumersRoot(options.data as string | undefined, ctxHomedir(ctx));
  const result = addKey(key, provider, root);
  out(result.added ? "key added to keyring" : "key updated in keyring (existing entry)");
  for (const line of formatKeyringSummary(result.ring)) out(line);
  out("note: key id and group metadata are filled in on the next successful authorization");
  return 0;
}
