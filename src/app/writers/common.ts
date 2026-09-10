// 写手公共件：定位/统一 diff/原子写/确认令牌。
// 正交意图（本文件不实现）：各 Agent 的配置语义（五个写手各自文件）。
// - diff：行级 LCS（配置文件规模小，DP 足够），unified diff 格式带 3 行上下文；
// - 原子写：同目录 tmp + rename（与 M1 store 同款语义，覆盖时保留既有 mode）；
// - 确认令牌：sha256(diff)——apply 侧重算当前盘面 diff，令牌一致才落盘
//   （用户看到的与写入的是同一份内容，且天然拒绝预览后并发变更）。

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { DomainError } from "../errors.ts";
import { ROUTE_LOCAL_PREFIX, type RouteForm } from "../../shared/rpc-contract.ts";

/** 写手运行上下文（home 注入：单测用 tmp HOME，不触真实用户目录）。 */
export interface WriterContext {
  home: string;
}

/** 解析后的写手目标（由 serviceId 或显式 port 归一而来）。 */
export interface ResolvedTarget {
  port: number;
  /** 本地端点（http://127.0.0.1:<port>；路径追加语义由各 Agent 配置决定）。 */
  baseUrl: string;
  /**
   * 各 API 标准的本地 base（M3-r6）：按服务路由规则的 localPrefix 生成——
   * openai 家族原样（client 追加 /chat/completions 等版本后缀）；anthropic
   * 剥尾部 /v1（Claude Code 自带 /v1/messages）。缺席 = 无该标准路由，
   * 沿用裸 baseUrl 的旧行为。
   */
  formBase?: Partial<Record<RouteForm, string>>;
}

/** 路由规则的轻量投影（writers 只需要 forms + localPrefix）。 */
export interface RouteFormView {
  forms: RouteForm[];
  localPrefix?: string | undefined;
}

/** anthropic 家族 base：剥尾部版本段（/v1）——client 自带版本段追加。 */
function stripTrailingVersion(prefix: string): string {
  return prefix.replace(/\/v\d+$/, "");
}

export function resolveTargetPort(port: number, routes?: readonly RouteFormView[]): ResolvedTarget {
  const baseUrl = `http://127.0.0.1:${port}`;
  const formBase: Partial<Record<RouteForm, string>> = {};
  for (const route of routes ?? []) {
    for (const form of route.forms) {
      if (formBase[form] !== undefined) continue;
      const local = route.localPrefix ?? ROUTE_LOCAL_PREFIX[form];
      const base = form === "anthropic" ? stripTrailingVersion(local) : local;
      formBase[form] = `${baseUrl}${base === "" ? "" : base}`;
    }
  }
  const hasForms = Object.keys(formBase).length > 0;
  return { port, baseUrl, ...(hasForms ? { formBase } : {}) };
}

/** openai 家族 agent（cursor/cline/continue）的 base：有路由用规则 base
    （localPrefix 已含版本段，client 只追加 /chat/completions 等）；无路由沿用
    裸 base（路径合成交给 upstream 自带的版本段——旧行为）。 */
export function openAiChatBase(target: ResolvedTarget): string {
  return target.formBase?.["openai-chat"] ?? target.baseUrl;
}

/** 写手模块：目标路径定位 + 新内容合成（compose 纯函数，不写盘）。 */
export interface WriterModule {
  readonly agent: "codex" | "claude-code" | "cursor" | "cline" | "continue";
  configPath(ctx: WriterContext): string;
  compose(existing: string | null, target: ResolvedTarget): string;
}

// ---------------------------------------------------------------------------
// 统一 diff（无外部依赖）
// ---------------------------------------------------------------------------

/** 单个 hunk：旧/新行区间 + 行体（前缀 ' '/'-'/'+'）。 */
interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

type DiffOp = { kind: " " | "-" | "+"; text: string };

/** 行级 LCS 编辑脚本（两序列的等值行尽量对齐）。 */
function editScript(oldLines: readonly string[], newLines: readonly string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        oldLines[i] === newLines[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: " ", text: oldLines[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "-", text: oldLines[i]! });
      i++;
    } else {
      ops.push({ kind: "+", text: newLines[j]! });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: "-", text: oldLines[i]! });
    i++;
  }
  while (j < m) {
    ops.push({ kind: "+", text: newLines[j]! });
    j++;
  }
  return ops;
}

