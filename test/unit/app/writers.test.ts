// 写手单测（presets spec「Agent 配置写手」）：快照（新建/同名更新/既有其它字段
// 逐字保留）、preview→confirm→apply 两段式（令牌不匹配/盘面变更拒绝、原子写、
// 二次 apply 拒绝）、损坏 JSON 拒改写。fixture 一律 tmp HOME。

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyWriter, previewWriter, WRITERS } from "../../../src/app/writers/index.ts";
import { unifiedDiff } from "../../../src/app/writers/common.ts";
import { DomainError } from "../../../src/app/errors.ts";
import { resolveTargetPort } from "../../../src/app/writers/common.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aifly-writers-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const target = resolveTargetPort(8787);

// ---------------------------------------------------------------------------
// codex（TOML 文本手术）
// ---------------------------------------------------------------------------

describe("codex writer", () => {
  it("creates a new config with the ai-fly provider block", () => {
    const preview = previewWriter("codex", target, { home });
    expect(preview.exists).toBe(false);
    expect(preview.path).toBe(join(home, ".codex", "config.toml"));
    expect(preview.diff).toContain('+[model_providers.ai-fly]');
    expect(preview.diff).toContain(`+base_url = "http://127.0.0.1:8787"`);

    const result = applyWriter("codex", target, preview.confirmToken, { home });
    expect(result.path).toBe(preview.path);
    const written = readFileSync(preview.path, "utf8");
    expect(written).toContain('[model_providers.ai-fly]');
    expect(written).toContain('base_url = "http://127.0.0.1:8787"');
    expect(written.endsWith("\n")).toBe(true);
  });

  it("preserves other tables byte-for-byte and replaces only the ai-fly block", () => {
    const existing = [
      '# my codex config',
      'model = "gpt-5"',
      '',
      '[mcp_servers.fs]',
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]',
      '',
      '[model_providers.ai-fly]',
      'name = "old"',
      'base_url = "http://127.0.0.1:9999/v1"',
      'env_key = "OLD"',
      '',
      '[model_providers.other]',
      'name = "other"',
    ].join('\n');
    mkdirSync(join(home, ".codex"), { recursive: true });
    const path = join(home, ".codex", "config.toml");
    writeFileSync(path, existing);

    const preview = previewWriter("codex", target, { home });
    expect(preview.exists).toBe(true);
    applyWriter("codex", target, preview.confirmToken, { home });

    const next = readFileSync(path, "utf8");
    // 其它表逐字保留
    expect(next).toContain('# my codex config');
    expect(next).toContain('model = "gpt-5"');
    expect(next).toContain('[mcp_servers.fs]');
    expect(next).toContain('[model_providers.other]');
    expect(next).toContain('args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]');
    // ai-fly 块被替换
    expect(next).not.toContain('http://127.0.0.1:9999/v1');
    expect(next).toContain('base_url = "http://127.0.0.1:8787"');
    // 顺序：mcp_servers 在前，ai-fly 在其中，other 在后
    expect(next.indexOf("[mcp_servers.fs]")).toBeLessThan(next.indexOf("[model_providers.ai-fly]"));
    expect(next.indexOf("[model_providers.ai-fly]")).toBeLessThan(next.indexOf("[model_providers.other]"));
  });

  it("appends the block when the file exists without one", () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    const path = join(home, ".codex", "config.toml");
    writeFileSync(path, 'model = "gpt-5"\n');
    const preview = previewWriter("codex", target, { home });
    applyWriter("codex", target, preview.confirmToken, { home });
    const next = readFileSync(path, "utf8");
    expect(next.startsWith('model = "gpt-5"\n')).toBe(true);
    expect(next).toContain("[model_providers.ai-fly]");
  });
});

// ---------------------------------------------------------------------------
// claude-code（JSON env 块）
// ---------------------------------------------------------------------------

