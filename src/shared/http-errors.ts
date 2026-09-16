// 错误码 → 本地 HTTP 映射（表驱动；null = 连接错误关闭，不回 HTTP 实体）。
// opendweb-kernel-migration：自 consumer/gateway.ts 上提为共享件——错误响应
// 现由 provider 侧在新承载面上直接构造（consumer 侧 fetchHttp 透传同形 JSON），
// 双侧共用一张映射表保证观感不变。session_lost 为新承载面新增码（会话
// dead/closed 终结在途请求 → 504 语义；wire 帧族已退役，不再受 ERROR_CODE
// 枚举约束）。

export interface HttpErrorMapping {
  status: number | null;
  /** OpenAI 风格 error.type。 */
  type: string;
}

export type MappableErrorCode = string;

export const ERROR_HTTP_MAPPING: Readonly<Record<MappableErrorCode, HttpErrorMapping>> = {
  rate_limited: { status: 429, type: "rate_limit_error" },
  quota_exceeded: { status: 429, type: "rate_limit_error" },
  forbidden_method: { status: 405, type: "invalid_request_error" },
  forbidden_header: { status: 400, type: "invalid_request_error" },
  body_too_large: { status: 413, type: "invalid_request_error" },
  unknown_service: { status: 404, type: "invalid_request_error" },
  // 服务声明了路由表但路径未命中任何标准前缀：本地拒绝（零上游请求）——
  // 只转发声明的 API 标准面，防 /user、/balance 等个人信息端点被凭据打穿。
  path_not_offered: { status: 404, type: "invalid_request_error" },
  unauthorized: { status: 401, type: "authentication_error" },
  key_all_invalid: { status: 503, type: "api_error" },
  upstream_unreachable: { status: 502, type: "api_error" },
  // 上游错误状态正常路径走 meta/chunk/end 流原样透传；纯 upstream_status 错误
  // 不携带 status 载荷，只能以 502 兜底（裁决记录于报告）。
  upstream_status: { status: 502, type: "api_error" },
  // 提供方密钥库无此引用（$secret 未知名）：提供方配置问题，消费方视角 502。
  secret_missing: { status: 502, type: "api_error" },
  // ②③④ 生命周期脚本失效（绑定缺席/抛错/形状非法/流中途失败）：HTTP 生命周期
  // 分流（hooks-lifecycle 4.4）——pending 阶段（响应头未下发）映射 502 + 脱敏
  // message JSON；已进入流式后按失败关闭本地连接终结（不回退状态码，观感与
  // 上游流中断一致）。
  hook_failed: { status: 502, type: "api_error" },
  protocol_version: { status: 500, type: "api_error" },
  protocol_seq: { status: 500, type: "api_error" },
  protocol_error: { status: 500, type: "api_error" },
  internal: { status: 500, type: "api_error" },
  // 会话终态（dead/closed）终结在途请求：504 语义（design §2 确定错误）。
  session_lost: { status: 504, type: "api_error" },
  // 客户端已断开/本地中止/超时/超限：无实体可回，语义是连接错误关闭。
  aborted: { status: null, type: "api_error" },
  idle_timeout: { status: null, type: "api_error" },
  buffer_overflow: { status: null, type: "api_error" },
};

export interface ErrorJsonBody {
  error: { message: string; type: string; code: string };
}

export function buildErrorJson(code: string, message: string, type: string): ErrorJsonBody {
  return { error: { message, type, code } };
}

export function errorResponse(status: number, code: string, message: string, type: string): Response {
  return new Response(JSON.stringify(buildErrorJson(code, message, type)) + "\n", {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 错误码 → 本地 HTTP 响应/连接处置。返回 null 表示按连接错误关闭处置。 */
export function errorResponseFor(code: MappableErrorCode, message: string): Response | null {
  const m = ERROR_HTTP_MAPPING[code] ?? { status: 502, type: "api_error" };
  if (m.status === null) return null;
  return errorResponse(m.status, code, message, m.type);
}

/** HTTP 状态码 → reason 短语（raw socket 错误回送用；WS 升级前通道）。 */
export function reasonFor(status: number): string {
  const known: Record<number, string> = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    408: "Request Timeout",
    413: "Payload Too Large",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
  };
  return known[status] ?? "Error";
}
