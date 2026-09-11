// `ai-fly presets [搜索词]`（cli-parity B2）：GUI 首屏预设清单的 CLI 面——
// featured（providers.json 精选）+ models.dev 长尾（缓存/在线扩展；断网或
// 禁用时显示不可用注记，不挡清单）。--json 输出机器可读形态。
// service add --preset <id> 的预填在 service.ts 消费同一 curated 源。

import { homedir } from "node:os";
import { parseArgv } from "../../args.ts";
import { UsageError, reportCliError } from "../../errors.ts";
import { fetchModelsDevPresets, loadCuratedPresets, modelsDevCachePath } from "../../../../presets/models-dev.ts";
import { loadSettings } from "../../../app/settings.ts";

const SPEC = {
  json: { type: "boolean" },
} as const;

const USAGE = `usage:
  ai-fly presets [search] [--json]`;

export async function run(argv: string[], ctx: { homedir?: string } = {}): Promise<number> {
  try {
    const home = ctx.homedir ?? homedir();
    const { options, positionals } = parseArgv(argv, SPEC, { homedir: home });
    if (positionals.length > 1) {
      throw new UsageError(`error: unexpected argument '${positionals[1]}'`);
    }
    const query = (positionals[0] ?? "").toLowerCase();
    const curated = loadCuratedPresets();
    const settings = loadSettings(home);
    let longTail: typeof curated = [];
    let note = "";
    if (settings.modelsDevEnabled) {
      try {
        const result = await fetchModelsDevPresets(curated, { cachePath: modelsDevCachePath(home) });
        if (result.error !== undefined) note = result.error;
        longTail = result.presets;
      } catch {
        note = "models.dev expansion unavailable (offline?)";
      }
    } else {
      note = "models.dev expansion disabled in settings";
    }
    const featuredIds = new Set(curated.map((preset) => preset.id));
    const longTailOnly = longTail.filter((preset) => !featuredIds.has(preset.id));
    const all = [...curated, ...longTailOnly];
    const hits = query === "" ? all : all.filter((preset) => `${preset.id} ${preset.label}`.toLowerCase().includes(query));

    if (options.json === true) {
      process.stdout.write(`${JSON.stringify(hits.map((p) => ({ id: p.id, label: p.label, baseUrl: p.baseUrl, defaultPort: p.defaultPort })), null, 2)}\n`);
      return 0;
    }
    const out = (line: string): void => {
      process.stdout.write(`${line}\n`);
    };
    out(`presets (${hits.length}${query === "" ? "" : ` matching '${positionals[0]}'`})`);
    for (const preset of hits) {
      const badge = featuredIds.has(preset.id) ? "featured" : "long-tail";
      out(`  ${preset.id.padEnd(24)} ${preset.label}  ${preset.baseUrl}  :${preset.defaultPort}  [${badge}]`);
    }
    if (note !== "") out(note);
    out(`use: ai-fly service add <name> --preset <id>`);
    return 0;
  } catch (err) {
    return reportCliError(err);
  }
}
