// 认证头取值（auth source）——"这个服务的请求带什么认证头"的单一概念
// 模型（Owner 裁决 2026-09-13 + PM 方案 B）：一个槽位三族单选 + 透传哨兵。
// - 配置只有两种协议：字面量 string | 脚本调用对象 {hook,args?,bearer?}
//   （不做第三种、不做降级）；
// - hook 脚本的 authHeader() 返回值是认证头的显式可绑定来源——选择器是
//   消费入口（optgroup 分 密钥/hook 两族），脚本资源管理真源在 hooks 页签；
// - keep 哨兵只回显透传 GUI 不理解的既有绑定（字面量 / env / file /
//   非本表单产生的对象），保证编辑服务永不静默丢配置。
// 高级页服务表单与分享向导 ② 共用本模块（两处组装规则必须一致）。
import type { Preset, ServiceConfigView } from "$shared/rpc-contract.ts";

/** 脚本调用对象形态（契约 HeaderValue 的对象半边，结构同构不引 zod）。 */
export interface HookAuthorization {
  hook: string;
  args?: Record<string, string>;
  bearer?: boolean;
}

export type HeaderValue = string | HookAuthorization;

/** 内置取值源脚本——认证选择器不重复露出（密钥条目/keep 已按语义覆盖）。 */
const BUILTIN_VALUE_SCRIPTS = new Set(["secret", "env", "file"]);

export type AuthSel =
  | { kind: "none" }
  | { kind: "secret"; name: string }
  | { kind: "hook"; script: string; bearer: boolean }
  | {
      /** 不可新建，只回显：CLI/预设带入的绑定原样透传。 */
      kind: "keep";
      label: string;
      hooks?: string;
      authorization?: HeaderValue;
    };

/** hooks 页签口径（资产全列）→ 认证槽位口径（可用性）：导出 authHeader
 * 且非内置取值源的脚本才能绑定认证头。 */
export function hookAuthOptions(
  scripts: Array<{ name: string; fns: string[] }>,
): Array<{ script: string }> {
  return scripts
    .filter((s) => !BUILTIN_VALUE_SCRIPTS.has(s.name) && s.fns.includes("authHeader"))
    .map((s) => ({ script: s.name }));
}

/** 编辑回显：落库的 authorization → AuthSel（keep 兜底一切本表单不产生
 *  的形态）。hooks 脚本选择（service.hooks）由表单单独回显——内置取值源
 *  脚本（secret/env/file）不进 hooks 选择器，其绑定由密钥条目/keep 承载。 */
export function authSelFromService(service: ServiceConfigView): AuthSel {
  const authorization = service.rewrite?.headerSet?.["authorization"] as HeaderValue | undefined;
  if (authorization === undefined) return { kind: "none" };
  if (typeof authorization === "string") {
    return { kind: "keep", label: "custom", hooks: service.hooks, authorization };
  }
  if (authorization.hook === "authHeader" && authorization.args?.name !== undefined) {
    return { kind: "secret", name: authorization.args.name };
  }
  if (
    authorization.hook === "authHeader" &&
    authorization.args === undefined &&
    service.hooks !== undefined &&
    service.hooks !== "" &&
    !BUILTIN_VALUE_SCRIPTS.has(service.hooks)
  ) {
    return { kind: "hook", script: service.hooks, bearer: authorization.bearer ?? true };
  }
  return { kind: "keep", label: "custom", hooks: service.hooks, authorization };
}

/** 编辑回显：service.hooks → hooks 脚本选择器的显示值（内置取值源归 ""）。 */
export function hooksScriptFromService(service: ServiceConfigView): string {
  return service.hooks !== undefined && !BUILTIN_VALUE_SCRIPTS.has(service.hooks) ? service.hooks : "";
}

/** 向导 ② 预选：预设携带的认证（presetAuth 型显式 hook 绑定；keyEnv 型
 *  降为 keep 哨兵承载 env 组装，用户可显式改选覆盖）。 */
export function authSelFromPreset(preset: Preset): AuthSel {
  if (preset.authHeader !== undefined) {
    if (preset.hooks !== undefined && !BUILTIN_VALUE_SCRIPTS.has(preset.hooks)) {
      return { kind: "hook", script: preset.hooks, bearer: preset.authHeader.bearer ?? true };
    }
    return { kind: "keep", label: "custom", hooks: preset.hooks, authorization: preset.authHeader };
  }
  if (preset.keyEnv !== undefined) {
    return {
      kind: "keep",
      label: `env:${preset.keyEnv}`,
      hooks: "env",
      authorization: { hook: "authHeader", args: { var: preset.keyEnv } },
    };
  }
  return { kind: "none" };
}

/** 向导 ② 预选：预设携带的 hooks 脚本（内置取值源归 ""）。 */
export function hooksScriptFromPreset(preset: Preset): string {
  return preset.hooks !== undefined && !BUILTIN_VALUE_SCRIPTS.has(preset.hooks) ? preset.hooks : "";
}

/** hooks 字段组装：表单的脚本选择优先；secret 认证补 "secret"；keep 透传
 *  自带值；none 且未选脚本 → 不带（编辑重建即清除）。 */
export function hooksField(
  selectedScript: string,
  sel: AuthSel,
): string | undefined {
  if (selectedScript !== "") return selectedScript;
  if (sel.kind === "secret") return "secret";
  if (sel.kind === "keep" && sel.hooks !== undefined && sel.hooks !== "") return sel.hooks;
  return undefined;
}

/** 提交组装：AuthSel → authorization 片段（hooks 字段不在本函数——双控件
 *  模型下由 hooksField 单独组装，Owner 裁决 2026-09-13 #3）。 */
export function authInput(
  sel: AuthSel,
): { authorization?: HeaderValue } {
  switch (sel.kind) {
    case "none":
      return {};
    case "secret":
      return { authorization: { hook: "authHeader", args: { name: sel.name } } };
    case "hook":
      return {
        authorization: {
          hook: "authHeader",
          ...(sel.bearer ? { bearer: true } : {}),
        },
      };
    case "keep":
      return sel.authorization !== undefined ? { authorization: sel.authorization } : {};
  }
}

/** ③ 摘要 / detail 行的短投影：secret:名 / 脚本 hook / env:VAR / none /
 * keep label。 */
export function authSelSummary(sel: AuthSel): string {
  switch (sel.kind) {
    case "none":
      return "none";
    case "secret":
      return `secret:${sel.name}`;
    case "hook":
      return `${sel.script} hook`;
    case "keep":
      return sel.label;
  }
}
