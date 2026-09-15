// 生命周期管线概念模型（hooks-lifecycle 任务 7.1，替代 auth-source.ts）：
// 「这个服务的请求怎么被加工」= 四阶段纵向管线 ①auth → ②headers →
// ③request → ④response（执行顺序 = STAGE_FN_NAMES 单源）。本模块持 UI ↔
// 契约槽位的全部互转：编辑回显（authSelFromService）、提交组装
// （authSlotFromSel / slotsFromScripts）、预设预选（authSelFromPreset）、
// 摘要与 detail 投影（authSelSummary / authDetailLine / maskHeaderValue）。
// keep 透传哨兵退役——auth 四族（none/secret/script/literal）+ bearer 单源
// 覆盖全部可产生形态；脚本 args 经表单 store 的 passthrough 透传（不在
// 本模块）。契约类型一律从 $shared/rpc-contract.ts 的 schema 推导
// （ServiceInputView = services.add 输入；ServiceConfigView = 落库视图），
// 不手写镜像，也不经 $lib/rpc-client（保持模块可进 node 侧单测程序）。

import {
  STAGE_FN_NAMES,
  type Preset,
  type ServiceConfigView,
  type ServiceInputView,
  type StageFnNameValue,
} from "$shared/rpc-contract.ts";

export type { StageFnNameValue };
export { STAGE_FN_NAMES };

/** 契约 auth 槽（{secret}|{script,args?}|{literal} + 可选 bearer）。 */
export type AuthSlot = NonNullable<ServiceInputView["auth"]>;
/** 契约 headers 槽（remove[] + set{} + 可选整段脚本）。 */
export type HeadersSlot = NonNullable<ServiceInputView["headers"]>;

/** services.list 条目（v2 全量配置 | legacy 最小失效壳——hooks-lifecycle 2.3）。 */
export type ServicesListEntry = ServiceConfigView | LegacyServiceShell;

/** legacy（pre-v2）存储态的最小失效壳（仅 name + legacy 标记，供移除列表）。 */
export interface LegacyServiceShell {
  name: string;
  legacy: true;
}

/** legacy 壳判定（services.list 联合类型的运行时分拣）。 */
export function isLegacyServiceShell(service: ServicesListEntry): service is LegacyServiceShell {
  return "legacy" in service;
}

/** v2 全量服务判定（legacy 壳分拣的另一面——filter 收窄用显式谓词：
 *  否定式匿名箭头函数不产生推断谓词）。 */
export function isFullService(
  service: ServicesListEntry,
): service is Exclude<ServicesListEntry, LegacyServiceShell> {
  return !("legacy" in service);
}

// ---------------------------------------------------------------------------
// 阶段词汇（hooks.list 阶段矩阵的 UI 投影）
// ---------------------------------------------------------------------------

/** 阶段短名（徽章/过滤器标签；技术词汇不进 locale）。 */
export const STAGE_LABELS: Readonly<Record<StageFnNameValue, string>> = {
  onRequestBearerAuthentication: "auth",
  onRequestHeaders: "headers",
  onRequest: "request",
  onResponse: "response",
};

/** hooks 页签行（stores/advanced 的 HookScriptRow 消费形状）。 */
export interface StageScriptRow {
  name: string;
  source: "user" | "builtin";
  stages: StageFnNameValue[];
}

/** 按阶段矩阵过滤脚本（hooks.list stages-only——旧导出名不在矩阵内自然排除）。 */
export function scriptsForStage(
  scripts: readonly StageScriptRow[],
  stage: StageFnNameValue,
): string[] {
  return scripts.filter((s) => s.stages.includes(stage)).map((s) => s.name);
}

/** 生命周期双模式（Owner 2026-09-15）：custom = 逐槽；preset = hooks 整段绑定。 */
export type LifecycleMode = "custom" | "preset";

/** 预设模式候选：至少导出一个阶段函数的脚本（整段绑定无意义者不列）。 */
export function presetEligibleScripts(scripts: readonly StageScriptRow[]): StageScriptRow[] {
  return scripts.filter((s) => s.stages.length > 0);
}

/** 指定脚本覆盖的阶段（徽章呈现；未知脚本返回空）。 */
export function coveredStagesOf(
  scripts: readonly StageScriptRow[],
  name: string,
): StageFnNameValue[] {
  return scripts.find((s) => s.name === name)?.stages ?? [];
}

// ---------------------------------------------------------------------------
// ① auth 阶段：四族单选 + bearer 开关（唯一 Bearer 前缀来源）
// ---------------------------------------------------------------------------

/** auth 阶段编辑器选择（none/secret/script/literal；keep 哨兵已退役）。 */
export type AuthStageSel =
  | { kind: "none" }
  | { kind: "secret"; name: string; bearer: boolean }
  | { kind: "script"; script: string; bearer: boolean }
  | { kind: "literal"; value: string; bearer: boolean };

