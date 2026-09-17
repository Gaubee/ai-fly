// aifly 控制协议的 HTTP 承载面常量与工具（opendweb-kernel-migration）：
// 旧 envelope 帧族（AUTH/REQ/RESP_*/DATA_*/CLOSE）退役后，aifly 语义改经
// opendweb 会话连续性内核的 HTTP 投影（fetchHttp/serveHttp）承载：
// - serviceId 路由：请求头 `x-aifly-service`（消费端 forward 注入，提供端
//   剥离后进既有 rewrite 头链——绝不透传上游）；
// - AUTH：会话 active 后 POST /_aifly/auth（{v:1, keys:[...]} → 200 AUTH_OK
//   目录 JSON | 403 AUTH_ERR JSON）；
// - 目录刷新：GET /_aifly/catalog-watch?since=<seq> 长轮询（<30s——内核
//   fetchHttp 响应头等待窗 30s；未变化回 204，变化回 200 refresh:true 全量视图）；
// - WS 隧道：keepOpen 字节隧道（fetchHttp keepOpen + sendTunnel/bodyNext）；
//   关闭码经响应头 `x-aifly-ws-close` 透传（tunnel EOF 后消费端据此关本地 WS）。
// 正交意图：本文件只做“形状”：纯常量与小工具，无 IO、无会话状态；
// schema 复用 frames.ts（share-link 依赖保留的静态定义层）。

/** 消费端 → 提供端的 serviceId 路由头（提供端剥离，不过 rewrite 头链）。 */
export const AIFLY_SERVICE_HEADER = "x-aifly-service";

/** AUTH 端点（会话 active 后消费端 POST）。 */
export const AIFLY_AUTH_PATH = "/_aifly/auth";

/** 目录刷新长轮询端点（已 AUTH 会话）。 */
export const AIFLY_WATCH_PATH = "/_aifly/catalog-watch";

/** WS 隧道关闭码响应头（静态载体时代的透传通道；流式载体改用带内尾块——
 * 保留常量以剥离残留头，兼容读侧见 providers.ts 尾块优先 + 头兜底）。 */
export const AIFLY_WS_CLOSE_HEADER = "x-aifly-ws-close";

// ---------------------------------------------------------------------------
// WS 关闭码带内尾块（流式载体）：magic "AFWS" + flag + 可选 2 字节 BE 码。
// 仅当该分块为流最终分块时由消费端解释（一 chunk 前瞻判定）；内核 fetchHttp
// 保持 write 分块边界，故前瞻是可靠的。非最终分块撞上同形态 → 按数据冲刷。
// ---------------------------------------------------------------------------
export function encodeWsCloseTrailer(code: number | undefined): Uint8Array {
  const out = new Uint8Array(code === undefined ? 5 : 7);
  out[0] = 0x41;
  out[1] = 0x46;
  out[2] = 0x57;
  out[3] = 0x53;
  if (code === undefined) {
    out[4] = 0;
    return out;
  }
  out[4] = 1;
  out[5] = (code >>> 8) & 0xff;
  out[6] = code & 0xff;
  return out;
}

/** 形态初筛（长度 5..7 且前四字节为 magic）——是否为尾块由流的下一读决定。 */
export function looksLikeWsCloseTrailer(chunk: Uint8Array): boolean {
  return (
    chunk.length >= 5 &&
    chunk.length <= 7 &&
    chunk[0] === 0x41 &&
    chunk[1] === 0x46 &&
    chunk[2] === 0x57 &&
    chunk[3] === 0x53
  );
}

/** 解码尾块：null = 非 trailer 形态（按数据冲刷）；undefined = 无码关闭；
 * number = 关闭码（域外码保守降为 undefined）。 */
export function decodeWsCloseTrailer(chunk: Uint8Array): number | undefined | null {
  if (!looksLikeWsCloseTrailer(chunk)) return null;
  if (chunk.length === 5 && chunk[4] === 0) return undefined;
  if (chunk.length === 7 && chunk[4] === 1) {
    const code = (chunk[5]! << 8) | chunk[6]!;
    return code >= 1000 && code <= 65535 ? code : undefined;
  }
  return null;
}

/** catalog-watch 长轮询上限（内核 fetchHttp 响应头等待窗 30s，留裕量）。 */
export const CATALOG_WATCH_TIMEOUT_MS = 20_000;

/** 提供端请求体重组上限（与消费端本地 8MiB 同值；旧 mux 重组上限语义平移）。 */
export const REQUEST_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

/** 内部承载头集合（提供端进 rewrite 前剥离；消费端响应投影前剥离）。 */
export const AIFLY_CONTROL_HEADERS: ReadonlySet<string> = new Set([
  AIFLY_SERVICE_HEADER,
  AIFLY_WS_CLOSE_HEADER,
]);
