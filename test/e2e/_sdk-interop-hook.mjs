// e2e 专用：resolve 钩子——把裸 specifier 重定向到 ESM 包装（见 _sdk-interop-register.mjs）。
const TARGET = "@jixo/opendweb-client-sdk";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === TARGET) {
    return {
      url: new URL("./_sdk-interop-wrapper.mjs", import.meta.url).href,
      format: "module",
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
