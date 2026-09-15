// hooks/rust-fetch.cjs（③ onRequest 出站接管——rust-fetch-sidecar 变更）协议
// 矩阵：以 node stub sidecar（同 stdio 协议）驱动——往返（请求元信息与体透传
// 断言）/ 多块流式 / abort SIGKILL / exit≠0 / 坏元信息行 / spawn 失败 /
// env 发现顺序。真实 Rust 二进制的构建与网络冒烟在手工回归（README）。

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HOOK = require("../../../hooks/rust-fetch.cjs") as {
  onRequest: (ctx: {
    homedir: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    body: Uint8Array;
    signal: AbortSignal;
  }) => Promise<{
    status: number;
    headers: Record<string, string>;
    body: AsyncIterable<Uint8Array>;
  }>;
};

let dir: string;
let prevBin: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aifly-rustfetch-"));
  prevBin = process.env.AIFLY_RUST_FETCH_BIN;
});

afterEach(() => {
  if (prevBin === undefined) delete process.env.AIFLY_RUST_FETCH_BIN;
  else process.env.AIFLY_RUST_FETCH_BIN = prevBin;
  rmSync(dir, { recursive: true, force: true });
});

/** 写一个同协议的 node stub sidecar（shebang 可执行）。 */
function stubSidecar(script: string): string {
  const path = join(dir, "sidecar.cjs");
  const body = `#!/usr/bin/env node\n${script}\n`;
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
  process.env.AIFLY_RUST_FETCH_BIN = path;
  return path;
}

/** ctx 基座（函数——dir 由 beforeEach 重建，模块级常量会捕获旧值）。 */
const ctxBase = () => ({
  homedir: dir,
  url: "https://u.example/v1/x",
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer tok-9" },
});

async function collect(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const chunk of body) parts.push(chunk);
  return Buffer.concat(parts);
}

