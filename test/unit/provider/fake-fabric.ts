// 内存成对 FakeFabric（engine 单测用）：实现 Fabric 公共面（continuity 面为
// 抛错桩——引擎单测注入内存 serveHttp 假体，不触内核会话），peer-connected/
// relay 事件可手动注入。不加载原生 SDK（vitest worker 池约束）。

import type { Fabric, FabricEventJs, RelayStatusJs } from "@jixo/opendweb-client-sdk";
import type { Member } from "@jixo/opendweb-client-sdk";

export class FakeFabric implements Fabric {
  readonly endpointId: string;
  peer: FakeFabric | undefined;
  relayUrlsValue: string[] = ["http://relay.example.test:8787"];
  revoked: string[] = [];
  shutdownCount = 0;
  invited: Array<{ ttlMs: number; opts?: { allowRelayless?: boolean } | undefined }> = [];

  private readonly callbacks = new Set<(event: FabricEventJs) => void>();

  constructor(endpointId: string) {
    this.endpointId = endpointId;
  }

  static pair(providerId: string, consumerId: string): { provider: FakeFabric; consumer: FakeFabric } {
    const provider = new FakeFabric(providerId);
    const consumer = new FakeFabric(consumerId);
    provider.peer = consumer;
    consumer.peer = provider;
    return { provider, consumer };
  }

  on(callback: (event: FabricEventJs) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  off(): void {
    // index.js 包装为取消订阅函数；假体用 on 的返回值即可
  }

  emit(event: FabricEventJs): void {
    for (const cb of [...this.callbacks]) cb(event);
  }

  async send(endpointId: string, data: Buffer): Promise<void> {
    if (this.peer === undefined || endpointId !== this.peer.endpointId) {
      throw new Error(`fake fabric: no route to ${endpointId}`);
    }
    this.peer.emit({ type: "message", from: this.endpointId, data });
  }

  async fabricIdHex(): Promise<string> {
    return "cafe1234deadbeef";
  }

  async members(): Promise<Array<Member>> {
    return this.peer === undefined ? [] : [{ endpointId: this.peer.endpointId, sinceMs: 0 }];
  }

  async isMember(endpointId: string): Promise<boolean> {
    return this.peer?.endpointId === endpointId;
  }

  async invite(
    ttlMs: number,
    _recipient?: string | undefined | null,
    opts?: { allowRelayless?: boolean } | undefined | null,
  ): Promise<string> {
    this.invited.push({ ttlMs, opts: opts ?? undefined });
    return `dweb1.fake.${ttlMs}`;
  }

  async join(): Promise<void> {}

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {
    // 模拟断连：双侧 peer-disconnected
    this.peer?.emit({ type: "peer-disconnected", endpointId: this.endpointId });
    this.emit({ type: "peer-disconnected", endpointId: this.peer?.endpointId ?? "?" });
  }

  async revoke(endpointId: string): Promise<void> {
    this.revoked.push(endpointId);
  }

  async setDisplayName(): Promise<void> {}

  async linkStatus(): Promise<string> {
    return "direct";
  }

  async relayStatus(): Promise<RelayStatusJs> {
    return {
      mode: "custom",
      urls: [...this.relayUrlsValue],
      online: this.relayUrlsValue.length > 0,
      lastError: null,
      activeUrl: this.relayUrlsValue[0] ?? null,
    };
  }

  async exportSecretPassphrase(): Promise<string> {
    return "dwebkey1.fake";
  }

  // ---- continuity 面：抛错桩（引擎单测经注入的 serveHttp 假体驱动，不触内核） ----

  async openSession(): Promise<never> {
    throw new Error("fake fabric: openSession not supported (inject serveHttp fake instead)");
  }

  async continuitySnapshot(): Promise<never> {
    throw new Error("fake fabric: continuitySnapshot not supported");
  }

  async continuityReset(): Promise<void> {}

  async addKnownAddr(): Promise<void> {}

  async serveHttp(): Promise<never> {
    throw new Error("fake fabric: serveHttp not supported (inject serveHttp fake instead)");
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1;
  }
}

