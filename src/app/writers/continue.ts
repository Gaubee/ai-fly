// continue 写手：~/.continue/config.json 的 models 数组（官方约定路径）。
// upsert 语义：按 title === "ai-fly" 定位——命中则原位更新 provider/apiBase/
// apiKey，未命中则追加；数组内其它条目与根级其它字段全部保留。

import { join } from "node:path";
import type { ResolvedTarget, WriterContext, WriterModule } from "./common.ts";
import { openAiChatBase, readJsonObjectFromText, serializeJson } from "./common.ts";
import { DomainError } from "../errors.ts";

export const CONTINUE_MODEL_TITLE = "ai-fly";
export const CONTINUE_PLACEHOLDER_KEY = "sk-aifly-local";

export const continueWriter: WriterModule = {
  agent: "continue",
  configPath(ctx: WriterContext): string {
    return join(ctx.home, ".continue", "config.json");
  },
  compose(existing: string | null, target: ResolvedTarget): string {
    const root = readJsonObjectFromText(existing ?? "", "config.json");
    const existingModels = root["models"];
    if (existingModels !== undefined && !Array.isArray(existingModels)) {
      throw new DomainError("INVALID_INPUT", "config.json: 'models' is not an array; refusing to rewrite it");
    }
    const models: unknown[] = Array.isArray(existingModels) ? [...existingModels] : [];
    const entry = {
      title: CONTINUE_MODEL_TITLE,
      provider: "openai",
      apiBase: openAiChatBase(target),
      apiKey: CONTINUE_PLACEHOLDER_KEY,
      // 本地端点不指定模型名：由服务 upstream 侧的目录/默认模型决定，留占位
      model: CONTINUE_MODEL_TITLE,
    };
    const idx = models.findIndex(
      (m) => m !== null && typeof m === "object" && !Array.isArray(m) && (m as Record<string, unknown>)["title"] === CONTINUE_MODEL_TITLE,
    );
    if (idx >= 0) {
      const prev = models[idx] as Record<string, unknown>;
      models[idx] = { ...prev, ...entry }; // 既有自定义字段（如 systemMessage）保留
    } else {
      models.push(entry);
    }
    root["models"] = models;
    return serializeJson(root);
  },
};
