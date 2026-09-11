// HTTP 控制面代理（SDK FabricOptions.httpProxy）解析：--proxy 旗标 > AIFLY_PROXY env。
// 取值：http(s):// URL（CONNECT 代理）| 'env'（读进程环境变量）| 'none'（显式禁用）。
// 语义（SDK 注释）：仅 relay 控制面走代理——iroh 不读进程环境变量；QUIC 数据面
// 永不经代理。受限网络（透明代理/防火墙拦 UDP 或直连）下的会合兜底通道。

import type { HttpProxyOptions } from "@jixo/opendweb-client-sdk";
import { UsageError } from "./errors.ts";

export function resolveHttpProxy(
  flag: string | undefined,
  env: string | undefined = process.env.AIFLY_PROXY,
): HttpProxyOptions | undefined {
  const spec = flag ?? env;
  if (spec === undefined || spec === "") return undefined;
  if (spec === "none") return "none";
  if (spec === "env") return "from-env";
  if (!/^https?:\/\//i.test(spec)) {
    throw new UsageError(`error: --proxy expects an http(s):// URL, 'env' or 'none' (got '${spec}')`);
  }
  return { url: spec };
}
