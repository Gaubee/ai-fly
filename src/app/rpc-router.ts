// 共享契约的实现（implement）：每个过程转发 M1 引擎模块（store/engine/
// startProviderDaemon/link/join/...），不复制业务逻辑；变更操作走引擎同款校验
// （复用 M1 模块）；统一 DomainError→ORPCError 边界（skill-creator-v2 同款
// router 根中间件，仅此处转换一次）。文案英文 ASCII。
// 正交意图：传输/门禁/静态托管在 web-server.ts；引擎生命周期在 engine-host.ts。

import { implement, ORPCError } from "@orpc/server";
import { homedir } from "node:os";
import { RpcErrorDefinitions, rpcContract, routeLocalPrefix } from "../shared/rpc-contract.ts";
import type { Preset } from "../shared/rpc-contract.ts";
import { DomainError, toDomainError } from "./errors.ts";
import type { EngineHost } from "./engine-host.ts";
import { buildShareLink, previewShareLink, SHARE_TTL_DEFAULT_MS } from "../provider/link.ts";
import { parseUpstreamUrl, StoreError } from "../provider/store.ts";
import type { KeyRecord, ServiceConfig, ServiceInput } from "../provider/store.ts";
import { SecretsStore } from "../provider/secrets.ts";
import { probeUpstreamModels, testUpstream, pickDefaultModel } from "../provider/upstream-test.ts";
import { importLink, joinDevice, addKey } from "../consumer/join.ts";
import { listKeyrings, removeKeyring, setPort, setProviderEnabled, setServiceEnabled } from "../consumer/store.ts";
import { testLocalService } from "../consumer/local-test.ts";
import { testServiceRoute } from "../provider/route-test.ts";
import { applyWriter, previewWriter } from "./writers/index.ts";
import { resolveTargetPort } from "./writers/common.ts";
import { loadSettings, saveSettings } from "./settings.ts";
import {
  discoverHooks,
  installUserHook,
  readHookScript,
  removeUserHook,
  scriptHasStageExports,
} from "../provider/hook.ts";
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
  name?: string;
  key?: string;
} {
  return {
    keyId: key.keyId,
    group: key.group,
    createdAt: key.createdAt,
    ...(key.revokedAt !== undefined ? { revokedAt: key.revokedAt } : {}),
    ...(key.name !== undefined ? { name: key.name } : {}),
    ...(key.key !== undefined ? { key: key.key } : {}),
  };
}

