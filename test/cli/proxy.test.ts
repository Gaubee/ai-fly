// resolveHttpProxy（--proxy 旗标解析）：url/env/none/非法值 + AIFLY_PROXY 回落。
// 纯函数，直接构造 flag/env 输入。

import { describe, expect, it } from "vitest";
import { resolveHttpProxy } from "../../src/cli/proxy.ts";
import { UsageError } from "../../src/cli/errors.ts";

describe("resolveHttpProxy", () => {
  it("http(s) URL → { url }", () => {
    expect(resolveHttpProxy("http://127.0.0.1:7890")).toEqual({ url: "http://127.0.0.1:7890" });
    expect(resolveHttpProxy("https://proxy.corp:8443")).toEqual({ url: "https://proxy.corp:8443" });
  });

  it("env → from-env；none → none", () => {
    expect(resolveHttpProxy("env", undefined)).toBe("from-env");
    expect(resolveHttpProxy("none", undefined)).toBe("none");
  });

  it("非法协议拒绝（socks 不受支持——SDK httpProxy 语义）", () => {
    expect(() => resolveHttpProxy("socks5://127.0.0.1:1080", undefined)).toThrow(UsageError);
    expect(() => resolveHttpProxy("127.0.0.1:7890", undefined)).toThrow(UsageError);
  });

  it("flag 缺席回落 AIFLY_PROXY env；两者皆空 → undefined", () => {
    expect(resolveHttpProxy(undefined, "http://p:1")).toEqual({ url: "http://p:1" });
    expect(resolveHttpProxy(undefined, "env")).toBe("from-env");
    expect(resolveHttpProxy(undefined, "")).toBeUndefined();
    expect(resolveHttpProxy(undefined, undefined)).toBeUndefined();
  });

  it("flag 覆盖 env", () => {
    expect(resolveHttpProxy("none", "http://p:1")).toBe("none");
  });
});
