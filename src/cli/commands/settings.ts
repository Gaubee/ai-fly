// `ai-fly settings list|set`（cli-parity B3）：~/.aifly/settings.json 的 CLI 面
// （与 app/GUI 同源真平价）。键面：theme / models-dev / relay。relay 是 GUI
// RelayPickerDialog 的同源落点；`ai-fly relay list|set ...` 是兼容别名。

import { homedir } from "node:os";
import { parseArgv } from "../args.ts";
import { UsageError, reportCliError } from "../errors.ts";
import { loadSettings, saveSettings } from "../../app/settings.ts";
import { settingsPath } from "../../app/settings.ts";

const SPEC = {
  default: { type: "boolean" },
} as const;

const USAGE = `usage:
  ai-fly settings list
  ai-fly settings set theme dark|light|system
  ai-fly settings set models-dev on|off
  ai-fly settings set relay <url>... | --default
  ai-fly relay list
  ai-fly relay set <url>... | --default        (alias of 'settings set relay')`;

export async function runAsSettings(argv: string[], ctx: { homedir?: string } = {}): Promise<number> {
  try {
    const home = ctx.homedir ?? homedir();
    const sub = argv[0];
    if (sub === "list" || sub === undefined) return list(home);
    if (sub === "set") return await set(argv.slice(1), home);
    throw new UsageError(`error: unknown settings subcommand '${sub}'\n${USAGE}`);
  } catch (err) {
    return reportCliError(err);
  }
}

/** `ai-fly relay …` 兼容别名：list → settings list 的 relay 行；set → 同落点。 */
export async function runAsRelay(argv: string[], ctx: { homedir?: string } = {}): Promise<number> {
  try {
    const home = ctx.homedir ?? homedir();
    const sub = argv[0];
    if (sub === "list" || sub === undefined) {
      const settings = loadSettings(home);
      process.stdout.write(
        settings.relayUrls === null
          ? "relay: SDK defaults (n0 public relays)\n"
          : `relay (${settings.relayUrls.length}):\n${settings.relayUrls.map((u) => `  ${u}`).join("\n")}\n`,
      );
      return 0;
    }
    if (sub === "set") {
      const rest = argv.slice(1);
      parseArgv(rest, SPEC, { homedir: home });
      const urls = rest.filter((a) => !a.startsWith("--"));
      for (const url of urls) {
        if (!/^https?:\/\//.test(url)) {
          throw new UsageError(`error: relay URLs must start with http:// or https:// (got '${url}')`);
        }
      }
      applyRelay(urls, rest.includes("--default"), home);
      return 0;
    }
    throw new UsageError(`error: unknown relay subcommand '${sub}' (known: list, set)`);
  } catch (err) {
    return reportCliError(err);
  }
}

function list(home: string): number {
  const settings = loadSettings(home);
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  out(`settings (${settingsPath(home)})`);
  out(`  theme      : ${settings.theme}`);
  out(`  models-dev : ${settings.modelsDevEnabled ? "on" : "off"}`);
  out(
    settings.relayUrls === null
      ? "  relay      : SDK defaults (n0 public relays)"
      : `  relay      : ${settings.relayUrls.join(", ")}`,
  );
  return 0;
}

async function set(rest: readonly string[], home: string): Promise<number> {
  const { options } = parseArgv([...rest], SPEC, { homedir: home });
  const key = rest[0];
  const value = rest[1];
  switch (key) {
    case "theme": {
      if (value !== "dark" && value !== "light" && value !== "system") {
        throw new UsageError("error: settings set theme requires dark|light|system");
      }
      saveSettings({ theme: value }, home);
      process.stdout.write(`theme: ${value}\n`);
      return 0;
    }
    case "models-dev": {
      if (value !== "on" && value !== "off") {
        throw new UsageError("error: settings set models-dev requires on|off");
      }
      saveSettings({ modelsDevEnabled: value === "on" }, home);
      process.stdout.write(`models-dev: ${value}\n`);
      return 0;
    }
    case "relay": {
      const urls = rest.slice(1).filter((a) => !a.startsWith("--"));
      for (const url of urls) {
        if (!/^https?:\/\//.test(url)) {
          throw new UsageError(`error: relay URLs must start with http:// or https:// (got '${url}')`);
        }
      }
      applyRelay(urls, options.default === true, home);
      return 0;
    }
    case undefined:
      throw new UsageError(USAGE);
    default:
      throw new UsageError(`error: unknown settings key '${key}' (known: theme, models-dev, relay)`);
  }
}

function applyRelay(urls: readonly string[], useDefault: boolean, home: string): void {
  if (useDefault || urls.length === 0) {
    saveSettings({ relayUrls: null }, home);
    process.stdout.write("relay: SDK defaults (n0 public relays)\n");
    return;
  }
  if (urls.length > 8) throw new UsageError("error: at most 8 relay URLs");
  saveSettings({ relayUrls: [...urls] }, home);
  process.stdout.write(`relay (${urls.length}): ${urls.join(", ")}\n`);
}
