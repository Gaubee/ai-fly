// i18n 核心（Owner 裁决 2026-09-11：中英双版本，OS 偏好为默认语言）：
// - 解析链：localStorage（用户显式选择）→ navigator.languages（OS 偏好，
//   zh* → zh，其余 → en）→ en。
// - 切语言即写 localStorage + 同步 <html lang>（jixoai ambientLocale 的 LIVE
//   通道——所有消费 ambientLocale 的组件跟随重渲染）。
// - t(key, params)：模块级 $state 驱动；键缺失回退英文键面（开发期显性漏翻）。
// 目录：src/locales/{en,zh}.ts（平铺键表；params 用 {name} 占位）。

import { en } from "../locales/en.ts";
import { zh } from "../locales/zh.ts";

export type Locale = "en" | "zh";

const STORAGE_KEY = "aifly-locale";

const catalogs: Record<Locale, Record<string, string>> = { en, zh };

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "zh") return saved;
  } catch {
    // localStorage 不可用（隐私模式等）——落 OS 偏好
  }
  const languages =
    typeof navigator !== "undefined" ? (navigator.languages ?? [navigator.language]) : [];
  return languages.some((tag) => typeof tag === "string" && tag.toLowerCase().startsWith("zh"))
    ? "zh"
    : "en";
}

let current = $state<Locale>(detectLocale());

if (typeof document !== "undefined") {
  document.documentElement.lang = current === "zh" ? "zh-CN" : "en";
}

/** 当前语言（响应式——消费 t() 的组件随切换重渲染）。 */
export function locale(): Locale {
  return current;
}

/** 切语言：持久化 + 同步 <html lang>。 */
export function setLocale(next: Locale): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // 持久化失败不阻塞切换（会话内仍生效）
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  }
}

/** 翻译：当前语言 > 英文回退 > 键名本身（漏翻显性化）。 */
export function t(key: string, params?: Record<string, string | number>): string {
  let text = catalogs[current][key] ?? catalogs.en[key] ?? key;
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}
