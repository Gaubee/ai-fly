// 内存成对 loopback 传输（mux 单测用）：一侧 send 的字节经 codec.decode 后投递到对侧
// onFrame 回调（非 aifly 家族 envelope 在此静默蒸发，模拟 fabric 混流共存）；close
// 同时通知两侧（模拟连接断开）。sendGate 可注入发送延迟/门控，用于保序与队列测试。

import { decodeFrame, type DecodedFrame } from "../../../src/wire/codec.ts";
import type { WireTransport } from "../../../src/wire/mux.ts";

export class LoopbackTransport implements WireTransport {
  peer: LoopbackTransport | undefined;
  closed = false;
  /** 测试钩子：发送前门控（返回的 promise resolve 前字节不出门）。 */
  sendGate: ((data: Uint8Array) => Promise<void>) | undefined;

  private readonly frameCbs: Array<(frame: DecodedFrame) => void> = [];
  private readonly closeCbs: Array<(reason?: string) => void> = [];

  async send(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("loopback transport closed");
    if (this.sendGate !== undefined) await this.sendGate(data);
    if (this.closed) throw new Error("loopback transport closed");
    this.peer?.receive(data);
  }

  onFrame(cb: (frame: DecodedFrame) => void): void {
    this.frameCbs.push(cb);
  }

  onClose(cb: (reason?: string) => void): void {
    this.closeCbs.push(cb);
  }

  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.peer?.closeFromPeer();
    for (const cb of this.closeCbs) cb(reason);
  }

  /** 直接向本侧投递原始字节（绕过对侧 send，用于注入畸形/伪造帧）。 */
  deliverRaw(data: Uint8Array): void {
    this.receive(data);
  }

  private closeFromPeer(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb(undefined);
  }

  private receive(data: Uint8Array): void {
    if (this.closed) return;
    const decoded = decodeFrame(data);
    if (decoded === null) return; // 非 aifly 家族：静默蒸发（混流共存）
    for (const cb of this.frameCbs) cb(decoded);
  }
}

export function createLoopbackPair(): { a: LoopbackTransport; b: LoopbackTransport } {
  const a = new LoopbackTransport();
  const b = new LoopbackTransport();
  a.peer = b;
  b.peer = a;
  return { a, b };
}
