// 应用状态中枢（B 3.1/3.4）：通知驱动 + 脏区拉取。
// 正交意图：
// - 事件 → 标脏 →（去抖 180ms）拉取对应 status；通知仅为触发器，快照是
//   唯一事实源（与 engine-host 轮询桥同语义）。
// - 断线对账：rpc/notify 通道任一重连成功（open-with-reopen 与 __reconcile）
//   都触发全量标脏。
// - 状态拉取失败静默（后台拉取；传输层故障由连接横幅表达），不刷屏 toast。
import type { RpcClient } from "$lib/rpc-client";
import { toRpcError } from "$lib/rpc-client";
import { connection } from "./rpc.svelte.ts";
import { toast } from "./toast.svelte.ts";
import type {
  GroupView,
  KeyView,
  Preset,
  Settings,
  ServiceConfigView,
} from "$shared/rpc-contract.ts";

// 契约输出视图（从 client 过程签名推导，保持与契约单源）
type Out<Fn> = Fn extends (...args: never[]) => Promise<infer R> ? R : never;
export type ProviderStatusView = Out<RpcClient["provider"]["status"]>;
export type ConsumerStatusView = Out<RpcClient["consumer"]["status"]>;
export type ConsumerProviderView = ConsumerStatusView["providers"][number];
export type PortsListView = Out<RpcClient["consumer"]["ports"]["list"]>;
export type PortsProviderRow = PortsListView["providers"][number];
export type PortServiceRow = PortsProviderRow["services"][number];
/** consumer.services.list 视图（service-lifecycle：enabled/listening 驱动端口表）。 */
export type ConsumerServicesListView = Out<RpcClient["consumer"]["services"]["list"]>;
export type ConsumerServicesProviderRow = ConsumerServicesListView["providers"][number];
export type ConsumerServiceEntry = ConsumerServicesProviderRow["services"][number];

/** 全部状态区（脏标记粒度）。 */
type Section =
  | "provider"
  | "consumer"
  | "ports"
  | "cservices"
  | "groups"
  | "keys"
  | "services"
  | "settings";

const ALL_SECTIONS: readonly Section[] = [
  "provider",
  "consumer",
  "ports",
  "cservices",
  "groups",
  "keys",
  "services",
  "settings",
];

/** 引擎通知类型 → 需要重拉的状态区（A 车道 19 过程 / 11 事件对照）。 */
const SECTION_BY_EVENT: Readonly<Record<string, readonly Section[]>> = {
  "provider-daemon": ["provider"],
  "provider-session": ["provider"],
  "provider-roster": ["provider"],
  "provider-relay": ["provider"],
  "provider-store": ["provider", "services", "groups", "keys"],
  "consumer-gateway": ["consumer", "ports", "cservices"],
  "consumer-state": ["consumer"],
  "consumer-ports": ["ports", "consumer", "cservices"],
  "consumer-catalog": ["consumer", "ports", "cservices"],
};

/** 应用快照（$state 代理；页面直接读取）。 */
export const app = $state({
  /** 首轮拉取完成（连接横幅/空态判定用）。 */
  ready: false,
  provider: null as ProviderStatusView | null,
  consumer: null as ConsumerStatusView | null,
  ports: [] as PortsProviderRow[],
  /** consumer.services.list（生命周期视图：enabled/listening）。 */
  cservices: [] as ConsumerServicesProviderRow[],
  groups: [] as GroupView[],
  keys: [] as KeyView[],
  services: [] as ServiceConfigView[],
  settings: null as Settings | null,
  /** 各区在途标记（skeleton 消费）。 */
  busy: { provider: false, consumer: false, ports: false, cservices: false, groups: false, keys: false, services: false, settings: false } as Record<Section, boolean>,
});

const dirty = new Set<Section>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function markDirty(...sections: Section[]): void {
  for (const section of sections) dirty.add(section);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer === null) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, 180);
  }
}

/** 立即冲刷挂起的脏区（向导等需要同步结果的场景）；返回的 Promise 在
    本轮（含去重续拉）全部落定后 resolve——`await refresh()` 由此变为真等待。 */
export function flushNow(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  return flush();
}

/** 显式请求某区刷新（按钮触发 RPC 后调用；引擎通知也会到，双保险）。
    可等待：resolve 时请求的区已反映最新引擎状态（在途去重的续拉也收敛）。 */
