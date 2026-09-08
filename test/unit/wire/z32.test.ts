// z32 编解码单测：字母表、规范形往返（覆盖全部长度残差）、非规范形拒绝、随机性。

import { describe, expect, it } from "vitest";
import {
  Z32_ALPHABET,
  decodeZ32,
  encodeZ32,
  randomZ32,
} from "../../../src/wire/z32.ts";

describe("encodeZ32", () => {
  it("uses the fabric alphabet", () => {
    expect(Z32_ALPHABET).toBe("ybndrfg8ejkmcpqxot1uwisza345h769");
  });

  it("hand-computed vectors", () => {
    expect(encodeZ32(new Uint8Array(0))).toBe("");
    expect(encodeZ32(Uint8Array.from([0x00]))).toBe("yy");
    expect(encodeZ32(Uint8Array.from([0x66]))).toBe("ca");
    expect(encodeZ32(Uint8Array.from([0xff]))).toBe("9h");
    expect(encodeZ32(Uint8Array.from([0xff, 0xff]))).toBe("999o"); // 11111×3 + '1'垫4位零
  });

  it("lengths follow ceil(bytes*8/5)", () => {
    expect(encodeZ32(new Uint8Array(8)).length).toBe(13); // serviceId 形态
    expect(encodeZ32(new Uint8Array(16)).length).toBe(26); // request-id 形态
    expect(encodeZ32(new Uint8Array(32)).length).toBe(52); // sk-aifly- 密钥体形态
  });
});

describe("decodeZ32", () => {
  it("roundtrips every length residue mod 5", () => {
    for (let n = 0; n <= 70; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
      const text = encodeZ32(bytes);
      expect(decodeZ32(text)).toEqual(bytes);
    }
  });

  it("rejects invalid characters", () => {
    expect(() => decodeZ32("ca")).not.toThrow(); // 合法字符串对照（1 字节 → 2 字符）
    expect(() => decodeZ32("cab!")).toThrow(/invalid character/);
    expect(() => decodeZ32("CA")).toThrow(/invalid character/); // 大写不在字母表
  });

  it("rejects non-canonical trailing bits", () => {
    // "cb"：c=01100 b=00001 → 10 bit 流，尾部 2 bit 非零。
    expect(() => decodeZ32("cb")).toThrow(/trailing bits/);
    // "cab"：3 字符流尾 7 bit 非零（且 3 字符本身即非最短长度）。
    expect(() => decodeZ32("cab")).toThrow(/trailing bits/);
  });

  it("rejects non-canonical length", () => {
    // 5 字节的规范编码为 8 字符；末尾补 'y'(=0) 使尾位为零但长度非最短。
    const canonical = encodeZ32(Uint8Array.from([1, 2, 3, 4, 5]));
    expect(canonical.length).toBe(8);
    expect(() => decodeZ32(canonical + "y")).toThrow(/non-canonical length/);
  });
});

describe("randomZ32", () => {
  it("length matches byte count", () => {
    expect(randomZ32(0)).toBe("");
    expect(randomZ32(8).length).toBe(13);
    expect(randomZ32(16).length).toBe(26);
  });

  it("draws are unique (id 不复用的随机基础)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(randomZ32(16));
    expect(seen.size).toBe(5000);
  });
});
