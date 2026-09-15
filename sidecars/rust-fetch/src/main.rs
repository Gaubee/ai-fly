//! ai-fly rust-fetch sidecar（openspec/changes/rust-fetch-sidecar，协议冻结）。
//!
//! stdio 协议：
//! - stdin：JSON 元信息行 `{url, method, headers}` + `\n` + 原始请求体（EOF 止）
//! - stdout：JSON 元信息行 `{status, headers}` + `\n` + 响应体（逐块 flush；EOF = 体结束）
//! - 失败：stderr 一行消息；exit 3 = 请求构造/发送失败，exit 4 = 流中途失败
//!
//! TLS = rustls（客户端栈不同于 JS 运行时后端）；HTTP/2 经 ALPN；代理沿用
//! reqwest 环境默认（HTTPS_PROXY/HTTP_PROXY/NO_PROXY）。父进程（hooks/
//! rust-fetch.cjs）在引擎中止/本地超时时 SIGKILL 本进程——无需内部超时。

use std::collections::BTreeMap;
use std::io::{BufRead, Read, Write};

use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct RequestMeta {
    url: String,
    method: String,
    headers: std::collections::HashMap<String, String>,
}

fn fail(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(3);
}

fn main() {
    let stdin = std::io::stdin();
    let mut lock = stdin.lock();
    let mut line = String::new();
    if lock.read_line(&mut line).unwrap_or(0) == 0 {
        fail("no request meta line on stdin");
    }
    let meta: RequestMeta = match serde_json::from_str(line.trim_end()) {
        Ok(m) => m,
        Err(e) => fail(&format!("bad request meta line: {e}")),
    };
    let mut body = Vec::new();
    if lock.read_to_end(&mut body).is_err() {
        fail("could not read request body from stdin");
    }

    let client = match reqwest::blocking::Client::builder().build() {
        Ok(c) => c,
        Err(e) => fail(&format!("client build failed: {e}")),
    };
    let method = match reqwest::Method::from_bytes(meta.method.as_bytes()) {
        Ok(m) => m,
        Err(_) => fail(&format!("invalid method '{}'", meta.method)),
    };
    let mut req = client.request(method, &meta.url);
    for (name, value) in &meta.headers {
        req = req.header(name.as_str(), value.as_str());
    }
    if !body.is_empty() {
        req = req.body(body);
    }
    let mut resp = match req.send() {
        Ok(r) => r,
        Err(e) => fail(&format!("request failed: {e}")),
    };

    // 响应元信息行：头键小写化、同名值逗号连接（协议冻结）。
    let mut headers: BTreeMap<String, String> = BTreeMap::new();
    for (name, value) in resp.headers() {
        let key = name.as_str().to_ascii_lowercase();
        let val = value.to_str().unwrap_or("");
        match headers.get_mut(&key) {
            Some(existing) => {
                existing.push_str(", ");
                existing.push_str(val);
            }
            None => {
                headers.insert(key, val.to_string());
            }
        }
    }
    let meta_out = json!({ "status": resp.status().as_u16(), "headers": headers });
    let mut out = std::io::stdout().lock();
    if writeln!(out, "{meta_out}").is_err() {
        return; // 父进程已退出：直接放弃
    }

    // 响应体：stdout 即流，逐块 flush（SSE 语义：禁止缓冲攒齐）。
    let mut buf = [0u8; 16 * 1024];
    loop {
        match resp.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if out.write_all(&buf[..n]).is_err() || out.flush().is_err() {
                    break; // 消费方断开
                }
            }
            Err(e) => {
                eprintln!("body stream failed: {e}");
                std::process::exit(4);
            }
        }
    }
    let _ = out.flush();
}
