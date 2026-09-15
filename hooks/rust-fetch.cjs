// 内建 hooks 脚本：rust-fetch —— ③ onRequest 阶段，把出站 HTTPS 请求交给
// Rust sidecar（rustls TLS + HTTP/2 ALPN）发起——客户端栈不同于 js-backend-fetch
// （Owner 2026-09-15 裁决；rust-fetch-sidecar 变更）。
// stdio 协议（冻结）：stdin = JSON 元信息行 + 原始请求体；stdout = JSON 元信息
// 行 + 流式响应体（stdout 即流，EOF = 体结束）；exit≠0 / 元信息行解析失败 =
// 脚本失效（引擎归 hook_failed 固定脱敏文案）。ctx.signal（引擎 ctrl.signal
// ——外部中止与本地超时均经此）触发时 SIGKILL 子进程，body 迭代器随之终止。
// 二进制发现：AIFLY_RUST_FETCH_BIN（env）> ~/.aifly/sidecars/rust-fetch/rust-fetch
// > PATH。构建：sidecars/rust-fetch 目录 cargo build --release（README 指引）。
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

function resolveBin(homedir) {
  const fromEnv = process.env.AIFLY_RUST_FETCH_BIN;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const homeSidecar = join(homedir, ".aifly", "sidecars", "rust-fetch", "rust-fetch");
  if (existsSync(homeSidecar)) return homeSidecar;
  return "rust-fetch"; // PATH 兜底（不存在 → spawn error → 本请求失败）
}

module.exports.onRequest = function onRequest({ homedir, url, method, headers, body, signal }) {
  // 预先 abort（复核 R4-P0）：spawn 之前拒绝——绝不在未完成 spawn 的子进程上
  // 调 kill（pid 尚为 undefined 时 child.kill 会把信号发给进程组，杀掉宿主
  // daemon；实测复现：缺失二进制 + 预 abort = 宿主直接死亡）。
  if (signal !== undefined && signal.aborted) {
    return Promise.reject(new Error("rust-fetch aborted before start"));
  }
  const bin = resolveBin(homedir);
  const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume(); // 丢弃 stderr（错误语义只有 exit 码；不泄内容）

  // 集中终止（复核 R4-P0）：仅在 pid 已就位时发信号——spawn 同步失败（ENOENT
  // 等）的子进程 pid 为 undefined，此时 kill 会波及进程组/宿主。
  const killChild = () => {
    if (child.pid !== undefined) child.kill("SIGKILL");
  };

  let settled = false;
  let killedByUs = false; // abort 路径的 SIGKILL：终结语义（body 正常结束），非流错误
  const onAbort = () => {
    killedByUs = true;
    killChild();
  };
  if (signal !== undefined) {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  // abort 监听必须存活到进程终结（头行到达 ≠ 请求结束——body 流仍可中止）。
  const detach = () => {
    if (signal !== undefined) signal.removeEventListener("abort", onAbort);
  };

  // 请求体写入（stdin EOF = 体结束——sidecar 读到 EOF 才发请求）。
  child.stdin.on("error", () => undefined); // 竞速关闭：吞 EPIPE（失败经 close 码归置）
  child.stdin.write(JSON.stringify({ url, method, headers }) + "\n");
  if (body !== undefined && body.length > 0) {
    child.stdin.write(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
  }
  child.stdin.end();

  // body 队列迭代器（stdout 头行之后即体流；engine 单次消费）。streamError：
  // meta 后进程失败（exit≠0 / stdout error）不得吞成正常 EOF——next() 以拒绝
  // 结算，引擎归 hook_failed（复核 R1-P1-1）。
  const queue = [];
  let drained = false;
  let streamError;
  const waiters = [];
  const wake = () => {
    while (waiters.length > 0) waiters.shift()();
  };
  const bodyIterable = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        for (;;) {
          if (streamError !== undefined) throw streamError;
          if (queue.length > 0) return { done: false, value: queue.shift() };
          if (drained) return { done: true, value: undefined };
          await new Promise((resolve) => waiters.push(resolve));
        }
      },
    }),
  };

  return new Promise((resolve, reject) => {
    let headerDone = false;
    let buffered = [];
    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      if (err !== undefined) reject(err);
      else resolve(value);
    };
    const fail = (message) => {
      killChild();
      drained = true;
      wake();
      settle(new Error(message));
    };

    child.stdout.on("data", (chunk) => {
      if (headerDone) {
        queue.push(chunk);
        wake();
        return;
      }
      buffered.push(chunk);
      const joined = Buffer.concat(buffered);
      const nl = joined.indexOf(0x0a);
      if (nl === -1) return; // 头行未齐（元信息行很小，重拼代价可忽略）
      buffered = [];
      let meta;
      try {
        meta = JSON.parse(joined.subarray(0, nl).toString("utf8"));
      } catch {
        fail("rust-fetch: bad response meta line");
        return;
      }
      // 先拒 null/数组/标量，再读字段（复核 R2-P1：meta.headers 在 null 上求值
      // 会先抛 TypeError——顺序即安全）。
      if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
        fail("rust-fetch: bad response meta shape");
        return;
      }
      const headersOk =
        typeof meta.headers === "object" &&
        meta.headers !== null &&
        !Array.isArray(meta.headers) &&
        Object.entries(meta.headers).every(
          ([k, v]) => typeof k === "string" && typeof v === "string",
        );
      if (
        !Number.isInteger(meta.status) ||
        meta.status < 200 ||
        meta.status > 599 ||
        !headersOk
      ) {
        fail("rust-fetch: bad response meta shape");
        return;
      }
      headerDone = true;
      const rest = joined.subarray(nl + 1);
      if (rest.length > 0) queue.push(rest);
      settle(undefined, { status: meta.status, headers: meta.headers, body: bodyIterable });
    });
    child.stdout.on("error", () => {
      if (headerDone) {
        streamError = new Error("rust-fetch: stdout error mid-stream");
        drained = true;
        wake();
        return;
      }
      fail("rust-fetch: stdout error");
    });
    child.on("error", (err) => fail(`rust-fetch: spawn failed (${err.code ?? err.message})`));
    child.on("close", (code) => {
      detach(); // 进程终结：解除 abort 监听（头行期不解除——body 流仍可中止）
      if (!headerDone) {
        fail(code === 0 ? "rust-fetch: no response meta line" : `rust-fetch exited (${code})`);
        return;
      }
      if (code !== 0 && !killedByUs) {
        // meta 后非零退出 = 流中途失败（协议 exit 4 等）——绝不当作正常 EOF；
        // 我方 abort 的 SIGKILL（code=null）是终结语义，body 正常收尾
        streamError = new Error(`rust-fetch exited mid-stream (${code})`);
      }
      drained = true;
      wake();
    });
  });
};
