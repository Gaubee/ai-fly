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
import { parseUpstreamUrl } from "../provider/store.ts";
import type { KeyRecord, ServiceConfig, ServiceInput } from "../provider/store.ts";
import { SecretsStore } from "../provider/secrets.ts";
import { probeUpstreamModels, testUpstream, pickDefaultModel } from "../provider/upstream-test.ts";
import { importLink, joinDevice, addKey } from "../consumer/join.ts";
import { listKeyrings, removeKeyring, setPort } from "../consumer/store.ts";
import { testLocalService } from "../consumer/local-test.ts";
import { applyWriter, previewWriter } from "./writers/index.ts";
import { resolveTargetPort } from "./writers/common.ts";
import { loadSettings, saveSettings } from "./settings.ts";
import {
  deriveModels,
  fetchModelsDevPresets,
  fetchModelsDevRaw,
  loadCuratedPresets,
  modelsDevCachePath,
  readModelsDevRaw,
  type ModelCatalogEntry,
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

/** 预设 → 服务输入展开（applyAsService 核心：match 从 matchDomains 派生 suffix 规则；
 * 密钥注入 secretName 优先——rewrite 写 `$secret:<name>`；否则 keyEnv 建议 `$env:<VAR>`）。
 * envHint 仅在走 $env 时给出（$secret 路径的值在密钥库，无环境变量导出建议）。 */
export function presetToServiceInput(
  preset: Preset,
  input: {
    name?: string | undefined;
    port?: number | undefined;
    keyEnv?: string | undefined;
    secretName?: string | undefined;
  },
): { serviceInput: ServiceInput; envHint?: string } {
  const keyEnv = input.keyEnv ?? preset.keyEnv;
  const serviceInput: ServiceInput = {
    name: input.name ?? preset.id,
    upstream: preset.baseUrl,
    match: preset.matchDomains.map((domain) => ({ type: "suffix" as const, value: domain })),
    ...(preset.routes !== undefined && preset.routes.length > 0 ? { routes: preset.routes } : {}),
    ...(input.port !== undefined ? { defaultPort: input.port } : { defaultPort: preset.defaultPort }),
    ...(input.secretName !== undefined
      ? { rewrite: { headerSet: { authorization: `$secret:${input.secretName}` } } }
      : keyEnv !== undefined
        ? { rewrite: { headerSet: { authorization: `$env:${keyEnv}` } } }
        : {}),
  };
  const envHint =
    input.secretName === undefined && keyEnv !== undefined
      ? `export ${keyEnv}='Bearer <your-api-key>' (full header value; the provider injects it upstream)`
      : undefined;
  return { serviceInput, ...(envHint !== undefined ? { envHint } : {}) };
}

/** 把契约绑定到引擎宿主，单一错误边界。 */
export function createRpcRouter(deps: RpcRouterDeps) {
  const host = deps.host;
  const home = (): string => deps.home ?? homedir();

  /** 写手目标解析：serviceId → 消费方存储端口（pinned > default）与已声明路由
      （detail.routes → 各标准本地 base）；显式 port 直用（无路由信息）。 */
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
        // 端口：网关实际监听优先（auto-assign 后存储投影不可信），回退 keyring 投影
        const port = livePorts().get(service.serviceId) ?? ring.ports[service.serviceId] ?? service.defaultPort;
        return resolveTargetPort(port, service.detail?.routes?.map((r) => r.form));
      }
    }
    throw new DomainError("NOT_FOUND", `error: unknown service '${serviceId}'`);
  };

  /** 网关实际监听端口表（M3-r4：auto-assign 后 keyring 投影不可信；
      无引擎/未监听时为空表，调用方回退存储投影）。 */
  const livePorts = (): Map<string, number> => {
    const map = new Map<string, number>();
    const engine = host.consumerEngine();
    if (engine === null) return map;
    for (const info of engine.gateway.listenerInfo()) map.set(info.serviceId, info.port);
    return map;
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
        // 上游连通性测试（provider-local、不落盘、不计限额；失败以结果对象返回）。
        // upstream 须 http(s) 且无 userinfo/query/fragment（parseUpstreamUrl ->
        // StoreError(invalid) -> INVALID_INPUT）；模型缺省从 models.dev 缓存取
        // priced chat 最低价（只读缓存，不为此发起刷新）。
        test: rpc.provider.services.test.handler(async ({ input }) => {
          parseUpstreamUrl(input.upstream);
          return testUpstream({
            upstream: input.upstream,
            ...(input.apiForm !== undefined ? { apiForm: input.apiForm } : {}),
            ...(input.secretName !== undefined ? { secretName: input.secretName } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            secretsStore: SecretsStore.open(host.providerDataDir),
            modelsRaw: readModelsDevRaw(modelsDevCachePath(home())),
          });
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
        setLimits: rpc.provider.groups.setLimits.handler(({ input }) => {
          const group = host.providerStore().setGroupLimits(input.name, input.limits);
          return { group };
        }),
        remove: rpc.provider.groups.remove.handler(({ input }) => {
          host.providerStore().removeGroup(input.name);
          return { removed: true as const };
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
      // 密钥库（provider-local；直连 SecretsStore——无内存态，daemon 运行时写入即刻
      // 生效。remove 未命中 StoreError(not-found) -> NOT_FOUND；list 投影名称/开关/时间戳）。
      secrets: {
        list: rpc.provider.secrets.list.handler(() => ({
          secrets: SecretsStore.open(host.providerDataDir).list(),
        })),
        set: rpc.provider.secrets.set.handler(({ input }) => ({
          secret: SecretsStore.open(host.providerDataDir).set(input.name, input.value, {
            ...(input.bearerPrefix !== undefined ? { bearerPrefix: input.bearerPrefix } : {}),
          }),
        })),
        remove: rpc.provider.secrets.remove.handler(({ input }) => {
          SecretsStore.open(host.providerDataDir).remove(input.name);
          return { removed: true as const };
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
      services: {
        test: rpc.consumer.services.test.handler(async ({ input }) => {
          // 定位服务（keyring detail 持 upstream 与 routes）+ 端口（运行时实际监听
          // 优先；网关停止时用存储投影——fetch 的 ECONNREFUSED 即诚实信号）。
          const { rings } = listKeyrings(host.consumersRoot);
          let found: { port: number; upstream?: string } | undefined;
          for (const ring of rings) {
            const service = ring.services.find((s) => s.serviceId === input.serviceId);
            if (service === undefined) continue;
            found = {
              port: livePorts().get(service.serviceId) ?? ring.ports[service.serviceId] ?? service.defaultPort,
              ...(service.detail?.upstream !== undefined ? { upstream: service.detail.upstream } : {}),
            };
            break;
          }
          if (found === undefined) {
            throw new DomainError("NOT_FOUND", `error: unknown service '${input.serviceId}'`);
          }
          // 模型缺省：models.dev 缓存按 detail.upstream 主机名命中，取最便宜 chat
          let model = input.model;
          let modelSource: "explicit" | "models.dev" | "none" = model !== undefined ? "explicit" : "none";
          if (model === undefined && found.upstream !== undefined) {
            const raw = readModelsDevRaw(modelsDevCachePath(home()));
            const picked = pickDefaultModel(raw, found.upstream);
            if (picked !== undefined) {
              model = picked;
              modelSource = "models.dev";
            }
          }
          const result = await testLocalService({ port: found.port, form: input.form, ...(model !== undefined ? { model } : {}) });
          return {
            ...result,
            ...(modelSource !== "none" ? { modelSource } : {}),
          };
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
          providers: engine.manager.snapshot().map((s) => {
            // M3-r4：端口以网关实际监听为准（auto-assign 后 keyring 投影会失真）
            const live = livePorts();
            return {
              endpointId: s.endpointId,
              alias: s.alias,
              state: s.state,
              services: s.services,
              ports: Object.fromEntries(
                s.services.map((svc) => [svc.serviceId, live.get(svc.serviceId) ?? s.ports[svc.serviceId] ?? svc.defaultPort]),
              ),
              servedCount: s.servedCount,
              bufferOverflows: s.bufferOverflows,
              ...(s.lastError !== undefined ? { lastError: s.lastError } : {}),
            };
          }),
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
      // 模型清单（models.dev 缓存）：精选 presetId 先按 [id, iconId?] 顺序查
      // provider 键（变体条目如 zai-coding 经 iconId=zai 命中；gemini 经 iconId=google
      // 命中），长尾 presetId 即 models.dev provider id。缓存未命中/过期先刷新
      // （modelsDevEnabled 关闭时不发网络，只读缓存），失败回退缓存并附错误说明。
      models: rpc.presets.models.handler(async ({ input }) => {
        // 自定义上游（无 presetId）：实时探测 {upstream}/models（OpenAI 兼容中转站
        // 不在 models.dev 覆盖内；Owner 2026-09-10 验收场景）。便宜档启发式排前。
        if (input.upstream !== undefined) {
          parseUpstreamUrl(input.upstream);
          const ids = await probeUpstreamModels({
            upstream: input.upstream,
            ...(input.secretName !== undefined ? { secretName: input.secretName } : {}),
            secretsStore: SecretsStore.open(host.providerDataDir),
          });
          if (ids === undefined) {
            return {
              models: [],
              error: "upstream /models probe failed - check the api key and network, or pick a model manually",
            };
          }
          return { models: ids.map((id) => ({ id, priced: false, chat: true })) };
        }
        const cachePath = modelsDevCachePath(home());
        let raw: string | undefined;
        let error: string | undefined;
        if (loadSettings(home()).modelsDevEnabled) {
          // TTL 内命中直接回缓存（零网络）；过期/未命中才刷新、失败回退缓存。
          const result = await fetchModelsDevRaw({ cachePath });
          raw = result.raw;
          error = result.error;
        } else {
          raw = readModelsDevRaw(cachePath);
          if (raw === undefined) {
            error = "models.dev is disabled in settings and no cache is available";
          }
        }
        if (raw === undefined) {
          return { models: [], ...(error !== undefined ? { error } : {}) };
        }
        const presetId = input.presetId!;
        const preset = loadCuratedPresets().find((p) => p.id === presetId);
        const keys =
          preset !== undefined
            ? [
                preset.id,
                ...(preset.iconId !== undefined && preset.iconId !== preset.id
                  ? [preset.iconId]
                  : []),
              ]
            : [presetId];
        let models: ModelCatalogEntry[] | undefined;
        for (const key of keys) {
          models = deriveModels(raw, key);
          if (models !== undefined) break;
        }
        if (models === undefined) {
          return {
            models: [],
            error: error ?? `no models.dev catalog for '${presetId}'`,
          };
        }
        return { models, ...(error !== undefined ? { error } : {}) };
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
