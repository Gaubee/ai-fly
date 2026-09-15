// hooks/codex.cjs 全生命周期脚本（rust-fetch-sidecar 变更：预设模式首消费者）：
// ① onRequestBearerAuthentication 裸 token（只读 auth.json——ai-fly 永不写凭据）；
// ② onRequestHeaders 注入 codex CLI 同款头集（account-id/originator/openai-beta/UA）；
// ③ onRequest 委托 rust-fetch（stub sidecar 全通验证委托链）。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const codex = require("../../../hooks/codex.cjs") as {
  onRequestBearerAuthentication: (ctx: { homedir: string }) => string;
  onRequestHeaders: (ctx: { homedir: string }) => { set: Record<string, string> };
  onRequest: (ctx: Record<string, unknown>) => Promise<unknown>;
};

let dir: string;
let prevBin: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aifly-codex-hook-"));
  prevBin = process.env.AIFLY_RUST_FETCH_BIN;
  mkdirSync(join(dir, ".codex"), { recursive: true });
  writeFileSync(
    join(dir, ".codex", "auth.json"),
    JSON.stringify({
      tokens: { access_token: "tok-codex-1", account_id: "acc-77", refresh_token: "rt", id_token: "id" },
    }),
  );
});

afterEach(() => {
  if (prevBin === undefined) delete process.env.AIFLY_RUST_FETCH_BIN;
  else process.env.AIFLY_RUST_FETCH_BIN = prevBin;
  rmSync(dir, { recursive: true, force: true });
});

describe("codex 全生命周期脚本（预设模式）", () => {
  it("① 裸 token：只读 ~/.codex/auth.json（沙盒 HOME）", () => {
    expect(codex.onRequestBearerAuthentication({ homedir: dir })).toBe("tok-codex-1");
  });

  it("② codex CLI 同款头集：account-id / originator / openai-beta / user-agent", () => {
    const { set } = codex.onRequestHeaders({ homedir: dir });
    expect(set["chatgpt-account-id"]).toBe("acc-77");
    expect(set["originator"]).toBe("codex_cli_rs");
    expect(set["openai-beta"]).toBe("responses=experimental");
    expect(set["user-agent"]).toContain("codex_cli_rs/");
    expect(set["user-agent"]).toContain(join(dir, ".codex"));
  });

  it("①② 缺凭据字段 → 抛错（引擎归 secret_missing / hook_failed）", () => {
    writeFileSync(join(dir, ".codex", "auth.json"), JSON.stringify({ tokens: {} }));
    expect(() => codex.onRequestBearerAuthentication({ homedir: dir })).toThrow(/access_token/);
    expect(() => codex.onRequestHeaders({ homedir: dir })).toThrow(/account_id/);
  });

  it("③ 委托 rust-fetch：经 stub sidecar 全通（meta 透传 + 流式体回传）", async () => {
    const stub = join(dir, "sidecar.cjs");
    writeFileSync(
      stub,
      '#!/usr/bin/env node\nlet line="";process.stdin.on("data",(c)=>{line+=c});process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({status:200,headers:{"content-type":"text/plain"}})+"\\n");process.stdout.write(Buffer.from("ok-from-rust"));process.exit(0);});\n',
      { mode: 0o755 },
    );
    chmodSync(stub, 0o755);
    process.env.AIFLY_RUST_FETCH_BIN = stub;
    const result = (await codex.onRequest({
      homedir: dir,
      url: "https://chatgpt.com/backend-api/codex/responses",
      method: "POST",
      headers: {},
      body: new Uint8Array(0),
      signal: new AbortController().signal,
    })) as { status: number; headers: Record<string, string>; body: AsyncIterable<Uint8Array> };
    expect(result.status).toBe(200);
    const parts: Uint8Array[] = [];
    for await (const chunk of result.body) parts.push(chunk);
    expect(Buffer.concat(parts.map(Buffer.from)).toString()).toBe("ok-from-rust");
  });
});
