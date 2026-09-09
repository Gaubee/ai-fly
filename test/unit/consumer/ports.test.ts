// consumer/ports 单测：端口冲突矩阵（占用自动错开 / strict 报错 / 0 系统分配）、
// 默认值规则（pinned > defaultPort）、--port 参数校验。

import { createServer, connect as tcpConnect, type AddressInfo } from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { UsageError } from "../../../src/cli/errors.ts";
import { desiredPortFor, listenWithFallback, validatePortArg } from "../../../src/consumer/ports.ts";
import type { ServiceEntry } from "../../../src/wire/frames.ts";

function listenOn(port: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createHttpServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

const svc = (serviceId: string, defaultPort: number): ServiceEntry => ({
  serviceId,
  name: serviceId,
  match: [],
  defaultPort,
});

describe("listenWithFallback 冲突矩阵", () => {
  it("被占端口自动错开（autoAssigned + 原因），非 strict 不抛", async () => {
    const occupied = await listenOn(0);
    try {
      const server = createHttpServer();
      const assignment = await listenWithFallback(server, { desired: occupied.port, strict: false });
      expect(assignment.autoAssigned).toBe(true);
      expect(assignment.requested).toBe(occupied.port);
      expect(assignment.port).not.toBe(occupied.port);
      expect(assignment.reason).toContain(String(occupied.port));
      expect(assignment.port).toBeGreaterThan(0);
      await closeServer(server);
    } finally {
      await closeServer(occupied.server);
    }
  });

  it("strict 模式冲突即报错（EADDRINUSE 上抛）", async () => {
    const occupied = await listenOn(0);
    try {
      const server = createHttpServer();
      await expect(listenWithFallback(server, { desired: occupied.port, strict: true })).rejects.toThrow();
      server.close();
    } finally {
      await closeServer(occupied.server);
    }
  });

  it("0 请求：系统分配端口并标注原因", async () => {
    const server = createHttpServer();
    const assignment = await listenWithFallback(server, { desired: 0, strict: false });
    expect(assignment.port).toBeGreaterThan(0);
    expect(assignment.autoAssigned).toBe(true);
    expect(assignment.reason).toContain("0");
    await closeServer(server);
  });

  it("空闲端口按请求值监听（无偏移、无 NOTICE）", async () => {
    const port = await freePort();
    const server = createHttpServer();
    const assignment = await listenWithFallback(server, { desired: port, strict: false });
    expect(assignment).toMatchObject({ port, requested: port, autoAssigned: false });
    await closeServer(server);
  });

  it("仅绑定 127.0.0.1：非回环接口连接被拒（spec「不监听外网」）", async () => {
    const { networkInterfaces } = await import("node:os");
    const ni = networkInterfaces();
    const nonLoopback = Object.values(ni)
      .flat()
      .find((n) => n !== undefined && n.family === "IPv4" && n.address !== "127.0.0.1");
    if (nonLoopback === undefined) return; // 无非回环接口的环境跳过（CI 边缘情形）
    const port = await freePort();
    const server = createHttpServer();
    await listenWithFallback(server, { desired: port, strict: false });
    const probe = await new Promise<string>((resolve) => {
      const s = tcpConnect({ host: nonLoopback.address, port });
      s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
      s.once("connect", () => {
        s.destroy();
        resolve("connected");
      });
      setTimeout(() => resolve("timeout"), 2000).unref?.();
    });
    expect(probe).toBe("ECONNREFUSED");
    await closeServer(server);
  });
});

describe("desiredPortFor / validatePortArg", () => {
  it("pinned 优先，缺省 defaultPort", () => {
    expect(desiredPortFor(svc("a", 11434), {})).toBe(11434);
    expect(desiredPortFor(svc("a", 11434), { a: 25000 })).toBe(25000);
    expect(desiredPortFor(svc("a", 11434), { other: 1 })).toBe(11434);
  });

  it("--port 值域：1..65535 整数", () => {
    expect(validatePortArg("8080")).toBe(8080);
    expect(validatePortArg("1")).toBe(1);
    expect(validatePortArg("65535")).toBe(65535);
    expect(() => validatePortArg("0")).toThrow(UsageError);
    expect(() => validatePortArg("65536")).toThrow(UsageError);
    expect(() => validatePortArg("abc")).toThrow(UsageError);
    expect(() => validatePortArg("8080.5")).toThrow(UsageError);
  });
});
