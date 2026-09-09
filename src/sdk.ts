// SDK 动态导入互操作（编排者共享件）。
// 包是 CJS 且 `module.exports = Native` 为动态构造——Node 的 cjs-module-lexer
// 识别不出命名导出，真实 Node 下 `const { Fabric } = await import(pkg)` 拿到
// undefined（vitest/tsx 的转换器则能解析，导致单测绿而运行时崩——§5 e2e 实证）。
// 统一经 default 兜底解析。

type Sdk = typeof import("@jixo/opendweb-client-sdk");

export async function loadSdk(): Promise<Sdk> {
  const mod = (await import("@jixo/opendweb-client-sdk")) as unknown as
    | (Sdk & { default?: Partial<Sdk> })
    | { default?: Partial<Sdk> };
  const candidate = mod as Sdk & { default?: Partial<Sdk> };
  if (typeof candidate.Fabric === "function") return candidate;
  const def = candidate.default;
  if (def !== undefined && typeof def.Fabric === "function") {
    return def as Sdk;
  }
  throw new Error("error: @jixo/opendweb-client-sdk export shape unexpected (no Fabric via named or default interop)");
}
