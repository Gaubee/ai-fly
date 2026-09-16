// `ai-fly status [--data <dir>] [--verbose|-v]`：消费侧状态快照。短暂启动引擎
// （最多 settleMs 等待各提供者到达 direct/relay/offline/key-all-invalid 终态），
// 打印状态机、路径类型、已服务请求计数、各服务映射端口；--verbose 展开 detail。
// 正交意图：快照与展示；状态机在 consumer/providers.ts（formatStatus 纯函数可测）。

import { homedir } from "node:os";
import { parseArgv } from "../../args.ts";
import { consumersRoot, listKeyrings } from "../../../consumer/store.ts";
import { startEngine } from "../../../consumer/runtime.ts";
import { createFabricSessionFactory, type ProviderStateKind, type ProviderStatus } from "../../../consumer/providers.ts";
import type { ServiceDetail, ServiceEntry } from "../../../wire/frames.ts";
import {
  createSdkFabricFactory,
  ctxHomedir,
  ctxOut,
  ringsForRun,
  type CommandContext,
} from "./common.ts";

/** 状态显示名（spec 六态）。 */
export const STATE_LABEL: Readonly<Record<ProviderStateKind, string>> = {
  "not-connected": "not connected",
  "connected-unauthed": "connected (not authorized)",
  direct: "connected (direct)",
  relay: "connected (relay)",
  offline: "offline",
  "key-all-invalid": "all keys rejected",
};

export function formatStatus(statuses: readonly ProviderStatus[], verbose: boolean): string[] {
  const lines: string[] = [];
  if (statuses.length === 0) {
    lines.push("no providers imported yet");
    return lines;
  }
  for (const s of statuses) {
    lines.push(`provider ${s.alias} (${s.endpointId})`);
    lines.push(`  state      : ${STATE_LABEL[s.state]}`);
    lines.push(`  served     : ${s.servedCount} request(s), ${s.bufferOverflows} buffer overflow(s)`);
    if (s.lastError !== undefined) lines.push(`  last error : ${s.lastError}`);
    if (s.services.length === 0) {
      lines.push("  services   : (none)");
    } else {
      lines.push("  services   :");
      for (const svc of s.services) {
        const port = s.ports[svc.serviceId] ?? svc.defaultPort;
        const pinned = s.ports[svc.serviceId] !== undefined;
        lines.push(`    - ${svc.name}  [${svc.serviceId}]  127.0.0.1:${port}${pinned ? " (pinned)" : ""}`);
        if (verbose) lines.push(...formatDetail(svc));
      }
    }
  }
  return lines;
}

function formatDetail(svc: ServiceEntry): string[] {
  const lines = [`        upstream: ${svc.detail?.upstream ?? "(not disclosed)"}`];
  if (svc.detail !== undefined) {
    const d: ServiceDetail = svc.detail;
    lines.push(`        match   : ${d.match.map((m) => `${m.type}:${m.value}`).join(" | ") || "(none)"}`);
    if (d.rewrite !== undefined) {
      const parts: string[] = [];
      if (d.rewrite.host !== undefined) parts.push(`host=${d.rewrite.host}`);
      if (d.rewrite.prefix !== undefined) parts.push(`prefix=${d.rewrite.prefix}`);
      if (parts.length > 0) lines.push(`        rewrite : ${parts.join("  ")}`);
    }
    // 生命周期四槽（hooks-lifecycle v2 投影：绑定/注入位均为 ●）
    const stages: string[] = [];
    if (d.auth !== undefined) {
      stages.push(`auth=${"secret" in d.auth ? "secret" : "script" in d.auth ? "script" : "literal"}`);
    }
    if (d.headers !== undefined) {
      const n = Object.keys(d.headers.set ?? {}).length + (d.headers.remove ?? []).length;
      stages.push(`headers=${n}${d.headers.script !== undefined ? "+script" : ""}`);
    }
    if (d.request !== undefined) stages.push("request=script");
    if (d.response !== undefined) stages.push("response=script");
    if (stages.length > 0) lines.push(`        lifecycle: ${stages.join("  ")}`);
  }
  return lines;
}

export async function run(argv: readonly string[], ctx: CommandContext = {}): Promise<number> {
  const { options, positionals } = parseArgv(
    argv,
    {
      data: { type: "string", tilde: true },
      verbose: { type: "boolean" },
      relay: { type: "multi" },
      proxy: { type: "string" },
    },
    { homedir: ctx.homedir ?? homedir() },
  );
  const verbose = options.verbose === true || positionals.includes("-v");
  const out = ctxOut(ctx);
  const root = consumersRoot(options.data as string | undefined, ctxHomedir(ctx));
  const { rings, warnings } = listKeyrings(root);
  for (const w of warnings) out(`warning: ${w}`);
  const engineRings = ringsForRun(rings);
  if (engineRings.length === 0) {
    for (const line of formatStatus([], verbose)) out(line);
    return 0;
  }
  // 短暂启动引擎取实时状态（含路径类型与请求计数），等待各提供者到达观测终态
  const factory = await createSdkFabricFactory(
      options.relay as string[] | undefined,
      ctx,
      undefined,
      options.proxy as string | undefined,
    );
  const engine = await startEngine({
    rings: engineRings,
    consumersRoot: root,
    sessionFactoryFor: (ring) =>
      createFabricSessionFactory(factory, {
        dataDir: `${root}/${ring.endpointId.slice(0, 8)}/fabric`,
        providerEndpointId: ring.endpointId,
        // 链接带来的会合点优先（Owner 裁决 2026-09-13）：ring 内嵌 relay 逐环传给 fabric
        ...(ring.relayUrls.length > 0 ? { relayUrls: ring.relayUrls } : {}),
      }),
    onNotice: () => undefined, // 状态快照不打印端口 NOTICE（listenerInfo 已含）
  });
  const settleMs = 2_500;
  const terminal: ReadonlySet<ProviderStateKind> = new Set(["direct", "relay", "offline", "key-all-invalid"]);
  const deadline = Date.now() + settleMs;
  for (;;) {
    const snap = engine.manager.snapshot();
    if (snap.every((s) => terminal.has(s.state)) || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const lines = formatStatus(engine.manager.snapshot(), verbose);
  await engine.stop();
  for (const line of lines) out(line);
  return 0;
}