export function refresh(...sections: Section[]): Promise<void> {
  markDirty(...sections);
  return flushNow();
}

const inflight = new Map<Section, Promise<void>>();

async function pull(section: Section): Promise<void> {
  const running = inflight.get(section);
  if (running !== undefined) {
    // 在途去重但不丢更新：重新标脏并等在途结束，由本轮 flush 的续拉消费
    dirty.add(section);
    await running;
    return;
  }
  app.busy[section] = true;
  const task = (async () => {
    switch (section) {
      case "provider":
        app.provider = await connection.call((c) => c.provider.status({}));
        break;
      case "consumer":
        app.consumer = await connection.call((c) => c.consumer.status({}));
        break;
      case "ports":
        app.ports = (await connection.call((c) => c.consumer.ports.list({}))).providers;
        break;
      case "cservices":
        app.cservices = (await connection.call((c) => c.consumer.services.list({}))).providers;
        break;
      case "groups":
        app.groups = (await connection.call((c) => c.provider.groups.list({}))).groups;
        break;
      case "keys":
        app.keys = (await connection.call((c) => c.provider.keys.list({}))).keys;
        break;
      case "services":
        app.services = (await connection.call((c) => c.provider.services.list({}))).services;
        break;
      case "settings":
        app.settings = await connection.call((c) => c.system.settings.get({}));
        break;
    }
  })();
  inflight.set(section, task);
  try {
    await task;
  } catch (error) {
    // 后台拉取失败静默（断连时横幅已表达；恢复后 __reconcile 会补拉）
    void toRpcError(error);
  } finally {
    inflight.delete(section);
    app.busy[section] = false;
  }
}

async function flush(): Promise<void> {
  const sections = [...dirty];
  dirty.clear();
  await Promise.allSettled(sections.map((section) => pull(section)));
  if (sections.length > 0) app.ready = true;
  // 在途去重重排的脏区就地续拉（pull 已 await 在途者，无自旋）
  if (dirty.size > 0) await flush();
}

/** 通知事件 → toast（警示类）或标脏（状态类）。 */
function onNotifyEvent(event: { type: string; payload: Record<string, unknown> }): void {
  if (event.type === "__reconcile") {
    markDirty(...ALL_SECTIONS);
    return;
  }
  if (event.type === "consumer-warning" || event.type === "consumer-notice") {
    const message = typeof event.payload.message === "string" ? event.payload.message : event.type;
    toast.api.push({
      title: event.type === "consumer-warning" ? "Consumer warning" : "Consumer notice",
      description: message,
      variant: "tonal",
      ...(event.type === "consumer-warning" ? { class: "jx-hue-warning" } : {}),
    });
    markDirty("consumer");
    return;
  }
  const sections = SECTION_BY_EVENT[event.type];
  if (sections !== undefined) markDirty(...sections);
}

/** App 挂载时启动（幂等）：接状态回调、订阅通知、首轮全量拉取。 */
export function startApp(): void {
  if (started) return;
  started = true;
  connection.onStatus((status) => {
    // rpc 通道每次打开（含重连）都全量对账
    if (status === "open") markDirty(...ALL_SECTIONS);
  });
  connection.subscribeNotify(onNotifyEvent);
  markDirty(...ALL_SECTIONS);
  void flushNow();
}

// ---------------------------------------------------------------------------
// 预设清单（分享向导消费；独立于脏区——低频、向导进入时拉取）
// ---------------------------------------------------------------------------

export const presets = $state({
  loading: false,
  error: null as string | null,
  curated: [] as Preset[],
  modelsDev: [] as Preset[],
  modelsDevError: undefined as string | undefined,
});

/** 拉取预设合流（本地运行时排前的排序在组件 $derived 里做）。 */
export async function loadPresets(): Promise<void> {
  if (presets.loading) return;
  presets.loading = true;
  presets.error = null;
  try {
    const result = await connection.call((c) => c.presets.list({}));
    presets.curated = result.curated;
    presets.modelsDev = result.modelsDev;
    presets.modelsDevError = result.modelsDevError;
  } catch (error) {
    presets.error = toRpcError(error).message;
  } finally {
    presets.loading = false;
  }
}

/** 本地运行时预设排前（127.0.0.1/localhost 的 baseUrl 优先）。 */
export function isLocalPreset(preset: Preset): boolean {
  return /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(preset.baseUrl);
}
