// 使用方接入向导状态机（B 3.3，#/connect 三步）：
// ①粘贴链接（离线 preview：别名/分组/服务表）→ ②端口确认（apply 即导入+
// 网关启动；实际端口表 + 冲突自动错开标注 + 可改）→ ③Agent 配置（服务 +
// Agent 选择（NativeSelect，skip 永远可达）+ 按标准 API endpoints 呈现与
// 行内连通测试（M3-r4）→ writers.preview 渲染 diff → writers.apply 确认写入）。
// 每步可回退（apply 之后回退到①仅重看 preview，不重复导入）。
import { toRpcError, type RpcError } from "$lib/rpc-client";
import type { RouteForm, WriterAgent } from "$shared/rpc-contract.ts";
import type { RpcClient } from "$lib/rpc-client";
import { call } from "./rpc.svelte.ts";
import { toastRpcError, toastSuccess } from "./toast.svelte.ts";
import { refresh } from "./app.svelte.ts";

type Out<Fn> = Fn extends (...args: never[]) => Promise<infer R> ? R : never;
export type ImportPreviewView = Out<RpcClient["consumer"]["import"]["preview"]>;
export type ImportApplyView = Out<RpcClient["consumer"]["import"]["apply"]>;
export type WriterPreviewView = Out<RpcClient["writers"]["preview"]>;
export type RouteTestOutput = Out<RpcClient["consumer"]["services"]["test"]>;

/**
 * 消费侧服务条目 detail.routes 的手写镜像（wire 形状见 SERVICE_ENTRY_SCHEMA；
 * 不引 zod）。import.apply 输出不带 detail，路由披露经 consumer.status 的
 * 服务条目携带——refreshImportedPorts 顺带捕获成 serviceId → routes 表。
 */
export interface ServiceRouteView {
  form: RouteForm;
  upstreamPrefix: string;
}

/** Agent 清单（含 skip：仅导入，不写任何配置）。 */
export const AGENT_OPTIONS: ReadonlyArray<{ value: WriterAgent | "skip"; label: string }> = [
  { value: "codex", label: "codex" },
  { value: "claude-code", label: "claude code" },
  { value: "cursor", label: "cursor" },
  { value: "cline", label: "cline" },
  { value: "continue", label: "continue" },
  { value: "skip", label: "skip (configure agents later)" },
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
  // ③
  agent: "codex" as WriterAgent | "skip",
  agentServiceId: "",
  writerPreview: null as WriterPreviewView | null,
  writerBusy: false,
  writerApplyBusy: false,
  writerError: null as RpcError | null,
  writerDone: false,
  // ③（M3-r4）按标准路由与连通测试
  /** serviceId → 声明的按标准路由（缺项 = legacy 透传；来自 consumer.status 披露）。 */
  serviceRoutes: {} as Record<string, ServiceRouteView[]>,
  /** 连通测试在途的 form（null = 空闲；单飞防重入）。 */
  testBusy: null as RouteForm | null,
  /** 连通测试结果（per-form；RPC 层失败合成为 ok=false 结果就地展示）。 */
  testResults: {} as Partial<Record<RouteForm, RouteTestOutput>>,
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
  connectW.agent = "codex";
  connectW.agentServiceId = "";
  connectW.writerPreview = null;
  connectW.writerBusy = false;
  connectW.writerApplyBusy = false;
  connectW.writerError = null;
  connectW.writerDone = false;
  connectW.serviceRoutes = {};
  connectW.testBusy = null;
  connectW.testResults = {};
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
  connectW.writerError = null;
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
  // → 捕获成 serviceId → routes 表，③ 步端点区与可用性判定消费
  const routesById: Record<string, ServiceRouteView[]> = {};
  for (const service of liveRow?.services ?? []) {
    if (service.detail?.routes !== undefined) routesById[service.serviceId] = service.detail.routes;
  }
  connectW.serviceRoutes = routesById;
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
    // ③ 默认选第一个服务
    connectW.agentServiceId = applied.services[0]?.serviceId ?? "";
    toastSuccess("Imported", `Provider '${applied.alias}' is ready.`);
    refresh("consumer", "ports");
  } catch (error) {
    connectW.applyError = toRpcError(error);
    toastRpcError(connectW.applyError);
  } finally {
    connectW.applyBusy = false;
  }
}

/** ② → ③（进入时重刷端口——网关刚启动的 auto-assign 此时已生效）。 */
export function portsNext(): void {
  if (connectW.applied === null) return;
  connectW.step = 3;
  void refreshWizardPorts();
  void refreshWriterPreview();
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

/** ③ 重新渲染写手 diff（服务/Agent 变化时自动调）。 */
export async function refreshWriterPreview(): Promise<void> {
  if (connectW.agent === "skip" || connectW.agentServiceId === "") {
    connectW.writerPreview = null;
    return;
  }
  connectW.writerBusy = true;
  connectW.writerError = null;
  try {
    connectW.writerPreview = await call((c) =>
      c.writers.preview({
        agent: connectW.agent as WriterAgent,
        target: { serviceId: connectW.agentServiceId },
      }),
    );
  } catch (error) {
    connectW.writerPreview = null;
    connectW.writerError = toRpcError(error);
  } finally {
    connectW.writerBusy = false;
  }
}

/** ③ 确认写入（confirmToken 原样带回：只写用户看过的那份 diff）。 */
export async function applyWriter(): Promise<void> {
  const preview = connectW.writerPreview;
  if (connectW.writerApplyBusy || preview === null || connectW.agent === "skip") return;
  connectW.writerApplyBusy = true;
  connectW.writerError = null;
  try {
    const written = await call((c) =>
      c.writers.apply({
        agent: connectW.agent as WriterAgent,
        target: { serviceId: connectW.agentServiceId },
        confirmToken: preview.confirmToken,
      }),
    );
    connectW.writerDone = true;
    toastSuccess("Agent config written", `${written.agent} -> ${written.path}`);
  } catch (error) {
    connectW.writerError = toRpcError(error);
    toastRpcError(connectW.writerError);
  } finally {
    connectW.writerApplyBusy = false;
  }
}

/** ③ 完成（skip 或写完）→ 通知刷新（Dashboard 引导按钮由页面渲染）。 */
export function finishConnect(): void {
  refresh("consumer", "ports");
}

/**
 * ③ 按标准连通测试（M3-r4）：对本机网关端口走完整 wire 链路的最小请求。
 * RPC 层失败（网络/超时等，未拿到 test 输出）合成为 ok=false 结果就地展示；
 * 不发 toast——行内结果区已是展示面，避免双重噪音。
 */
export async function testServiceRoute(form: RouteForm): Promise<void> {
  if (connectW.testBusy !== null || connectW.agentServiceId === "") return;
  connectW.testBusy = form;
  connectW.testResults[form] = undefined; // 在途时清掉旧结果，避免陈旧 ok 残留
  try {
    connectW.testResults[form] = await call((c) =>
      c.consumer.services.test({ serviceId: connectW.agentServiceId, form }),
    );
  } catch (error) {
    connectW.testResults[form] = {
      ok: false,
      latencyMs: 0,
      request: { method: "POST", url: "" },
      error: toRpcError(error).message,
    };
  } finally {
    connectW.testBusy = null;
  }
}