describe("claude-code writer", () => {
  it("creates settings.json with env redirects", () => {
    const preview = previewWriter("claude-code", target, { home });
    expect(preview.path).toBe(join(home, ".claude", "settings.json"));
    applyWriter("claude-code", target, preview.confirmToken, { home });
    const parsed = JSON.parse(readFileSync(preview.path, "utf8")) as {
      env: Record<string, string>;
    };
    expect(parsed.env["ANTHROPIC_BASE_URL"]).toBe("http://127.0.0.1:8787");
    // 占位密钥：不写真实凭据（凭据走 fabric 钥环）
    expect(parsed.env["ANTHROPIC_AUTH_TOKEN"]).toBe("sk-aifly-local");
  });

  it("preserves unrelated settings fields and updates an existing redirect", () => {
    const existing = JSON.stringify(
      {
        permissions: { allow: ["Bash(ls:*)"] },
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:9999",
          ANTHROPIC_AUTH_TOKEN: "old-token",
          OTHER_TOOL: "keep",
        },
      },
      null,
      2,
    );
    mkdirSync(join(home, ".claude"), { recursive: true });
    const path = join(home, ".claude", "settings.json");
    writeFileSync(path, existing);
    const preview = previewWriter("claude-code", target, { home });
    applyWriter("claude-code", target, preview.confirmToken, { home });
    const next = JSON.parse(readFileSync(path, "utf8")) as {
      permissions: unknown;
      env: Record<string, string>;
    };
    expect(next.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(next.env["OTHER_TOOL"]).toBe("keep");
    expect(next.env["ANTHROPIC_BASE_URL"]).toBe("http://127.0.0.1:8787");
  });
});

// ---------------------------------------------------------------------------
// cursor / cline（VS Code 系 settings.json）
// ---------------------------------------------------------------------------

describe("cursor writer", () => {
  it("writes the custom OpenAI endpoint keys into the Cursor settings path", () => {
    const preview = previewWriter("cursor", target, { home });
    expect(preview.path).toContain("Cursor");
    expect(preview.path).toContain("settings.json");
    applyWriter("cursor", target, preview.confirmToken, { home });
    const parsed = JSON.parse(readFileSync(preview.path, "utf8")) as Record<string, string>;
    expect(parsed["openai.baseUrl.experimental"]).toBe("http://127.0.0.1:8787");
    expect(parsed["openai.apiKey"]).toBe("sk-aifly-local");
  });
});

describe("cline writer", () => {
  it("writes the cline endpoint keys into the VS Code settings path", () => {
    const preview = previewWriter("cline", target, { home });
    expect(preview.path).toContain("settings.json");
    applyWriter("cline", target, preview.confirmToken, { home });
    const parsed = JSON.parse(readFileSync(preview.path, "utf8")) as Record<string, string>;
    expect(parsed["cline.openAiBaseUrl"]).toBe("http://127.0.0.1:8787");
    expect(parsed["cline.openAiApiKey"]).toBe("sk-aifly-local");
  });
});

// ---------------------------------------------------------------------------
// continue（models 数组 upsert）
// ---------------------------------------------------------------------------

describe("continue writer", () => {
  it("creates config.json with one ai-fly model entry", () => {
    const preview = previewWriter("continue", target, { home });
    expect(preview.path).toBe(join(home, ".continue", "config.json"));
    applyWriter("continue", target, preview.confirmToken, { home });
    const parsed = JSON.parse(readFileSync(preview.path, "utf8")) as {
      models: Array<{ title: string; provider: string; apiBase: string }>;
    };
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0]).toMatchObject({
      title: "ai-fly",
      provider: "openai",
      apiBase: "http://127.0.0.1:8787",
    });
  });

  it("updates the ai-fly entry in place and preserves siblings/custom fields", () => {
    const existing = JSON.stringify(
      {
        models: [
          { title: "gpt-5", provider: "openai", apiBase: "https://api.openai.com/v1" },
          {
            title: "ai-fly",
            provider: "openai",
            apiBase: "http://127.0.0.1:9999",
            systemMessage: "custom prompt",
          },
        ],
        tabAutocompleteModel: { title: "small" },
      },
      null,
      2,
    );
    mkdirSync(join(home, ".continue"), { recursive: true });
    const path = join(home, ".continue", "config.json");
    writeFileSync(path, existing);
    const preview = previewWriter("continue", target, { home });
    applyWriter("continue", target, preview.confirmToken, { home });
    const next = JSON.parse(readFileSync(path, "utf8")) as {
      models: Array<Record<string, unknown>>;
      tabAutocompleteModel: unknown;
    };
    expect(next.models).toHaveLength(2); // 不重复追加
    expect(next.tabAutocompleteModel).toEqual({ title: "small" });
    const entry = next.models.find((m) => m["title"] === "ai-fly")!;
    expect(entry["apiBase"]).toBe("http://127.0.0.1:8787");
    expect(entry["systemMessage"]).toBe("custom prompt"); // 自定义字段保留
  });
});

// ---------------------------------------------------------------------------
// 两段式与损坏文件
// ---------------------------------------------------------------------------