/** 预设 → 服务输入展开（applyAsService 核心：match 从 matchDomains 派生 suffix 规则）。
 * hooks-lifecycle 6.3（v2 直吐，删除临时映射）：
 * - 显式 secretName → auth.secret；
 * - preset.auth（{secret,bearer?} | {script,args?,bearer?}）原样透传为 auth 槽；
 * - 无 preset.auth 时 keyEnv 兜底 → auth.literal 的 `$env:<VAR>` 间接引用。
 * rust-fetch-sidecar（预设模式）：preset.hooks（{script, args?}）原样透传为
 * service.hooks 整段绑定（与 auth/逐槽互斥——preset.hooks 存在时不做 auth 装配）。
 * envHint 仅在 auth 实际走 keyEnv 路径时给出（$secret/脚本路径的值不在环境变量）。 */
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
  const presetMode = preset.hooks !== undefined;
  const viaKeyEnv =
    !presetMode && input.secretName === undefined && preset.auth === undefined && keyEnv !== undefined;
  let auth: ServiceInput["auth"];
  if (presetMode) {
    // 预设模式：auth 由整段脚本的 ① 导出承担（若有）——不做槽位装配。
  } else if (input.secretName !== undefined) {
    auth = { secret: input.secretName };
  } else if (preset.auth !== undefined) {
    auth = { ...preset.auth };
  } else if (viaKeyEnv) {
    auth = { literal: `$env:${keyEnv}` };
  }
  const serviceInput: ServiceInput = {
    name: input.name ?? preset.id,
    upstream: preset.baseUrl,
    match: preset.matchDomains.map((domain) => ({ type: "suffix" as const, value: domain })),
    ...(preset.routes !== undefined && preset.routes.length > 0 ? { routes: preset.routes } : {}),
    ...(input.port !== undefined ? { defaultPort: input.port } : { defaultPort: preset.defaultPort }),
    ...(auth !== undefined ? { auth } : {}),
    ...(presetMode ? { hooks: { ...preset.hooks! } } : {}),
  };
  const envHint = viaKeyEnv
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
        return resolveTargetPort(port, service.detail?.routes);
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
            ...(input.auth !== undefined ? { auth: input.auth } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            secretsStore: SecretsStore.open(host.providerDataDir),
            modelsRaw: readModelsDevRaw(modelsDevCachePath(home())),
          });
        }),
        list: rpc.provider.services.list.handler(() => {
          const store = host.providerStore();
          // legacy（pre-v2）态：最小失效壳（仅 name + legacy 标记，供移除列表渲染；
          // hooks-lifecycle 2.3）。写操作经 store 单点门禁自然拒绝（INVALID_STATE）。
          if (store.legacy !== null) {
            return {
              services: store.legacy.serviceNames.map((name) => ({ name, legacy: true as const })),
            };
          }
          return { services: store.listServices() };
        }),
        get: rpc.provider.services.get.handler(({ input }) => {
          const service = host.providerStore().getServiceByName(input.name);
          if (service === undefined) {
            throw new DomainError("NOT_FOUND", `error: service '${input.name}' not found`);
          }
          return service;
        }),
        add: rpc.provider.services.add.handler(({ input }) => {
          // 预设模式绑定校验（rust-fetch-sidecar）：整段脚本必须导出至少一个
          // 阶段函数（否则所有阶段回退缺省——绑定无意义）。
          if (input.hooks !== undefined && !scriptHasStageExports(input.hooks.script, { home: home() })) {
            throw new DomainError(
              "INVALID_INPUT",
              `error: hook script '${input.hooks.script}' exports no lifecycle stage function`,
            );
          }
          const service = host.providerStore().addService(input);
          return { service };
        }),
        remove: rpc.provider.services.remove.handler(({ input }) => {
          host.providerStore().removeService(input.name);
          return { removed: true as const };
        }),
        setRunning: rpc.provider.services.setRunning.handler(({ input }) => {
          const { changed } = host.providerStore().setServiceEnabled(input.serviceId, input.running);
          return { serviceId: input.serviceId, running: input.running, changed };
        }),
        // 提供方侧按标准路由测试（Owner 裁决 2026-09-11：与 connect ③ 同形态）：
        // 路由命中 + rewrite 注入 + 直打 upstream；模型缺省与消费侧同规（models.dev
        // 缓存按 upstream 命中取最便宜 chat）。
        testRoute: rpc.provider.services.testRoute.handler(async ({ input }) => {
          const service = host.providerStore().getServiceByName(input.name);
          if (service === undefined) {
            throw new DomainError("NOT_FOUND", `error: service '${input.name}' not found`);
          }
          let model = input.model;
          let modelSource: "explicit" | "models.dev" | "none" = model !== undefined ? "explicit" : "none";
          if (model === undefined) {
            const picked = pickDefaultModel(readModelsDevRaw(modelsDevCachePath(home())), service.upstream);
            if (picked !== undefined) {
              model = picked;
              modelSource = "models.dev";
            }
          }
          const secretsStore = SecretsStore.open(host.providerDataDir);
          const result = await testServiceRoute({
            service,
            form: input.form,
            ...(input.localPrefix !== undefined ? { localPrefix: input.localPrefix } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(input.content !== undefined ? { content: input.content } : {}),
            // 密钥原样值（Bearer 前缀由 auth 槽在 buildUpstreamRequest 头链内拼）。
            secrets: (name: string) => secretsStore.get(name),
            // home 贯穿（复核 R2-P1-B）：行内 test 与网关转发同一脚本库基准。
            home: home(),
          });
          return { ...result, ...(modelSource !== "none" ? { modelSource } : {}) };
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
          host.providerStore().issueKey(input.group, input.name),
        ),
        list: rpc.provider.keys.list.handler(() => ({
          keys: host.providerStore().listKeys().map(keyView),
        })),
        revoke: rpc.provider.keys.revoke.handler(({ input }) => ({
          key: keyView(host.providerStore().revokeKey(input.keyId)),
        })),
      },
      // hooks 脚本资源域（provider-local ~ ：管理面同 group/secret）。
      hooks: {
        // stages-only（codex R6 裁决）：阶段矩阵按导出的阶段函数名归类——旧导出名
        // （如 v1 authHeader）不在矩阵内，UI 按阶段过滤自然排除并提示重写。
        list: rpc.provider.hooks.list.handler(() => ({
          hooks: discoverHooks(home()).map((h) => ({ name: h.name, source: h.source, stages: h.stages })),
        })),
        get: rpc.provider.hooks.get.handler(({ input }) => {
          const found = readHookScript(input.name, home());
          if (found === undefined) {
            throw new DomainError("NOT_FOUND", `error: hook script '${input.name}' not found`);
          }
          return { name: input.name, source: found.source, path: found.path, content: found.content };
        }),
        add: rpc.provider.hooks.add.handler(({ input }) => {
          try {
            const installed = installUserHook(input.name, input.content, home());
            return { name: installed.name, path: installed.path, stages: installed.stages };
          } catch (err) {
            throw new DomainError("INVALID_INPUT", (err as Error).message);
          }
        }),
        remove: rpc.provider.hooks.remove.handler(({ input }) => {
          try {
            removeUserHook(input.name, home());
            return { removed: true as const };
          } catch (err) {
            const msg = (err as Error).message;
            throw new DomainError(
              msg.includes("not found") || msg.includes("builtin") ? "NOT_FOUND" : "INVALID_INPUT",
              msg,
            );
          }
        }),
      },
      // 密钥库（provider-local；直连 SecretsStore——无内存态，daemon 运行时写入即刻
      // 生效。remove 未命中 StoreError(not-found) -> NOT_FOUND；list 精确形状
      // {secrets:[{name,createdAt,updatedAt}],count}——值与 bearerPrefix 绝不出现）。
      secrets: {
        list: rpc.provider.secrets.list.handler(() => {
          const secrets = SecretsStore.open(host.providerDataDir).list();
          return { secrets, count: secrets.length };
        }),
        set: rpc.provider.secrets.set.handler(({ input }) => ({
          secret: SecretsStore.open(host.providerDataDir).set(input.name, input.value),
        })),
        remove: rpc.provider.secrets.remove.handler(({ input }) => {
          SecretsStore.open(host.providerDataDir).remove(input.name);
          return { removed: true as const };
        }),
      },
      share: {
        create: rpc.provider.share.create.handler(async ({ input }) => {
          // legacy 门禁前置（复核 R1-F6）：invite 是有外部副作用的资源（fabric
          // 配额/中继可达性），必须先于 store 拒绝——否则 key 签发失败时 invite
          // 已被消费。
          if (host.providerStore().legacy !== null) {
            throw new StoreError(
              "legacy_readonly",
              "error: provider store is legacy (pre-v2); remove legacy services and re-add before sharing",
            );
          }
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
            keyId: input.keyId,
            keyName: input.keyName,
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
          // legacy（pre-v2）存储态暴露（hooks-lifecycle 2.3；正式契约面归 5.1）。
          legacy: store.legacy,
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
        list: rpc.consumer.services.list.handler(() => {
          const { rings } = listKeyrings(host.consumersRoot);
          const engine = host.consumerEngine();
          const listening = new Set(engine?.gateway.listenerInfo().map((l) => `${l.providerId}/${l.serviceId}`) ?? []);
          return {
            providers: rings.map((ring) => {
              const disabled = new Set(ring.disabledServices);
              return {
                alias: ring.alias,
                endpointId: ring.endpointId,
                enabled: !ring.disabled,
                services: ring.services.map((s) => ({
                  serviceId: s.serviceId,
                  name: s.name,
                  port: ring.actualPorts[s.serviceId] ?? ring.ports[s.serviceId] ?? s.defaultPort,
                  enabled: !ring.disabled && !disabled.has(s.serviceId),
                  listening: listening.has(`${ring.endpointId}/${s.serviceId}`),
                })),
              };
            }),
          };
        }),
        setRunning: rpc.consumer.services.setRunning.handler(async ({ input }) => {
          const { ring, changed } = setServiceEnabled(host.consumersRoot, input.endpointId, input.serviceId, input.running);
          if (changed) await host.applyServiceEnabled(ring, input.serviceId, input.running);
          return { alias: ring.alias, serviceId: input.serviceId, running: input.running, changed };
        }),
        setProviderRunning: rpc.consumer.services.setProviderRunning.handler(async ({ input }) => {
          const { ring, changed } = setProviderEnabled(host.consumersRoot, input.endpointId, input.running);
          if (changed) await host.applyProviderEnabled(ring, input.running);
          return { alias: ring.alias, running: input.running, changed };
        }),
        remove: rpc.consumer.services.remove.handler(async ({ input }) => {
          const { ring, changed } = setServiceEnabled(host.consumersRoot, input.endpointId, input.serviceId, false);
          if (changed) await host.applyServiceEnabled(ring, input.serviceId, false);
          return { alias: ring.alias, serviceId: input.serviceId, removed: true as const };
        }),
        test: rpc.consumer.services.test.handler(async ({ input }) => {
          // 定位服务（keyring detail 持 upstream 与 routes）+ 端口（运行时实际监听
          // 优先；网关停止时用存储投影——fetch 的 ECONNREFUSED 即诚实信号）。
          const { rings } = listKeyrings(host.consumersRoot);
          let found: { port: number; upstream?: string; localPrefix?: string } | undefined;
          for (const ring of rings) {
            const service = ring.services.find((s) => s.serviceId === input.serviceId);
            if (service === undefined) continue;
            // 该标准路由规则的本地前缀（无路由服务 = legacy 透传，用规范前缀探测）
            const route = service.detail?.routes?.find((r) => r.forms.includes(input.form) && r.mode !== "pattern");
            found = {
              port: livePorts().get(service.serviceId) ?? ring.ports[service.serviceId] ?? service.defaultPort,
              ...(service.detail?.upstream !== undefined ? { upstream: service.detail.upstream } : {}),
              ...(route !== undefined ? { localPrefix: routeLocalPrefix(route) } : {}),
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
          const result = await testLocalService({
            port: found.port,
            form: input.form,
            // 端点路径：显式选择 > 该标准路由规则本地前缀 > 规范前缀
            ...(input.localPrefix !== undefined
              ? { localPrefix: input.localPrefix }
              : found.localPrefix !== undefined
                ? { localPrefix: found.localPrefix }
                : {}),
            ...(model !== undefined ? { model } : {}),
            ...(input.content !== undefined ? { content: input.content } : {}),
          });
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
