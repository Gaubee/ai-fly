// 共享契约的实现（implement）：每个过程转发 M1 引擎模块（store/engine/
// startProviderDaemon/link/join/...），不复制业务逻辑；变更操作走引擎同款校验
// （复用 M1 模块）；统一 DomainError→ORPCError 边界（skill-creator-v2 同款
// router 根中间件，仅此处转换一次）。文案英文 ASCII。
// 正交意图：传输/门禁/静态托管在 web-server.ts；引擎生命周期在 engine-host.ts。

import { implement, ORPCError } from "@orpc/server";
import { homedir } from "node:os";
import { RpcErrorDefinitions, rpcContract } from "../shared/rpc-contract.ts";
import type { Preset } from "../shared/rpc-contract.ts";
import { DomainError, toDomainError } from "./errors.ts";
import type { EngineHost } from "./engine-host.ts";
import { buildShareLink, previewShareLink, SHARE_TTL_DEFAULT_MS } from "../provider/link.ts";
import type { KeyRecord, ServiceConfig, ServiceInput } from "../provider/store.ts";
import { importLink, joinDevice, addKey } from "../consumer/join.ts";
import { listKeyrings, removeKeyring, setPort } from "../consumer/store.ts";
import { applyWriter, previewWriter } from "./writers/index.ts";
import { resolveTargetPort } from "./writers/common.ts";
import { loadSettings, saveSettings } from "./settings.ts";
import {
  fetchModelsDevPresets,
  loadCuratedPresets,
  modelsDevCachePath,
} from "../../presets/models-dev.ts";

/** router 依赖（engine-host 注入；测试可替换 home/缓存路径）。 */
export interface RpcRouterDeps {
  host: EngineHost;
  /** 应用 home 基准（settings/models-dev 缓存/写手定位；默认 os.homedir()）。 */
  home?: string;
}

/** 密钥记录 → 契约视图（去哈希：哈希与原文都不进 RPC 面）。 */
function keyView(key: KeyRecord): {
  keyId: string;
  group: string;
  createdAt: number;
  revokedAt?: number;
} {
  return {
    keyId: key.keyId,
    group: key.group,
    createdAt: key.createdAt,
    ...(key.revokedAt !== undefined ? { revokedAt: key.revokedAt } : {}),
  };
}

/** 预设 → 服务输入展开（applyAsService 核心：match 从 matchDomains 派生 suffix 规则；$env 注入 authorization）。 */
export function presetToServiceInput(
  preset: Preset,
  input: { name?: string | undefined; port?: number | undefined; keyEnv?: string | undefined },
): { serviceInput: ServiceInput; envHint?: string } {
  const keyEnv = input.keyEnv ?? preset.keyEnv;
  const serviceInput: ServiceInput = {
    name: input.name ?? preset.id,
    upstream: preset.baseUrl,
    match: preset.matchDomains.map((domain) => ({ type: "suffix" as const, value: domain })),
    ...(input.port !== undefined ? { defaultPort: input.port } : { defaultPort: preset.defaultPort }),
    ...(keyEnv !== undefined
      ? { rewrite: { headerSet: { authorization: `$env:${keyEnv}` } } }
      : {}),
  };
  const envHint =
    keyEnv !== undefined
      ? `export ${keyEnv}='Bearer <your-api-key>' (full header value; the provider injects it upstream)`
      : undefined;
  return { serviceInput, ...(envHint !== undefined ? { envHint } : {}) };
}

