// `ai-fly import <aifly1.链接> [--data <dir>] [--preview] [--run] [--strict-ports]`：
// 组合信封导入。--preview 离线解析（零网络、零 Fabric 构造）；新设备兑换、老设备
// 跳过兑换直接入环；--run 导入后原地启动网关长驻。
// 正交意图：参数解析 + 流程编排；逻辑在 consumer/join.ts / consumer/runtime.ts。

import { homedir } from "node:os";
import { parseArgv } from "../../args.ts";
import { UsageError } from "../../errors.ts";
import { consumersRoot, listKeyrings } from "../../../consumer/store.ts";
import { decodeShareLink, formatKeyringSummary, formatLinkPreview, importLink } from "../../../consumer/join.ts";
import { startEngine } from "../../../consumer/runtime.ts";
import { createFabricProviderTransport } from "../../../consumer/providers.ts";
import {
  createSdkFabricFactory,
  ctxHomedir,
  ctxOut,
  printListeners,
  ringsForRun,
  waitForSignals,
  type CommandContext,
} from "./common.ts";

export async function run(argv: readonly string[], ctx: CommandContext = {}): Promise<number> {
  const { options, positionals } = parseArgv(
    argv,
    {
      data: { type: "string", tilde: true },
      preview: { type: "boolean" },
      run: { type: "boolean" },
      "strict-ports": { type: "boolean" },
      relay: { type: "multi" },
    },
    { homedir: ctx.homedir ?? homedir() },
  );
  const link = positionals[0];
  if (link === undefined) {
    throw new UsageError("error: import requires a share link argument\nusage: ai-fly import <aifly1-link> [--data <dir>] [--preview] [--run]");
  }
  const out = ctxOut(ctx);
  const root = consumersRoot(options.data as string | undefined, ctxHomedir(ctx));
  // 链接内嵌 relay 是提供方签发入口：作为缺省层级参与解析（flag 仍可覆盖）
  const payload = decodeShareLink(link);

  if (options.preview === true) {
    // 离线解析：零网络请求、零 Fabric 构造（不加载 SDK）
    for (const line of formatLinkPreview(payload)) out(line);
    return 0;
  }

  const linkRelays = payload.provider.relayUrls;
  const flagRelays = options.relay as string[] | undefined;
  if (flagRelays !== undefined && flagRelays.length > 0 && linkRelays.length > 0) {
    const sameSet =
      flagRelays.length === linkRelays.length && flagRelays.every((u) => linkRelays.includes(u));
    if (!sameSet) {
      out(
        "warning: --relay overrides the share link's relay entries; if the provider stays unreachable, drop the flag to use the link's entries",
      );
    }
  } else if (linkRelays.length > 0) {
    out(`relay: using ${linkRelays.length} entry URL(s) from the share link (override with --relay)`);
  }
  const factory = await createSdkFabricFactory(flagRelays, ctx, linkRelays);
  const result = await importLink(link, { consumersRoot: root, fabric: factory });
  out(result.redeemed ? "invite redeemed - fabric identity created" : "existing fabric identity reused - invite not consumed");
  for (const line of formatKeyringSummary(result.ring)) out(line);

  if (options.run === true) {
    const { rings, warnings } = listKeyrings(root);
    for (const w of warnings) out(`warning: ${w}`);
    const engine = await startEngine({
      rings: ringsForRun(rings),
      consumersRoot: root,
      sessionFactoryFor: (ring) =>
        createFabricProviderTransport(factory, {
          dataDir: `${root}/${ring.endpointId.slice(0, 8)}/fabric`,
          providerEndpointId: ring.endpointId,
        }),
      strictPorts: options["strict-ports"] === true,
      onNotice: out,
    });
    printListeners(out, engine.gateway.listenerInfo());
    out("gateway running - press Ctrl-C to stop");
    await waitForSignals();
    await engine.stop();
    out("gateway stopped");
  }
  return 0;
}