/** 编辑回显：落库 auth 槽 → AuthStageSel（四族全覆盖，无兜底分支）。bearer
 *  缺省语义与运行时单源（rewrite.applyBearerPrefix）一致：省略 = true。 */
export function authSelFromService(service: ServiceConfigView): AuthStageSel {
  const auth = service.auth;
  if (auth === undefined) return { kind: "none" };
  const bearer = auth.bearer ?? true;
  if ("secret" in auth) return { kind: "secret", name: auth.secret, bearer };
  if ("script" in auth) return { kind: "script", script: auth.script, bearer };
  return { kind: "literal", value: auth.literal, bearer };
}

/** 提交组装：AuthStageSel → 契约 auth 槽（none → undefined 清除绑定；
 *  script 族可携编辑透传的 args——脚本名未变时原样带回；bearer:false 必须
 *  显式落库——省略在运行时语义是 true，丢掉会把用户关掉的前缀悄悄打开）。 */
export function authSlotFromSel(
  sel: AuthStageSel,
  scriptArgs?: Record<string, string>,
): AuthSlot | undefined {
  switch (sel.kind) {
    case "none":
      return undefined;
    case "secret":
      return { secret: sel.name, ...(sel.bearer ? {} : { bearer: false }) };
    case "script":
      return {
        script: sel.script,
        ...(scriptArgs !== undefined && Object.keys(scriptArgs).length > 0 ? { args: scriptArgs } : {}),
        ...(sel.bearer ? {} : { bearer: false }),
      };
    case "literal":
      return { literal: sel.value, ...(sel.bearer ? {} : { bearer: false }) };
  }
}

/**
 * 向导 ② 预选：preset.auth 透传（secret/script 两族；bearer 缺省 true——
 * 惯用 OpenAI 兼容形态）。keyEnv 型预设不预填（$env: 语法不出现在任何 UI
 * 呈现中——spec「密钥面板与密钥选择器」；env 兜底装配只在后端
 * applyAsService 路径，WebUI 表单让用户显式选密钥或手填）。
 */
export function authSelFromPreset(preset: Preset): AuthStageSel {
  const auth = preset.auth;
  if (auth === undefined) return { kind: "none" };
  if ("secret" in auth) return { kind: "secret", name: auth.secret, bearer: auth.bearer ?? true };
  return { kind: "script", script: auth.script, bearer: auth.bearer ?? true };
}

/** ③ 摘要 / 管线行短投影：none / secret:名 / script:名 / literal（值不上摘要）。 */
export function authSelSummary(sel: AuthStageSel): string {
  switch (sel.kind) {
    case "none":
      return "none";
    case "secret":
      return `secret:${sel.name}${sel.bearer ? " [bearer]" : ""}`;
    case "script":
      return `script:${sel.script}${sel.bearer ? " [bearer]" : ""}`;
    case "literal":
      return `literal${sel.bearer ? " [bearer]" : ""}`;
  }
}

// ---------------------------------------------------------------------------
// detail 投影（provider 侧 Advanced 展开；掩码纪律与 M1 AUTH_OK 披露同源：
// 密钥名 / 脚本绑定 / 引用型字面量一律 ●，无变量名与脚本返回值）
// ---------------------------------------------------------------------------

/** 投影脱敏掩码（与 canonical SERVICE_VALUE_MASK 同字符；不引 zod 保 bundle 干净）。 */
export const VALUE_MASK = "\u25cf";

/** headers.set 值掩码：$env:/$secret: 引用型 → ●（名与值都不出）；字面量原样。 */
export function maskHeaderValue(value: string): string {
  return value.startsWith("$env:") || value.startsWith("$secret:") ? VALUE_MASK : value;
}

/** auth 槽 detail 行：secret ● / script ● / literal ●（+ [bearer]）。 */
export function authDetailLine(auth: AuthSlot): string {
  const bearer = auth.bearer === true ? " [bearer]" : "";
  if ("secret" in auth) return `secret ${VALUE_MASK}${bearer}`;
  if ("script" in auth) return `script ${VALUE_MASK}${bearer}`;
  return `literal ${VALUE_MASK}${bearer}`;
}

/** headers 槽 detail 行集（set 键: 值或 ● / remove 名单 / script ●）。 */
export function headersDetailLines(headers: HeadersSlot): string[] {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(headers.set ?? {})) {
    lines.push(`set ${name}: ${maskHeaderValue(value)}`);
  }
  const remove = headers.remove ?? [];
  if (remove.length > 0) lines.push(`remove ${remove.join(", ")}`);
  if (headers.script !== undefined) lines.push(`script ${VALUE_MASK}`);
  return lines;
}

/** ③/④ 槽 detail 行：script ●（脚本绑定即注入位）。 */
export function scriptSlotDetailLine(slot: { script: string } | undefined): string | null {
  return slot !== undefined ? `script ${VALUE_MASK}` : null;
}
