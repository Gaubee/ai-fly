// 自托管 opendweb server 管理（dweb-server 子进程生命周期）：
// settings.opendwebServer 为唯一事实源——apply() 对账（配置变化重启、
// enabled 翻转启停），崩溃经 ServerHandle.exited 观测记入 lastError。
// startImpl 注入面：单测用假件；运行时默认动态 import 二进制包（保持
// 测试面零子进程依赖）。

import type { OpendwebServerConfig } from "../shared/rpc-contract.ts";

/** 二进制包 ServerHandle 的最小结构面（避免把子进程包拉进类型面）。 */
export interface OpendwebServerHandle {
  pid: number;
  gatewayUrl: string;
  relayHttpUrl: string;
  stop(): Promise<void>;
  exited: Promise<number>;
}

export type OpendwebStartFn = (config: OpendwebServerConfig) => Promise<OpendwebServerHandle>;

/** 默认启动器：relayBind 单独透传（gatewayBind/relayEnabled 同名直传）。 */
async function defaultStart(config: OpendwebServerConfig): Promise<OpendwebServerHandle> {
  const { startServer } = await import("@jixo/opendweb-server-binary");
  const handle = await startServer({
    gatewayBind: config.gatewayBind,
    relayBind: config.relayBind,
    relayEnabled: config.relayEnabled,
  });
  return handle;
}

export interface OpendwebStatusView {
  running: boolean;
  pid?: number;
  gatewayUrl?: string;
  relayHttpUrl?: string;
  lastError?: string;
  config: OpendwebServerConfig | null;
}

export class OpendwebServerManager {
  private handle: OpendwebServerHandle | null = null;
  private appliedConfig: OpendwebServerConfig | null = null;
  private lastError: string | undefined;
  private busy = false;
  private readonly startImpl: OpendwebStartFn;
  private readonly log: { error(message: string): void };

  constructor(
    startImpl: OpendwebStartFn = defaultStart,
    log: { error(message: string): void } = { error: () => undefined },
  ) {
    this.startImpl = startImpl;
    this.log = log;
  }

  status(): OpendwebStatusView {
    return {
      running: this.handle !== null,
      ...(this.handle !== null
        ? {
            pid: this.handle.pid,
            gatewayUrl: this.handle.gatewayUrl,
            relayHttpUrl: this.handle.relayHttpUrl,
          }
        : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
      config: this.appliedConfig,
    };
  }

  /**
   * 对账 settings.opendwebServer：null/undefined/disabled → 停；
   * enabled → 未跑则启、配置变化则重启（同配置 no-op）。
   */
  async apply(config: OpendwebServerConfig | null | undefined): Promise<void> {
    if (this.busy) throw new Error("opendweb server: apply already in flight");
    this.busy = true;
    try {
      const wanted = config !== null && config !== undefined && config.enabled ? config : null;
      if (wanted === null) {
        await this.stop();
        return;
      }
      const running = this.handle !== null;
      const unchanged =
        running &&
        this.appliedConfig !== null &&
        sameConfig(this.appliedConfig, wanted);
      if (unchanged) return;
      if (running) await this.stop();
      this.lastError = undefined;
      try {
        const handle = await this.startImpl(wanted);
        this.handle = handle;
        this.appliedConfig = wanted;
        // 崩溃观测：非正常退出记 lastError（stop() 主动停置零）
        void handle.exited.then((code) => {
          if (this.handle === handle) {
            this.handle = null;
            if (code !== 0) this.lastError = `opendweb server exited with code ${code}`;
          }
        });
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.log.error(`opendweb server start failed: ${this.lastError}`);
      }
    } finally {
      this.busy = false;
    }
  }

  /** 主动停（幂等；观测器据 handle 身份自净）。 */
  async stop(): Promise<void> {
    const handle = this.handle;
    if (handle === null) return;
    this.handle = null;
    this.appliedConfig = null;
    this.lastError = undefined;
    try {
      await handle.stop();
    } catch (error) {
      this.log.error(`opendweb server stop failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function sameConfig(a: OpendwebServerConfig, b: OpendwebServerConfig): boolean {
  return (
    a.enabled === b.enabled &&
    a.gatewayBind === b.gatewayBind &&
    a.relayBind === b.relayBind &&
    a.relayEnabled === b.relayEnabled
  );
}

/** relay URL 推导（fabric 可用形态：http(s):// + relayBind）。 */
export function relayUrlOf(config: OpendwebServerConfig): string {
  return `http://${config.relayBind}`;
}