/** 把契约绑定到引擎宿主，单一错误边界。 */
export function createRpcRouter(deps: RpcRouterDeps) {
  const host = deps.host;
  const home = (): string => deps.home ?? homedir();

  /** 写手目标解析：serviceId → 消费方存储端口（pinned > default）；显式 port 直用。 */
  const resolveWriterTarget = (
    serviceId: string | undefined,
    port: number | undefined,
  ): ReturnType<typeof resolveTargetPort> => {
    if (port !== undefined) return resolveTargetPort(port);
    if (serviceId === undefined) {
      throw new DomainError("INVALID_INPUT", "exactly one of serviceId or port is required");
    }
    const { rings } = listKeyrings(host.consumersRoot);
    for (const ring of rings) {
      const service = ring.services.find((s) => s.serviceId === serviceId);
      if (service !== undefined) {
        return resolveTargetPort(ring.ports[service.serviceId] ?? service.defaultPort);
      }
    }
    throw new DomainError("NOT_FOUND", `error: unknown service '${serviceId}'`);
  };

  const rpc = implement(rpcContract);
  const domainErrorBoundary = rpc.middleware(async ({ next }) => {
    try {
      return await next();
    } catch (error) {
      if (error instanceof DomainError) {
        throw new ORPCError(error.code, {
          status: RpcErrorDefinitions[error.code].status,
          message: error.message,
          cause: error,
        });
      }
      const mapped = toDomainError(error);
      if (mapped.code === "INTERNAL") {
        // 未归类错误：不向 UI 泄露内部信息；stderr 留一行诊断（不含载荷）
        process.stderr.write(
          `[rpc] unclassified error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`,
        );
        throw new ORPCError("INTERNAL", { status: 500, message: "internal error", cause: error });
      }
      throw new ORPCError(mapped.code, {
        status: RpcErrorDefinitions[mapped.code].status,
        message: mapped.message,
        cause: error,
      });
    }
  });

  return rpc.use(domainErrorBoundary).router({
    provider: {
      services: {
        // 占位：m3 MODELS-TEST 车道替换为真实实现（密钥解析 + 三 apiForm 最小请求）
        test: rpc.provider.services.test.handler(() => {
          throw new DomainError("INVALID_STATE", "connectivity test is not wired yet");
        }),
        list: rpc.provider.services.list.handler(() => ({
          services: host.providerStore().listServices(),
        })),
        get: rpc.provider.services.get.handler(({ input }) => {
          const service = host.providerStore().getServiceByName(input.name);
          if (service === undefined) {
            throw new DomainError("NOT_FOUND", `error: service '${input.name}' not found`);
          }
          return service;
        }),
        add: rpc.provider.services.add.handler(({ input }) => {
          const service = host.providerStore().addService(input);
          return { service };
        }),
        remove: rpc.provider.services.remove.handler(({ input }) => {
          host.providerStore().removeService(input.name);
          return { removed: true as const };
        }),
      },
      groups: {
        list: rpc.provider.groups.list.handler(() => ({
          groups: host.providerStore().listGroups(),
        })),
        add: rpc.provider.groups.add.handler(({ input }) => {
          const group = host.providerStore().addGroup(input.name, input.serviceNames, input.limits);
          return { group };
        }),
        setServices: rpc.provider.groups.setServices.handler(({ input }) => {
          const group = host.providerStore().setGroupServices(input.name, input.serviceNames);
          return { group };
        }),
      },
      keys: {
        issue: rpc.provider.keys.issue.handler(({ input }) =>
          host.providerStore().issueKey(input.group),
        ),
        list: rpc.provider.keys.list.handler(() => ({
          keys: host.providerStore().listKeys().map(keyView),
        })),
        revoke: rpc.provider.keys.revoke.handler(({ input }) => ({
          key: keyView(host.providerStore().revokeKey(input.keyId)),
        })),
      },
      // 占位：m3 SECRETS 车道替换为真实实现（secrets.json store；list 只回名称）
      secrets: {
        list: rpc.provider.secrets.list.handler(() => {
          throw new DomainError("INVALID_STATE", "secrets store is not wired yet");
        }),
        set: rpc.provider.secrets.set.handler(() => {
          throw new DomainError("INVALID_STATE", "secrets store is not wired yet");
        }),
        remove: rpc.provider.secrets.remove.handler(() => {
          throw new DomainError("INVALID_STATE", "secrets store is not wired yet");
        }),
      },
      share: {
        create: rpc.provider.share.create.handler(async ({ input }) => {
          const daemon = host.requireProviderDaemon();
          const ttlMs = input.ttlMs ?? SHARE_TTL_DEFAULT_MS;
          // invite 语义同 CLI：无 relay 时 SDK 抛错（UI 明确报错优于静默降级）
          const invite = await daemon.fabric.invite(ttlMs);
          const relayStatus = await daemon.fabric.relayStatus();
          const result = buildShareLink({
            store: host.providerStore(),
            group: input.group,
            invite,
            endpointId: daemon.endpointId,
            relayUrls: relayStatus.urls,
          });
          return { link: result.link, keyId: result.keyId, warnings: result.warnings };
        }),
      },
      status: rpc.provider.status.handler(() => {
        const store = host.providerStore();
        const keys = store.listKeys();
        const daemon = host.runningProviderDaemon();
        return {
          running: daemon !== null,
          ...(daemon !== null
            ? {
                alias: daemon.engine.alias(),
                endpointId: daemon.endpointId,
                fabricIdHex: daemon.fabricIdHex,
                relayMode: daemon.relayMode,
              }
            : { alias: store.alias ?? undefined }),
          relayUrls: daemon?.relayUrls ?? [],
          sessionCount: daemon?.engine.sessionCount() ?? 0,
          services: store.listServices().length,
          groups: store.listGroups().length,
          activeKeys: keys.filter((k) => k.revokedAt === undefined).length,
          revokedKeys: keys.filter((k) => k.revokedAt !== undefined).length,
        };
      }),
      daemon: {
        start: rpc.provider.daemon.start.handler(async () => {
          await host.startProvider();
          return { running: true as const };
        }),
        stop: rpc.provider.daemon.stop.handler(async () => {
          await host.stopProvider();
          return { running: false as const };
        }),
      },
    },
    consumer: {
      import: {
        preview: rpc.consumer.import.preview.handler(({ input }) => previewShareLink(input.link)),
        apply: rpc.consumer.import.apply.handler(async ({ input }) => {
          const factory = await host.resolveFabricFactory();
          const result = await importLink(input.link, {
            consumersRoot: host.consumersRoot,
            fabric: factory,
          });
          await host.reloadGateway();
          return {
            alias: result.ring.alias,
            endpointId: result.ring.endpointId,
            redeemed: result.redeemed,
            keyAdded: result.ring.keys.length > 0,
            services: result.ring.services.map((s) => ({
              serviceId: s.serviceId,
              name: s.name,
              defaultPort: s.defaultPort,
            })),
          };
        }),
      },
      join: rpc.consumer.join.handler(async ({ input }) => {
        const factory = await host.resolveFabricFactory();
        const result = await joinDevice(input.invite, host.consumersRoot, { fabric: factory });
        await host.reloadGateway();
        return {
          alias: result.ring.alias,
          endpointId: result.ring.endpointId,
          alreadyJoined: result.alreadyJoined,
        };
      }),
      key: {
        add: rpc.consumer.key.add.handler(({ input }) => {
          const result = addKey(input.key, input.providerRef, host.consumersRoot);
          return { alias: result.ring.alias, added: result.added };
        }),
      },
      ports: {
        list: rpc.consumer.ports.list.handler(() => {
          const { rings } = listKeyrings(host.consumersRoot);
          return {
            providers: rings.map((ring) => ({
              alias: ring.alias,
              endpointId: ring.endpointId,
              services: ring.services.map((s) => ({
                serviceId: s.serviceId,
                name: s.name,
                port: ring.ports[s.serviceId] ?? s.defaultPort,
                defaultPort: s.defaultPort,
                pinned: ring.ports[s.serviceId] !== undefined,
              })),
            })),
          };
        }),
        set: rpc.consumer.ports.set.handler(async ({ input }) => {
          const { rings } = listKeyrings(host.consumersRoot);
          const owner = rings.find((r) => r.services.some((s) => s.serviceId === input.serviceId));
          if (owner === undefined) {
            throw new DomainError("NOT_FOUND", `error: unknown service '${input.serviceId}'`);
          }
          setPort(host.consumersRoot, owner.endpointId, input.serviceId, input.port);
          await host.reloadGateway();
          return { alias: owner.alias, serviceId: input.serviceId, port: input.port };
        }),
      },
      status: rpc.consumer.status.handler(() => {
        const engine = host.consumerEngine();
        if (engine === null) {
          const { rings } = listKeyrings(host.consumersRoot);
          return {
            gatewayRunning: false,
            providers: rings.map((ring) => ({
              endpointId: ring.endpointId,
              alias: ring.alias,
              state: "stopped" as const,
              services: ring.services,
              ports: Object.fromEntries(
                ring.services.map((s) => [s.serviceId, ring.ports[s.serviceId] ?? s.defaultPort]),
              ),
              servedCount: 0,
              bufferOverflows: 0,
            })),
          };
        }
        return {
          gatewayRunning: true,
          providers: engine.manager.snapshot().map((s) => ({
            endpointId: s.endpointId,
            alias: s.alias,
            state: s.state,
            services: s.services,
            ports: s.ports,
            servedCount: s.servedCount,
            bufferOverflows: s.bufferOverflows,
            ...(s.lastError !== undefined ? { lastError: s.lastError } : {}),
          })),
        };
      }),
      forget: rpc.consumer.forget.handler(async ({ input }) => {
        const { ring } = removeKeyring(host.consumersRoot, input.ref);
        await host.reloadGateway();
        return { alias: ring.alias, removed: true as const };
      }),
      gateway: {
        start: rpc.consumer.gateway.start.handler(async () => {
          await host.startGateway();
          return { running: true as const };
        }),
        stop: rpc.consumer.gateway.stop.handler(async () => {
          await host.stopGateway();
          return { running: false as const };
        }),
      },
    },
    presets: {
      list: rpc.presets.list.handler(async ({ input }) => {
        const curated = loadCuratedPresets();
        const settings = loadSettings(home());
        if (input.includeModelsDev === false || !settings.modelsDevEnabled) {
          return {
            curated,
            modelsDev: [],
            ...(input.includeModelsDev === false
              ? {}
              : { modelsDevError: "models.dev expansion is disabled in settings" }),
          };
        }
        const result = await fetchModelsDevPresets(curated, {
          cachePath: modelsDevCachePath(home()),
        });
        return {
          curated,
          modelsDev: result.presets,
          ...(result.error !== undefined ? { modelsDevError: result.error } : {}),
        };
      }),
      applyAsService: rpc.presets.applyAsService.handler(({ input }) => {
        const curated = loadCuratedPresets();
        const preset = curated.find((p) => p.id === input.presetId);
        if (preset === undefined) {
          throw new DomainError("NOT_FOUND", `error: unknown preset '${input.presetId}'`);
        }
        const { serviceInput, envHint } = presetToServiceInput(preset, input);
        const service: ServiceConfig = host.providerStore().addService(serviceInput);
        return { service, ...(envHint !== undefined ? { envHint } : {}) };
      }),
      // 占位：m3 MODELS-TEST 车道替换为真实实现（models.dev models 解析 + 价格排序）
      models: rpc.presets.models.handler(() => {
        throw new DomainError("INVALID_STATE", "model catalog is not wired yet");
      }),
    },
    writers: {
      preview: rpc.writers.preview.handler(({ input }) => {
        const target = resolveWriterTarget(input.target.serviceId, input.target.port);
        const preview = previewWriter(input.agent, target, { home: home() });
        return {
          agent: preview.agent,
          path: preview.path,
          exists: preview.exists,
          baseUrl: preview.baseUrl,
          diff: preview.diff,
          confirmToken: preview.confirmToken,
        };
      }),
      apply: rpc.writers.apply.handler(({ input }) => {
        const target = resolveWriterTarget(input.target.serviceId, input.target.port);
        const result = applyWriter(input.agent, target, input.confirmToken, { home: home() });
        return { agent: result.agent, path: result.path, written: true as const };
      }),
    },
    system: {
      settings: {
        get: rpc.system.settings.get.handler(() => loadSettings(home())),
        set: rpc.system.settings.set.handler(({ input }) => saveSettings(input, home())),
      },
      notifyChannels: rpc.system.notifyChannels.handler(() => ({
        rpcPath: "/ws/rpc" as const,
        notifyPath: "/ws/notify" as const,
      })),
    },
  });
}
