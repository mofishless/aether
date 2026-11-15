// daemon 启动器 · 心跳层：ws 协议层 ping/pong 周期探测。
// 超时阈值（默认 2×间隔）内无 pong 判死——挂死 daemon（事件循环冻结，如 --hang-signal）
// 收不到任何帧，pong 必然缺席。纯 TS（禁 import electron）；判死只回调一次，重连策略归 supervisor。
import { WebSocket } from "ws";

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;

export interface HeartbeatTimeoutDetail {
  readonly intervalMs: number;
  readonly timeoutMs: number;
  /** 判死时已静默的时长 */
  readonly silentMs: number;
}

export interface HeartbeatOptions {
  readonly socket: WebSocket;
  /** ping 间隔 ms，默认 5000 */
  readonly intervalMs?: number;
  /** 无 pong 判死阈值 ms，默认 2×intervalMs */
  readonly timeoutMs?: number;
  /** 判死回调（至多触发一次） */
  readonly onTimeout: (detail: HeartbeatTimeoutDetail) => void;
}

export interface HeartbeatHandle {
  stop(): void;
}

export function startHeartbeat(options: HeartbeatOptions): HeartbeatHandle {
  const { socket, onTimeout } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? intervalMs * 2;

  // 握手刚成功视为存活基线
  let lastPongAt = Date.now();
  let stopped = false;
  let fired = false;

  const onPong = (): void => {
    lastPongAt = Date.now();
  };
  socket.on("pong", onPong);

  const ping = (): void => {
    if (stopped || fired) return;
    if (socket.readyState === WebSocket.OPEN) {
      socket.ping();
    }
  };

  const timer = setInterval(() => {
    if (stopped || fired) return;
    const silentMs = Date.now() - lastPongAt;
    if (silentMs > timeoutMs) {
      fired = true;
      stop();
      onTimeout(Object.freeze({ intervalMs, timeoutMs, silentMs }));
      return;
    }
    ping();
  }, intervalMs);

  function stop(): void {
    stopped = true;
    clearInterval(timer);
    socket.off("pong", onPong);
  }

  ping(); // 立即首发：判死窗口从握手时刻起算，不等第一个间隔

  return { stop };
}