describe("preview/apply contract", () => {
  it("rejects a mismatched confirm token", () => {
    expect(() =>
      applyWriter("codex", target, "0".repeat(64), { home }),
    ).toThrowError(DomainError);
  });

  it("rejects when the file changed between preview and apply", () => {
    const preview = previewWriter("claude-code", target, { home });
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(preview.path, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://x" } }, null, 2));
    expect(() => applyWriter("claude-code", target, preview.confirmToken, { home })).toThrowError(
      DomainError,
    );
  });

  it("rejects a second apply with the same token (already applied)", () => {
    const preview = previewWriter("codex", target, { home });
    applyWriter("codex", target, preview.confirmToken, { home });
    expect(() => applyWriter("codex", target, preview.confirmToken, { home })).toThrowError(DomainError);
  });

  it("refuses to rewrite a corrupt JSON config (field preservation precondition)", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{oops");
    expect(() => previewWriter("claude-code", target, { home })).toThrowError(/not valid JSON/);
  });

  it("leaves no temp files behind after apply", () => {
    const preview = previewWriter("continue", target, { home });
    applyWriter("continue", target, preview.confirmToken, { home });
    const dir = join(home, ".continue");
    const leftovers = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.includes(".tmp-"))
      : [];
    expect(leftovers).toEqual([]);
  });
});

describe("unifiedDiff", () => {
  it("produces empty output for identical texts", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n", "x", "x")).toBe("");
  });

  it("emits headers and hunks for a line replacement", () => {
    const diff = unifiedDiff("one\ntwo\nthree\n", "one\nTWO\nthree\n", "old", "new");
    expect(diff.startsWith("--- old\n+++ new\n")).toBe(true);
    expect(diff).toContain("@@ -1,3 +1,3 @@");
    expect(diff).toContain("-two");
    expect(diff).toContain("+TWO");
    expect(diff).toContain(" one");
    expect(diff).toContain(" three");
  });
});

describe("writer registry", () => {
  it("covers all five agents with distinct config paths", () => {
    const paths = new Set<string>();
    for (const agent of ["codex", "claude-code", "cursor", "cline", "continue"] as const) {
      const writer = WRITERS[agent];
      expect(writer).toBeDefined();
      paths.add(writer.configPath({ home }));
    }
    expect(paths.size).toBe(5);
  });
});

describe("M3-r4 按标准路由的 base 写入（formBase）", () => {
  const routed = resolveTargetPort(4304, ["openai-chat", "anthropic"]);
  const allForms = resolveTargetPort(4300, ["openai-chat", "openai-responses", "anthropic"]);

  it("resolveTargetPort：formBase = baseUrl + 标准本地前缀；无路由缺省", () => {
    expect(routed.baseUrl).toBe("http://127.0.0.1:4304");
    expect(routed.formBase).toEqual({
      "openai-chat": "http://127.0.0.1:4304/openai",
      anthropic: "http://127.0.0.1:4304/anthropic",
    });
    expect(resolveTargetPort(4300).formBase).toBeUndefined();
  });

  it("claude-code：anthropic 路由 → /anthropic 前缀；无路由 → 裸 base（旧行为）", async () => {
    const routedPreview = await previewWriter("claude-code", routed, { home });
    expect(routedPreview.diff).toContain('"ANTHROPIC_BASE_URL": "http://127.0.0.1:4304/anthropic"');
    const legacy = await previewWriter("claude-code", target, { home });
    expect(legacy.diff).toContain(`"ANTHROPIC_BASE_URL": "${target.baseUrl}"`);
  });

  it("codex：responses 路由 → responses wire_api + /responses/v1；否则 chat + 裸 base", async () => {
    const routedPreview = await previewWriter("codex", allForms, { home });
    expect(routedPreview.diff).toContain('wire_api = "responses"');
    expect(routedPreview.diff).toContain('base_url = "http://127.0.0.1:4300/responses/v1"');
    const legacy = await previewWriter("codex", target, { home });
    expect(legacy.diff).toContain('wire_api = "chat"');
    expect(legacy.diff).toContain(`base_url = "${target.baseUrl}"`);
  });

  it("cursor/cline/continue：openai-chat 路由 → /openai/v1 base", async () => {
    const cursorPreview = await previewWriter("cursor", routed, { home });
    expect(cursorPreview.diff).toContain('"openai.baseUrl.experimental": "http://127.0.0.1:4304/openai/v1"');
    const clinePreview = await previewWriter("cline", routed, { home });
    expect(clinePreview.diff).toContain('"cline.openAiBaseUrl": "http://127.0.0.1:4304/openai/v1"');
    const continuePreview = await previewWriter("continue", routed, { home });
    expect(continuePreview.diff).toContain('"apiBase": "http://127.0.0.1:4304/openai/v1"');
  });
});