/** unified diff（3 行上下文，@@ 头；无差异返回空串）。 */
export function unifiedDiff(oldText: string, newText: string, oldLabel: string, newLabel: string): string {
  const split = (text: string): string[] => {
    if (text === "") return [];
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  };
  const oldLines = split(oldText);
  const newLines = split(newText);
  const ops = editScript(oldLines, newLines);

  const CONTEXT = 3;
  const hunks: DiffHunk[] = [];
  let idx = 0;
  let oldLine = 1;
  let newLine = 1;
  while (idx < ops.length) {
    // 跳过纯上下文间隔（推进行号）
    while (idx < ops.length && ops[idx]!.kind === " ") {
      idx++;
      oldLine++;
      newLine++;
    }
    if (idx >= ops.length) break;

    const hunk: DiffHunk = { oldStart: oldLine, oldCount: 0, newStart: newLine, newCount: 0, lines: [] };
    // 回带前文上下文（至多 CONTEXT 行连续 ' '）
    const lead: DiffOp[] = [];
    for (let back = 1; back <= CONTEXT; back++) {
      const at = idx - back;
      if (at < 0 || ops[at]!.kind !== " ") break;
      lead.unshift(ops[at]!);
    }
    hunk.oldStart = Math.max(1, oldLine - lead.length);
    hunk.newStart = Math.max(1, newLine - lead.length);
    for (const op of lead) {
      hunk.lines.push(`${op.kind}${op.text}`);
      hunk.oldCount++;
      hunk.newCount++;
    }
    // 变更段 + 后文上下文（连续 ' ' 超过 CONTEXT 即收口）
    let trailing = 0;
    while (idx < ops.length) {
      const op = ops[idx]!;
      if (op.kind === " ") {
        trailing++;
        if (trailing > CONTEXT) break;
        hunk.lines.push(` ${op.text}`);
        hunk.oldCount++;
        hunk.newCount++;
        oldLine++;
        newLine++;
        idx++;
      } else {
        trailing = 0;
        hunk.lines.push(`${op.kind}${op.text}`);
        if (op.kind === "-") {
          hunk.oldCount++;
          oldLine++;
        } else {
          hunk.newCount++;
          newLine++;
        }
        idx++;
      }
    }
    hunks.push(hunk);
  }

  if (hunks.length === 0) return "";
  const head = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  const body = hunks.map((h) => {
    const oldRange = h.oldCount === 0 ? `${h.oldStart},0` : `${h.oldStart},${h.oldCount}`;
    const newRange = h.newCount === 0 ? `${h.newStart},0` : `${h.newStart},${h.newCount}`;
    return [`@@ -${oldRange} +${newRange} @@`, ...h.lines].join("\n");
  });
  return [...head, ...body].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// 原子写与令牌
// ---------------------------------------------------------------------------

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 读既有内容（不存在返回 null）。 */
export function readExisting(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** 原子写：同目录 tmp + rename；新建文件 0600（含凭据的配置一律按私有文件处理），覆盖时保留原 mode。 */
export function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    // 新建文件：0600
  }
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, contents, { mode });
  try {
    chmodSync(tmp, mode);
  } catch {
    // 部分文件系统不支持 chmod：writeFileSync mode 已尽力
  }
  renameSync(tmp, path);
}

/** JSON 解析（保字段前提）：不存在返回 null；存在但非 JSON 对象 → 拒绝改写（不破坏既有内容）。 */
export function readJsonOrNull(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new DomainError("INVALID_INPUT", `cannot read ${path}: ${(err as Error).message}`);
  }
  if (raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new DomainError(
        "INVALID_INPUT",
        `${path} is valid JSON but not an object; refusing to rewrite it`,
      );
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw new DomainError("INVALID_INPUT", `${path} is not valid JSON: ${(err as Error).message}`);
  }
}

/** 序列化 JSON（2 空格缩进 + 末尾换行；键序 = 插入序，既有字段顺序保持）。 */
export function serializeJson(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** 从文本解析 JSON 对象（compose 纯函数路径：无盘 IO）。空文本返回新对象；非对象/非法 → 拒绝改写。 */
export function readJsonObjectFromText(raw: string, label: string): Record<string, unknown> {
  if (raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new DomainError(
        "INVALID_INPUT",
        `${label} is valid JSON but not an object; refusing to rewrite it`,
      );
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw new DomainError("INVALID_INPUT", `${label} is not valid JSON: ${(err as Error).message}`);
  }
}

/** 取对象型子字段（不存在返回新对象；存在但非对象 → 拒绝改写）。 */
export function objectField(
  root: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, unknown> {
  const value = root[key];
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("INVALID_INPUT", `${label}: '${key}' is not an object; refusing to rewrite it`);
  }
  return value as Record<string, unknown>;
}
