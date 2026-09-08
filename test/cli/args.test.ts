import { describe, expect, it } from "vitest";
import {
  assertDurationRange,
  expandTilde,
  parseArgv,
  parseDurationMs,
  type OptionDecl,
} from "../../src/cli/args.ts";
import { CliError, UsageError } from "../../src/cli/errors.ts";

const spec: Readonly<Record<string, OptionDecl>> = {
  data: { type: "string", tilde: true },
  upstream: { type: "string" },
  "log-usage": { type: "boolean" },
  relay: { type: "multi" },
  port: { type: "string" },
};

describe("parseArgv", () => {
  it("--opt value and --opt=value are equivalent", () => {
    const a = parseArgv(["--data", "/tmp/a"], spec);
    const b = parseArgv(["--data=/tmp/a"], spec);
    expect(a.options).toEqual(b.options);
    expect(a.options.data).toBe("/tmp/a");
  });

  it("boolean flags take no value; inline value is a usage error", () => {
    expect(parseArgv(["--log-usage"], spec).options["log-usage"]).toBe(true);
    expect(() => parseArgv(["--log-usage=true"], spec)).toThrowError(UsageError);
  });

  it("expands ~ for tilde-declared options only", () => {
    const r = parseArgv(["--data", "~/fab", "--upstream", "~/nope"], spec, {
      homedir: "/home/u",
    });
    expect(r.options.data).toBe("/home/u/fab");
    expect(r.options.upstream).toBe("~/nope");
    expect(expandTilde("~", "/home/u")).toBe("/home/u");
  });

  it("unknown option exits as UsageError listing known options", () => {
    try {
      parseArgv(["--nope"], spec);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).exitCode).toBe(2);
      expect((err as UsageError).message).toContain("--data");
    }
  });

  it("missing value for a valued option is a UsageError", () => {
    expect(() => parseArgv(["--port"], spec)).toThrowError(UsageError);
  });

  it("multi accumulates in order across both forms", () => {
    const r = parseArgv(["--relay", "http://a:1", "--relay=http://b:2"], spec);
    expect(r.options.relay).toEqual(["http://a:1", "http://b:2"]);
  });

  it("positionals collected; -- stops option parsing", () => {
    const r = parseArgv(["tok", "--", "--data", "x"], spec);
    expect(r.positionals).toEqual(["tok", "--data", "x"]);
    expect(r.options.data).toBeUndefined();
  });
});

describe("parseDurationMs", () => {
  it("suffix units and bare milliseconds", () => {
    expect(parseDurationMs("500", "--ttl")).toBe(500);
    expect(parseDurationMs("2s", "--ttl")).toBe(2000);
    expect(parseDurationMs("30m", "--ttl")).toBe(1_800_000);
    expect(parseDurationMs("1.5h", "--ttl")).toBe(5_400_000);
    expect(parseDurationMs("1d", "--ttl")).toBe(86_400_000);
  });

  it("syntax error throws CliError with the option label", () => {
    expect(() => parseDurationMs("abc", "--ttl")).toThrowError(CliError);
    expect(() => parseDurationMs("1w", "--ttl")).toThrowError(/--ttl/);
  });

  it("overflow returns +Infinity instead of wrapping", () => {
    expect(parseDurationMs("999999999d", "--ttl")).toBe(Number.POSITIVE_INFINITY);
  });

  it("range assertion message carries the range text", () => {
    expect(() => assertDurationRange(0, 1000, 1000 * 60, "--ttl", "1s..1m")).toThrowError(
      /out of range/,
    );
  });
});
