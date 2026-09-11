// `ai-fly run [--data <dir>] [--strict-ports]`：网关长驻。加载全部钥环，物化本地监听
// （离线 503 语义），启动提供者连接与退避重连；SIGINT/SIGTERM 优雅退出。
// 正交意图：参数解析 + 生命周期；引擎装配在 consumer/runtime.ts。

import { homedir } from "node:os";
import { parseArgv } from "../../args.ts";
import { CliError } from "../../errors.ts";
import { consumersRoot, listKeyrings } from "../../../consumer/store.ts";
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
  const { options } = parseArgv(
    argv,
    {
      data: { type: "string", tilde: true },
      "strict-ports": { type: "boolean" },
      relay: { type: "multi" },
      proxy: { type: "string" },
    },
    { homedir: ctx.homedir ?? homedir() },
  );
  const out = ctxOut(ctx);
  const root = consumersRoot(options.data as string | undefined, ctxHomedir(ctx));
  const { rings, warnings } = listKeyrings(root);
  for (const w of warnings) out(`warning: ${w}`);
  const engineRings = ringsForRun(rings);
  if (engineRings.length === 0) {
    throw new CliError("error: no imported providers - run 'ai-fly import <aifly1-link>' or 'ai-fly join <token>' first");
  }
  const factory = await createSdkFabricFactory(
    options.relay as string[] | undefined,
    ctx,
    undefined,
    options.proxy as string | undefined,
  );
  out(
    `gateway starting - booting fabric for ${engineRings.length} provider ring(s)` +
      " (unreachable relays can stall this ~30s; Ctrl+C to abort)...",
  );
  const engine = await startEngine({
    rings: engineRings,
    consumersRoot: root,
    sessionFactoryFor: (ring) =>
      createFabricProviderTransport(factory, {
        dataDir: `${root}/${ring.endpointId.slice(0, 8)}/fabric`,
        providerEndpointId: ring.endpointId,
        // 链接带来的会合点优先（Owner 裁决 2026-09-13）：ring 内嵌 relay 逐环传给 fabric
        ...(ring.relayUrls.length > 0 ? { relayUrls: ring.relayUrls } : {}),
      }),
    strictPorts: options["strict-ports"] === true,
    onNotice: out,
  });
  printListeners(out, engine.gateway.listenerInfo());
  out("gateway running - press Ctrl-C to stop");
  await waitForSignals();
  await engine.stop();
  out("gateway stopped");
  return 0;
}
