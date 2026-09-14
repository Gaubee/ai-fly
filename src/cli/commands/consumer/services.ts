// `ai-fly services [list|stop|start|rm]`（service-lifecycle）：消费侧服务管理——
// 跨组列出（含停用态）、单服务停用/启用（daemon 在跑经 keyring watch 热生效，
// 未跑则下次启动生效；stop/rm 同义——「移除+可复活」，目录同步不复活停用服务）。
// 正交意图：参数解析 + 展示；停用语义在 consumer/store.ts，热生效在
// consumer/gateway.ts 与 lifecycle-watch.ts。

import { homedir } from "node:os";
import { parseArgv } from "../../args.ts";
import { UsageError } from "../../errors.ts";
import { isAlive, readPid, type StateKind } from "../../daemon-state.ts";
import { consumersRoot, listKeyrings, loadKeyring, removeKeyring, setProviderEnabled, setServiceEnabled, type Keyring } from "../../../consumer/store.ts";
import { ctxHomedir, ctxOut, type CommandContext } from "./common.ts";

const KIND: StateKind = "gateway";

const SPEC = {
  data: { type: "string", tilde: true },
} as const;

const USAGE = `usage:
  ai-fly services [list] [--data <dir>]              list services across groups (state: ready/disabled)
  ai-fly services stop <provider-ref>                stop ALL services of a provider (ring-level, revivable)
  ai-fly services stop <provider-ref> <service>      disable one service (stops its local listener)
  ai-fly services start <provider-ref>               re-enable a stopped provider (per-service stops persist)
  ai-fly services start <provider-ref> <service>     re-enable one disabled service
  ai-fly services rm <provider-ref>                  remove the whole provider (= forget: keyring + fabric
                                                      identity deleted; re-import to recover)
  ai-fly services rm <provider-ref> <service>        remove one service (disabled, revivable)
  <provider-ref>: endpointId | 8-char prefix | alias; <service>: serviceId | unique name`;

/** 服务定位：serviceId 精确优先，回退 name 唯一匹配（歧义报错）。 */
function findService(ring: Keyring, ref: string): { serviceId: string; name: string } {
  const byId = ring.services.find((s) => s.serviceId === ref);
  if (byId !== undefined) return { serviceId: byId.serviceId, name: byId.name };
  const byName = ring.services.filter((s) => s.name === ref);
  if (byName.length === 1) return { serviceId: byName[0]!.serviceId, name: byName[0]!.name };
  if (byName.length > 1) {
    throw new UsageError(`error: service name '${ref}' is ambiguous for '${ring.alias}' (use serviceId)`);
  }
  throw new UsageError(`error: unknown service '${ref}' for provider '${ring.alias}'`);
}

function daemonLine(out: (line: string) => void, home: string): void {
  const pid = readPid(home, KIND);
  if (pid !== null && isAlive(pid)) {
    out(`gateway daemon: running (pid ${pid}) - lifecycle changes apply live`);
  } else {
    out("gateway daemon: not running - changes take effect on next 'ai-fly run'");
  }
}

export async function run(argv: readonly string[], ctx: CommandContext = {}): Promise<number> {
  const home = ctxHomedir(ctx);
  const { options, positionals } = parseArgv(argv, SPEC, { homedir: home });
  const out = ctxOut(ctx);
  const root = consumersRoot(options.data as string | undefined, home);
  const sub = positionals[0] === undefined || positionals[0] === "list" ? "list" : positionals[0]!;

  if (sub === "list") {
    if (positionals.length > 1) {
      throw new UsageError(`error: unexpected argument '${positionals[1]}'`);
    }
    daemonLine(out, home);
    const { rings, warnings } = listKeyrings(root);
    for (const w of warnings) out(w);
    if (rings.length === 0) {
      out("no imported providers yet (ai-fly join / ai-fly import)");
      return 0;
    }
    out("");
    out("PROVIDER          SERVICE                             NAME                PORT   STATE");
    for (const ring of rings) {
      const disabled = new Set(ring.disabledServices);
      const rows = [...ring.services].sort((a, b) => a.serviceId.localeCompare(b.serviceId));
      for (const s of rows) {
        const port = ring.actualPorts[s.serviceId] ?? ring.ports[s.serviceId] ?? s.defaultPort;
        const state = ring.disabled || disabled.has(s.serviceId) ? "disabled" : "ready";
        const prov = ring.disabled ? `${ring.alias} (off)` : ring.alias;
        out(
          `${prov.padEnd(18)}${s.serviceId.padEnd(36)}${s.name.padEnd(20)}${String(port).padEnd(7)}${state}`,
        );
      }
      if (rows.length === 0) {
        out(`${(ring.disabled ? `${ring.alias} (off)` : ring.alias).padEnd(18)}-`);
      }
    }
    return 0;
  }

  if (sub !== "stop" && sub !== "start" && sub !== "rm") {
    throw new UsageError(USAGE);
  }
  const providerRef = positionals[1];
  const serviceRef = positionals[2];
  if (providerRef === undefined || (sub === "rm" && serviceRef === undefined && positionals.length > 2)) {
    throw new UsageError(USAGE);
  }
  if (providerRef === undefined) {
    throw new UsageError(USAGE);
  }
  const ring = loadKeyring(root, providerRef);
  if (ring === undefined) {
    throw new UsageError(`error: provider '${providerRef}' not found`);
  }
  daemonLine(out, home);

  // 提供方级（单参）：stop/start 整环开关；rm = forget 真删（区别于单服务停用式）
  if (serviceRef === undefined) {
    if (sub === "rm") {
      const removed = removeKeyring(root, ring.endpointId);
      out(`removed provider '${removed.ring.alias}' (${removed.ring.endpointId})`);
      out(`removed ${removed.dir} (keyring + fabric identity) - re-import to recover`);
      return 0;
    }
    const enabled = sub === "start";
    const { changed } = setProviderEnabled(root, ring.endpointId, enabled);
    out(
      changed
        ? `${enabled ? "started" : "stopped"} provider '${ring.alias}' (${ring.services.length} service(s))`
        : `provider '${ring.alias}' is already ${enabled ? "running" : "stopped"}`,
    );
    return 0;
  }

  const target = findService(ring, serviceRef);
  const enabled = sub === "start";
  const { changed } = setServiceEnabled(root, ring.endpointId, target.serviceId, enabled);
  const alias = ring.alias;
  if (enabled) {
    out(changed ? `started service '${target.name}' (${target.serviceId}) of '${alias}'` : `service '${target.name}' of '${alias}' is already enabled`);
  } else {
    out(changed ? `stopped service '${target.name}' (${target.serviceId}) of '${alias}'` : `service '${target.name}' of '${alias}' is already disabled`);
  }
  return 0;
}
