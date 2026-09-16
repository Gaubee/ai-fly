// createFabricSessionFactory 的 relay 透传（Owner 裁决 2026-09-13：链接
// 带来的会合点优先）：info.relayUrls 非空 → factory.open 收到 relayUrls；
// 空/缺省 → 不带（走工厂层解析）。假 FabricFactory 记录 open 入参。
// opendweb-kernel-migration：工厂面自传输会话工厂（openSession 即 connect）
// 改为底层 fabric 工厂（open 幂等复用）——透传断言语义不变。

import { describe, expect, it } from "vitest";
import {
  createFabricSessionFactory,
  type FabricFactory,
  type FabricLike,
} from "../../../src/consumer/providers.ts";

function recordingFactory() {
  const opens: Array<{ dataDir: string; relayUrls?: string[] }> = [];
  const factory: FabricFactory = {
    open: async (opts) => {
      opens.push({ dataDir: opts.dataDir, ...("relayUrls" in opts ? { relayUrls: opts.relayUrls } : {}) });
      return {} as FabricLike;
    },
    joinWithToken: async () => {
      throw new Error("not used in this test");
    },
  };
  return { opens, factory };
}

describe("createFabricSessionFactory relay 透传", () => {
  it("info.relayUrls 非空 → open 收到；重复 open 幂等复用单实例", async () => {
    const { opens, factory } = recordingFactory();
    const session = createFabricSessionFactory(factory, {
      dataDir: "/tmp/ring-a/fabric",
      providerEndpointId: "ep-1",
      relayUrls: ["http://127.0.0.1:3340"],
    });
    await session.open();
    await session.open(); // 幂等：底层 fabric 一次
    expect(opens).toEqual([{ dataDir: "/tmp/ring-a/fabric", relayUrls: ["http://127.0.0.1:3340"] }]);
  });

  it("relayUrls 空数组 → 不带字段（走工厂层 flag>env>file 解析）", async () => {
    const { opens, factory } = recordingFactory();
    const session = createFabricSessionFactory(factory, {
      dataDir: "/tmp/ring-b/fabric",
      providerEndpointId: "ep-2",
      relayUrls: [],
    });
    await session.open();
    expect(opens).toEqual([{ dataDir: "/tmp/ring-b/fabric" }]);
  });

  it("relayUrls 缺省 → 同样不带字段", async () => {
    const { opens, factory } = recordingFactory();
    const session = createFabricSessionFactory(factory, {
      dataDir: "/tmp/ring-c/fabric",
      providerEndpointId: "ep-3",
    });
    await session.open();
    expect(opens).toEqual([{ dataDir: "/tmp/ring-c/fabric" }]);
  });
});