describe("rust-fetch hook：stdio 协议矩阵（stub sidecar）", () => {
  it("往返：stub 收到 {url, method, headers} 元信息行 + 原始体；返回元信息行 + 体", async () => {
    const echo = join(dir, "received.json");
    stubSidecar(`
      const fs = require("node:fs");
      let line = "";
      process.stdin.on("data", (c) => { line += c; });
      process.stdin.on("end", () => {
        const nl = line.indexOf("\\n");
        const meta = line.slice(0, nl);
        const body = line.slice(nl + 1);
        fs.writeFileSync(${JSON.stringify(echo)}, JSON.stringify({ meta: JSON.parse(meta), body }));
        process.stdout.write(JSON.stringify({ status: 201, headers: { "content-type": "text/event-stream" } }) + "\\n");
        process.stdout.write(Buffer.from("data: a\\n\\n"));
        setTimeout(() => { process.stdout.write(Buffer.from("data: b\\n\\n")); process.exit(0); }, 60);
      });
    `);
    const result = await HOOK.onRequest({ ...ctxBase(), body: new TextEncoder().encode('{"ping":1}'), signal: new AbortController().signal });
    expect(result.status).toBe(201);
    expect(result.headers).toEqual({ "content-type": "text/event-stream" });
    // 多块流式：两块间有 60ms 间隔（顺序与内容保持）
    const chunks: number[] = [];
    const bodyIt = result.body[Symbol.asyncIterator]();
    const first = await bodyIt.next();
    chunks.push(first.value.length);
    const second = await bodyIt.next();
    chunks.push(second.value.length);
    const done = await bodyIt.next();
    expect(done.done).toBe(true);
    expect(Buffer.concat([first.value, second.value].map(Buffer.from)).toString()).toBe("data: a\n\ndata: b\n\n");
    // stub 侧收到的请求透传断言
    const received = JSON.parse(readFileSync(echo, "utf8"));
    const base = ctxBase();
    expect(received.meta).toEqual({ url: base.url, method: base.method, headers: base.headers });
    expect(received.body).toBe('{"ping":1}');
  });

  it("exit≠0 → 拒绝（引擎归 hook_failed）", async () => {
    stubSidecar(`process.stderr.write("boom\\n"); process.exit(3);`);
    await expect(
      HOOK.onRequest({ ...ctxBase(), body: new Uint8Array(0), signal: new AbortController().signal }),
    ).rejects.toThrow(/exited \(3\)/);
  });

  it("坏元信息行 → 拒绝", async () => {
    stubSidecar(`process.stdout.write("not-json\\n"); process.exit(0);`);
    await expect(
      HOOK.onRequest({ ...ctxBase(), body: new Uint8Array(0), signal: new AbortController().signal }),
    ).rejects.toThrow(/bad response meta/);
  });

  it("spawn 失败（二进制不存在）→ 拒绝", async () => {
    process.env.AIFLY_RUST_FETCH_BIN = join(dir, "does-not-exist");
    await expect(
      HOOK.onRequest({ ...ctxBase(), body: new Uint8Array(0), signal: new AbortController().signal }),
    ).rejects.toThrow(/spawn failed/);
  });

  it("复核 R4-P0：预先 abort + 二进制不存在 → 宿主存活 + 脱敏拒绝（不杀进程组）", async () => {
    process.env.AIFLY_RUST_FETCH_BIN = join(dir, "does-not-exist");
    const ctrl = new AbortController();
    ctrl.abort(); // 预先中止：旧实现对未完成 spawn 的子进程调 kill → 信号打到
    // 进程组，宿主（daemon / 本测试 worker）直接死亡——本用例存活即回归锚点。
    await expect(
      HOOK.onRequest({ ...ctxBase(), body: new Uint8Array(0), signal: ctrl.signal }),
    ).rejects.toThrow(/aborted before start/);
  });

  it("abort：SIGKILL 挂起的 stub，body 迭代器终止", async () => {
    const pidFile = join(dir, "stub.pid");
    stubSidecar(`
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      process.stdout.write(JSON.stringify({ status: 200, headers: {} }) + "\\n");
      setInterval(() => undefined, 1000); // 头行后挂起（永不结束）
    `);
    const ctrl = new AbortController();
    const result = await HOOK.onRequest({ ...ctxBase(), body: new Uint8Array(0), signal: ctrl.signal });
    expect(result.status).toBe(200);
    const it = result.body[Symbol.asyncIterator]();
    const pending = it.next();
    await new Promise((resolve) => setTimeout(resolve, 80));
    ctrl.abort(); // → SIGKILL
    const settled = (await Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error("body iterator did not end on abort")), 500)),
    ])) as { done?: boolean };
    expect(settled.done).toBe(true);
    // stub 进程确已退出
    await new Promise((resolve) => setTimeout(resolve, 50));
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("复核 R1-P1-1：meta 后 exit≠0 不吞成 EOF——body next() 拒绝（引擎归 hook_failed）", async () => {
    // a) meta 后零块即 exit 4
    stubSidecar(`process.stdout.write(JSON.stringify({ status: 200, headers: {} }) + "\\n"); process.exit(4);`);
    const r1 = await HOOK.onRequest({ ...ctxBase(), body: new Uint8Array(0), signal: new AbortController().signal });
    await expect(r1.body[Symbol.asyncIterator]().next()).rejects.toThrow(/mid-stream \(4\)/);

    // b) 已产出若干块后 exit 4：已消费块保序，随后 next() 拒绝
    stubSidecar(`
      process.stdout.write(JSON.stringify({ status: 200, headers: {} }) + "\\n");
      process.stdout.write(Buffer.from("chunk-a"));
      setTimeout(() => process.exit(4), 50);
    `);
    const r2 = await HOOK.onRequest({ ...ctxBase(), body: new Uint8Array(0), signal: new AbortController().signal });
    const it2 = r2.body[Symbol.asyncIterator]();
    const first = await it2.next();
    expect(Buffer.from(first.value).toString()).toBe("chunk-a");
    await expect(it2.next()).rejects.toThrow(/mid-stream \(4\)/);
  });

  it("复核 R2-P1：顶层 null / 数组 / 标量 meta → 脱敏拒绝（不抛未捕获 TypeError）", async () => {
    for (const line of ["null", "[1,2]", "42", '"str"']) {
      stubSidecar(`process.stdout.write(${JSON.stringify(line)} + "\\n"); process.exit(0);`);
      await expect(
        HOOK.onRequest({ ...ctxBase(), body: new Uint8Array(0), signal: new AbortController().signal }),
      ).rejects.toThrow(/bad response meta/);
    }
  });

  it("复核 R1-P1-1 附带：meta 形状加强（status 越界 / headers 数组 / 非 string 值）→ 拒绝", async () => {
    for (const meta of [
      JSON.stringify({ status: 700, headers: {} }),
      JSON.stringify({ status: 200, headers: [] }),
      JSON.stringify({ status: 200, headers: { "x-a": 42 } }),
    ]) {
      stubSidecar(`process.stdout.write(${JSON.stringify(meta + "")} + "\\n"); process.exit(0);`);
      await expect(
        HOOK.onRequest({ ...ctxBase(), body: new Uint8Array(0), signal: new AbortController().signal }),
      ).rejects.toThrow(/bad response meta/);
    }
  });

  it("env 发现优先：AIFLY_RUST_FETCH_BIN 直用（无 PATH 依赖）", async () => {
    // 前序用例已隐式覆盖（stub 即经 env 注入）；此处验证空 env 时不误读 stub。
    delete process.env.AIFLY_RUST_FETCH_BIN;
    // homedir 下无 sidecar 且 PATH 无 rust-fetch → spawn 失败路径
    await expect(
      HOOK.onRequest({ ...ctxBase(), body: new Uint8Array(0), signal: new AbortController().signal }),
    ).rejects.toThrow(/spawn failed|rust-fetch/);
  });
});

void spawnSync; // keep import shape stable（node:test 双入口兼容占位）
