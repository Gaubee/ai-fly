// 使用方接入向导状态机（B 3.3，#/connect 三步）：
// ①粘贴链接（离线 preview：别名/分组/服务表）→ ②端口确认（apply 即导入+
// 网关启动；实际端口表 + 冲突自动错开标注 + 可改）→ ③test（M3-r8 Owner
// 裁决：agent setup 步本身不该存在——选协议、选端点、单输入框（默认 hi）
// 发真实 AI 请求；不写任何 agent 配置）。
// 每步可回退（apply 之后回退到①仅重看 preview，不重复导入）。
import { toRpcError, type RpcError } from "$lib/rpc-client";
import type { RouteForm } from "$shared/rpc-contract.ts";
import type { RpcClient } from "$lib/rpc-client";
import { call } from "./rpc.svelte.ts";
import { toastRpcError, toastSuccess } from "./toast.svelte.ts";
import { refresh } from "./app.svelte.ts";

type Out<Fn> = Fn extends (...args: never[]) => Promise<infer R> ? R : never;
export type ImportPreviewView = Out<RpcClient["consumer"]["import"]["preview"]>;
export type ImportApplyView = Out<RpcClient["consumer"]["import"]["apply"]>;
export type RouteTestOutput = Out<RpcClient["consumer"]["services"]["test"]>;

/**
 * 消费侧服务条目 detail.routes 的手写镜像（wire 形状见 SERVICE_ENTRY_SCHEMA；
 * 不引 zod）。import.apply 输出不带 detail，路由披露经 consumer.status 的
 * 服务条目携带——refreshImportedPorts 顺带捕获成 serviceId → routes 表。
 */
export interface ServiceRouteView {
  /** 该规则承载的 API 标准（AI 层标注；可为空 = 未标注的通用规则）。 */
  forms: RouteForm[];
  mode?: "prefix" | "pattern" | undefined;
  localPrefix?: string | undefined;
  upstreamPrefix?: string | undefined;
  matchPattern?: string | undefined;
  template?: string | undefined;
}

/** 测试请求协议（③ 步「选择协议」——描述发送什么形状的请求，非服务属性）。 */
export const PROTOCOL_OPTIONS: ReadonlyArray<{ value: RouteForm; label: string }> = [
  { value: "openai-chat", label: "openai" },
  { value: "openai-responses", label: "openai responses" },
  { value: "anthropic", label: "anthropic" },
];

/** 兑换/直连失败的补充指引（DIAL_TIMEOUT 类错误的英文指引）。 */
export function dialGuidance(error: RpcError): string | null {
  const text = `${error.code} ${error.message}`.toLowerCase();
  if (/dial|timeout|timed out|unreachable|relay/.test(text)) {
    return "The provider could not be reached. Ask your friend to keep ai-fly running (tray -> open window), then try again. If the problem persists, check the relay entry in Advanced -> Relay.";
  }
  return null;
}

/** ② 端口行（合并 ports.list 的 pinned/default 与 status 的实际监听端口）。 */
export interface PortRowView {
  serviceId: string;
  name: string;
  defaultPort: number;
  /** 实际端口（网关运行时为监听端口；停止时为 pinned/default 投影）。 */
  port: number;
  pinned: boolean;
  /** 实际端口偏离 defaultPort：冲突被引擎自动错开。 */
  autoShifted: boolean;
}

export const connectW = $state({
  step: 1 as 1 | 2 | 3,
  // ①
  link: "",
  previewBusy: false,
  previewError: null as RpcError | null,
  preview: null as ImportPreviewView | null,
  // ②
  applyBusy: false,
  applyError: null as RpcError | null,
  applied: null as ImportApplyView | null,
  gatewayStarted: false,
  ports: [] as PortRowView[],
  portsBusy: false,
  /** serviceId → 端口编辑输入。 */
  portDraft: {} as Record<string, string>,
  portBusy: "",
  portError: null as RpcError | null,
  // ③ test（M3-r8）
  /** 测试目标服务。 */
  testServiceId: "",
  /** 测试请求协议。 */
  testProtocol: "openai-chat" as RouteForm,
  /** 测试端点路径（prefix 路由的 localPrefix；"" = 根/legacy 透传）。 */
  testEndpoint: "",
  /** 单轮提示词（默认 "hi"；不允许多轮）。 */
  testPrompt: "hi",
  testBusy: false,
  testResult: null as RouteTestOutput | null,
  // ③（M3-r4）按标准路由披露
  /** serviceId → 声明的路径路由（来自 consumer.status 的服务条目 detail）。 */
  serviceRoutes: {} as Record<string, ServiceRouteView[]>,
  /** serviceId → detail.upstream（端点选项「转发到哪」注记）。 */
  serviceUpstream: {} as Record<string, string>,
});

