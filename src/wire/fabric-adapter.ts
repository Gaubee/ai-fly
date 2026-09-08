// fabric ↔ wire 适配：把一个 Fabric 实例上"与某个对端"的 envelope 流呈现为
// WireTransport（WireSession 的传输面）。提供方为每个已连接消费者建一个适配器，
// 使用方为每个提供者建一个——session 与适配器一对一。
//
// 正交意图：
// 1. per-peer 传输视图（send/onFrame/close/onClose）
// 2. 非 aifly 帧（decodeFrame 为 null）静默过滤（混流共存，spec wire-protocol）
// 3. decode 标记（unknown-version/unknown-type/malformed）原样上抛，由 WireSession
//    按策略处置（回送 ERROR 或忽略）

import type { Fabric } from "@jixo/opendweb-client-sdk";
import type { DecodedFrame } from "./codec.ts";
import { decodeFrame } from "./codec.ts";
import type { WireTransport } from "./mux.ts";

type FrameCb = (frame: DecodedFrame) => void;
type CloseCb = (reason?: string) => void;

export class FabricWireAdapter implements WireTransport {
  private readonly fabric: Fabric;
  private readonly peerId: string;
  private readonly frameCbs = new Set<FrameCb>();
  private readonly closeCbs = new Set<CloseCb>();
  private readonly unsubscribes: Array<() => void> = [];
  private closed = false;

  constructor(fabric: Fabric, peerId: string) {
    this.fabric = fabric;
    this.peerId = peerId;
    this.unsubscribes.push(
      fabric.on((event) => {
        if (event.type === "message" && event.from === peerId) {
          const decoded = decodeFrame(new Uint8Array(event.data));
          if (decoded === null) return; // 非 aifly 流量静默忽略
          for (const cb of this.frameCbs) cb(decoded);
        } else if (event.type === "peer-disconnected" && event.endpointId === peerId) {
          this.handleClose("peer-disconnected");
        }
      }),
    );
  }

  get endpointId(): string {
    return this.peerId;
  }

  async send(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("transport closed");
    await this.fabric.send(this.peerId, Buffer.from(data));
  }

  onFrame(cb: FrameCb): void {
    this.frameCbs.add(cb);
  }

  close(reason?: string): void {
    this.handleClose(reason ?? "local-close");
  }

  onClose(cb: CloseCb): void {
    this.closeCbs.add(cb);
  }

  /** 释放事件订阅（进程退出路径）；不断开 fabric 连接本身。 */
  dispose(): void {
    for (const off of this.unsubscribes.splice(0)) off();
  }

  private handleClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.unsubscribes.splice(0)) off();
    for (const cb of this.closeCbs) cb(reason);
  }
}
