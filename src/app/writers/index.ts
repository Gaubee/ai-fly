// 写手注册表与两段式编排（preview → 确认 → apply）。
// 确认令牌 = sha256(统一 diff)：apply 重算当前盘面 diff，令牌一致才落盘——
// 用户确认的与写入的是同一份内容，且预览后的并发变更被拒绝（INVALID_STATE）。

import type { WriterAgent } from "../../shared/rpc-contract.ts";
import { DomainError } from "../errors.ts";
import type { ResolvedTarget, WriterContext, WriterModule } from "./common.ts";
import { atomicWrite, readExisting, sha256Hex, unifiedDiff } from "./common.ts";
import { codexWriter } from "./codex.ts";
import { claudeCodeWriter } from "./claude-code.ts";
import { cursorWriter } from "./cursor.ts";
import { clineWriter } from "./cline.ts";
import { continueWriter } from "./continue.ts";

/** 全部写手（agent id → 模块）。 */
export const WRITERS: Readonly<Record<WriterAgent, WriterModule>> = {
  codex: codexWriter,
  "claude-code": claudeCodeWriter,
  cursor: cursorWriter,
  cline: clineWriter,
  continue: continueWriter,
};

export interface WriterPreview {
  agent: WriterAgent;
  path: string;
  exists: boolean;
  baseUrl: string;
  diff: string;
  confirmToken: string;
}

/** 生成预览（不写盘）。 */
export function previewWriter(
  agent: WriterAgent,
  target: ResolvedTarget,
  ctx: WriterContext,
): WriterPreview {
  const writer = WRITERS[agent];
  if (writer === undefined) {
    throw new DomainError("INVALID_INPUT", `unknown writer agent: ${agent}`);
  }
  const path = writer.configPath(ctx);
  const existing = readExisting(path);
  const next = writer.compose(existing, target);
  const diff = unifiedDiff(existing ?? "", next, path, path);
  return {
    agent,
    path,
    exists: existing !== null,
    baseUrl: target.baseUrl,
    diff,
    confirmToken: sha256Hex(diff),
  };
}

/** 确认后原子写（令牌不匹配 / 盘面已变 → INVALID_STATE）。 */
export function applyWriter(
  agent: WriterAgent,
  target: ResolvedTarget,
  confirmToken: string,
  ctx: WriterContext,
): { agent: WriterAgent; path: string } {
  const preview = previewWriter(agent, target, ctx);
  if (preview.confirmToken !== confirmToken) {
    throw new DomainError(
      "INVALID_STATE",
      "configuration changed since preview (or the token does not match); preview again and confirm the new diff",
    );
  }
  const writer = WRITERS[agent];
  if (writer === undefined) {
    throw new DomainError("INVALID_INPUT", `unknown writer agent: ${agent}`);
  }
  const next = writer.compose(readExisting(preview.path), target);
  atomicWrite(preview.path, next);
  return { agent, path: preview.path };
}