/** 重置向导。 */
export function resetConnect(): void {
  connectW.step = 1;
  connectW.link = "";
  connectW.previewBusy = false;
  connectW.previewError = null;
  connectW.preview = null;
  connectW.applyBusy = false;
  connectW.applyError = null;
  connectW.applied = null;
  connectW.gatewayStarted = false;
  connectW.ports = [];
  connectW.portsBusy = false;
  connectW.portDraft = {};
  connectW.portBusy = "";
  connectW.portError = null;
  connectW.testServiceId = "";
  connectW.testProtocol = "openai-chat";
  connectW.testEndpoint = "";
  connectW.testPrompt = "hi";
  connectW.testBusy = false;
  connectW.testResult = null;
  connectW.serviceRoutes = {};
  connectW.serviceUpstream = {};
}

/** ① 预览（离线解析，坏链接就地报错）。 */
export async function previewLink(): Promise<void> {
  const raw = connectW.link.trim();
  if (raw === "" || connectW.previewBusy) return;
  connectW.previewBusy = true;
  connectW.previewError = null;
  connectW.preview = null;
  try {
    connectW.preview = await call((c) => c.consumer.import.preview({ link: raw }));
  } catch (error) {
    connectW.previewError = toRpcError(error);
  } finally {
    connectW.previewBusy = false;
  }
}

/** ② 前进（预览成功后）。 */
export function previewNext(): void {
  if (connectW.preview === null) return;
  connectW.applyError = null;
  connectW.step = 2;
}

/** 回退。 */
export function connectBack(): void {
  if (connectW.step <= 1) return;
  connectW.step = (connectW.step - 1) as 1 | 2;
  connectW.testResult = null;
  connectW.portError = null;
}

/**
 * 刷新已导入提供者的端口行（ports.list + consumer.status 合并）。
 * 页面在 consumer-* 通知到达时也调它：网关启动后端口被引擎自动错开，
 * 表格必须跟上（否则 auto-shifted 标注滞后）。
 */
export async function refreshWizardPorts(): Promise<void> {
  if (connectW.applied === null || connectW.portsBusy) return;
  connectW.portsBusy = true;
  try {
    await refreshImportedPorts(connectW.applied.endpointId);
  } catch {
    // 后台刷新失败静默（主链路由 applyImport 的显式调用兜底）
  } finally {
    connectW.portsBusy = false;
  }
}

/** 刷新已导入提供者的端口行（ports.list + consumer.status 合并）。 */
async function refreshImportedPorts(endpointId: string): Promise<void> {
  const [portsResult, statusResult] = await Promise.all([
    call((c) => c.consumer.ports.list({})),
    call((c) => c.consumer.status({})),
  ]);
  const storageRow = portsResult.providers.find((row) => row.endpointId === endpointId);
  const liveRow = statusResult.providers.find((row) => row.endpointId === endpointId);
  // M3-r4：status 的服务条目（wire ServiceEntry 形状）携带 detail.routes 披露
  // → 捕获成 serviceId → routes 表，③ 步端点区与可用性判定消费；
  // M3-r5：同时捕获 detail.upstream（端点行展示「转发到哪」的映射注记）
  const routesById: Record<string, ServiceRouteView[]> = {};
  const upstreamById: Record<string, string> = {};
  for (const service of liveRow?.services ?? []) {
    if (service.detail?.routes !== undefined) routesById[service.serviceId] = service.detail.routes;
    if (service.detail?.upstream !== undefined) upstreamById[service.serviceId] = service.detail.upstream;
  }
  connectW.serviceRoutes = routesById;
  connectW.serviceUpstream = upstreamById;
  const rows: PortRowView[] = (storageRow?.services ?? []).map((service) => {
    const port = liveRow?.ports[service.serviceId] ?? service.port;
    return {
      serviceId: service.serviceId,
      name: service.name,
      defaultPort: service.defaultPort,
      port,
      pinned: service.pinned,
      autoShifted: port !== service.defaultPort,
    };
  });
  connectW.ports = rows;
  for (const row of rows) {
    if (connectW.portDraft[row.serviceId] === undefined) {
      connectW.portDraft[row.serviceId] = String(row.port);
    }
  }
}

/**
 * ② 确认导入：apply（兑换 + 入环 + 引擎侧 reload）→ gateway.start（幂等；
 * 「apply 即完成导入+网关启动」无需另点 run）→ 端口表。
 */
