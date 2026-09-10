// RFC 6570 子集扩展器单测（M3-r7 pattern 路由拼装）。用例取自 RFC 6570
// 附录的对应子集（变量值均为字符串——URLPattern 组/查询参数场景）。

import { describe, expect, it } from "vitest";
import { expandUriTemplate, validateUriTemplate, UriTemplateError } from "../../../src/provider/uri-template.ts";

const vars = { ver: "v1", model: "deepseek-chat", path: "a/b", q: "hello world", empty: "" };

describe("expandUriTemplate", () => {
  it("Level 1：{var} 简单替换 + pct-encode", () => {
    expect(expandUriTemplate("/api/{ver}/models", vars)).toBe("/api/v1/models");
    expect(expandUriTemplate("/s/{q}", vars)).toBe("/s/hello%20world");
  });

  it("Level 2：{+var} 保留字符不转义", () => {
    expect(expandUriTemplate("/file/{+path}", vars)).toBe("/file/a/b");
  });

  it("{/var} 路径段展开", () => {
    expect(expandUriTemplate("/root{/ver}/x", vars)).toBe("/root/v1/x");
  });

  it("{.var} 点分段", () => {
    expect(expandUriTemplate("X{.ver}", vars)).toBe("X.v1");
  });

  it("{?var} 查询串（未定义变量整体省略）", () => {
    expect(expandUriTemplate("/models{?model,missing}", vars)).toBe("/models?model=deepseek-chat");
    expect(expandUriTemplate("/models{?missing}", vars)).toBe("/models");
  });

  it("{&var} 追加查询参数", () => {
    expect(expandUriTemplate("/x?base=1{&model}", vars)).toBe("/x?base=1&model=deepseek-chat");
  });

  it("{;var} 路径参数", () => {
    expect(expandUriTemplate("/x{;ver}", vars)).toBe("/x;ver=v1");
  });

  it("{#var} 片段", () => {
    expect(expandUriTemplate("/x{#ver}", vars)).toBe("/x#v1");
  });

  it("多变量与混合字面量", () => {
    expect(expandUriTemplate("/{ver}/{model}/completions", vars)).toBe("/v1/deepseek-chat/completions");
  });

  it("空值变量按未定义省略", () => {
    expect(expandUriTemplate("/a/{empty}/b", vars)).toBe("/a//b");
    expect(expandUriTemplate("/a{/empty}/b", vars)).toBe("/a/b");
  });

  it("无表达式模板原样返回", () => {
    expect(expandUriTemplate("/v1/chat", vars)).toBe("/v1/chat");
  });
});

describe("validateUriTemplate", () => {
  it("合法模板通过", () => {
    expect(() => validateUriTemplate("/api/{ver}/{model}{?stream}")).not.toThrow();
  });

  it("未闭合花括号拒绝", () => {
    expect(() => validateUriTemplate("/api/{ver")).toThrow(UriTemplateError);
  });

  it("非法变量名拒绝", () => {
    expect(() => validateUriTemplate("/api/{bad name}")).toThrow(UriTemplateError);
    expect(() => validateUriTemplate("/api/{}")).toThrow(UriTemplateError);
  });
});