export async function applyImport(): Promise<void> {
  if (connectW.applyBusy || connectW.preview === null) return;
  connectW.applyBusy = true;
  connectW.applyError = null;
  try {
    const applied = await call(
      (c) => c.consumer.import.apply({ link: connectW.link.trim() }),
      90_000, // fabric 兑换是长操作（直连/relay 拨号）
    );
    connectW.applied = applied;
    try {
      await call((c) => c.consumer.gateway.start({}));
      connectW.gatewayStarted = true;
    } catch {
      connectW.gatewayStarted = false; // 导入成功但网关未起：②表仍可用（存储投影）
    }
    await refreshImportedPorts(applied.endpointId);
    // ③ 默认：第一个服务 + 首个 prefix 路由端点
    connectW.testServiceId = applied.services[0]?.serviceId ?? "";
    connectW.testEndpoint = firstEndpointOf(connectW.testServiceId);
    toastSuccess("Imported", `Provider '${applied.alias}' is ready.`);
    refresh("consumer", "ports");
  } catch (error) {
    connectW.applyError = toRpcError(error);
    toastRpcError(connectW.applyError);
  } finally {
    connectW.applyBusy = false;
  }
}

/** 首个 prefix 路由端点；form 给定时优先承载该标准的规则（无路由 = ""，根透传）。 */
function firstEndpointOf(serviceId: string, form?: RouteForm): string {
  const prefixRoutes = (connectW.serviceRoutes[serviceId] ?? []).filter(
    (r) => r.mode !== "pattern" && (r.localPrefix ?? "") !== "",
  );
  const serving = form === undefined ? prefixRoutes : prefixRoutes.filter((r) => r.forms.includes(form));
  return (serving[0] ?? prefixRoutes[0])?.localPrefix ?? "";
}

/** ② → ③（进入时重刷端口——网关刚启动的 auto-assign 此时已生效）。 */
export function portsNext(): void {
  if (connectW.applied === null) return;
  connectW.step = 3;
  void refreshWizardPorts();
  connectW.testEndpoint = firstEndpointOf(connectW.testServiceId, connectW.testProtocol);
}

/** ② 改端口（pinned 持久化 + 网关重启生效）。 */
export async function setServicePort(serviceId: string): Promise<void> {
  const raw = connectW.portDraft[serviceId] ?? "";
  const port = Number.parseInt(raw.trim(), 10);
  connectW.portError = null;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    connectW.portError = { code: "INVALID_INPUT", message: "port must be an integer in 1..65535" };
    return;
  }
  connectW.portBusy = serviceId;
  try {
    await call((c) => c.consumer.ports.set({ serviceId, port }));
    if (connectW.applied !== null) {
      await refreshImportedPorts(connectW.applied.endpointId);
    }
    refresh("consumer", "ports");
    toastSuccess("Port updated", `${serviceId} -> ${port}`);
  } catch (error) {
    connectW.portError = toRpcError(error);
    toastRpcError(connectW.portError);
  } finally {
    connectW.portBusy = "";
  }
}

/** ③ 完成 → 通知刷新（Dashboard 引导按钮由页面渲染）。 */
export function finishConnect(): void {
  refresh("consumer", "ports");
}

/** ③ 换测试目标服务（端点重置到当前协议的首个承载路由，结果清空）。 */
export function setTestService(serviceId: string): void {
  connectW.testServiceId = serviceId;
  connectW.testEndpoint = firstEndpointOf(serviceId, connectW.testProtocol);
  connectW.testResult = null;
}

/**
 * ③ 换协议：当前端点不承载该标准时跳到首个承载端点（承载则保留——
 * 端点仍是自由选择，这里只修跨形态的明显错配，如 anthropic + /v1）。
 */
export function setTestProtocol(form: RouteForm): void {
  connectW.testProtocol = form;
  const routes = (connectW.serviceRoutes[connectW.testServiceId] ?? []).filter(
    (r) => r.mode !== "pattern" && (r.localPrefix ?? "") !== "",
  );
  const currentServes =
    routes.find((r) => r.localPrefix === connectW.testEndpoint)?.forms.includes(form) ?? false;
  if (!currentServes) {
    connectW.testEndpoint = firstEndpointOf(connectW.testServiceId, form);
  }
  connectW.testResult = null;
}

/**
 * ③ 发送测试请求（M3-r8：协议 + 端点 + 单轮提示词 → 真实 AI-API 请求，
 * 走完整 wire 链路）。RPC 层失败合成为 ok=false 结果就地展示；
 * 不发 toast——结果面板已是展示面。
 */
export async function sendTest(): Promise<void> {
  if (connectW.testBusy || connectW.testServiceId === "") return;
  connectW.testBusy = true;
  connectW.testResult = null;
  try {
    const content = connectW.testPrompt.trim() !== "" ? connectW.testPrompt : "hi";
    connectW.testResult = await call((c) =>
      c.consumer.services.test({
        serviceId: connectW.testServiceId,
        form: connectW.testProtocol,
        content,
        ...(connectW.testEndpoint !== "" ? { localPrefix: connectW.testEndpoint } : {}),
      }),
    );
  } catch (error) {
    connectW.testResult = {
      ok: false,
      latencyMs: 0,
      request: { method: "POST", url: "" },
      error: toRpcError(error).message,
    };
  } finally {
    connectW.testBusy = false;
  }
}
