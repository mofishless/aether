// 渲染层本地 UI 状态（P0-10 骨架 store）：连接状态徽标 + 事件计数 + 状态迁移历史。
// 领域状态一律由 daemon 经契约推送（本卡只承接连接面）；zustand 仅承载渲染本地视图状态。
// 全部更新不可变：setState 返回新对象，历史数组以展开复制追加。
import { create } from "zustand";
import type { RpcClientSnapshot, RpcConnectionState } from "../rpc/rpc-client.js";

/** 迁移历史保留上限（环形截断：daemon 抖动时历史不无限增长） */
export const MAX_TRANSITIONS = 20;

export interface ConnectionStoreState {
  readonly connectionState: RpcConnectionState;
  readonly attempt: number;
  readonly daemonVersion: string | null;
  readonly protocolVersion: number | null;
  readonly eventsSubscribed: boolean;
  readonly eventCount: number;
  readonly lastError: string | null;
  /** 观测到的状态迁移序列（首个观测状态也计入；截断保留最新） */
  readonly transitions: readonly RpcConnectionState[];
}

const INITIAL_STATE: ConnectionStoreState = {
  connectionState: "connecting",
  attempt: 0,
  daemonVersion: null,
  protocolVersion: null,
  eventsSubscribed: false,
  eventCount: 0,
  lastError: null,
  transitions: [],
};

export const useConnectionStore = create<ConnectionStoreState>()(() => INITIAL_STATE);

/** 应用 RPC 客户端快照：状态变化时追加迁移历史（首个观测状态也计入） */
export function applyClientSnapshot(snapshot: RpcClientSnapshot): void {
  useConnectionStore.setState((previous) => {
    const stateChanged =
      previous.transitions.length === 0 || previous.connectionState !== snapshot.state;
    const transitions = stateChanged
      ? [...previous.transitions, snapshot.state].slice(-MAX_TRANSITIONS)
      : previous.transitions;
    return {
      connectionState: snapshot.state,
      attempt: snapshot.attempt,
      daemonVersion: snapshot.daemonVersion,
      protocolVersion: snapshot.protocolVersion,
      eventsSubscribed: snapshot.eventsSubscribed,
      lastError: snapshot.lastError,
      transitions,
    };
  });
}

/** 收到一条校验通过的 EventEnvelope：计数 +1（事件通道活性观测） */
export function recordEvent(): void {
  useConnectionStore.setState((previous) => ({ ...previous, eventCount: previous.eventCount + 1 }));
}

/** 恢复初始状态（测试隔离用；生产不调用） */
export function resetConnectionStore(): void {
  useConnectionStore.setState(INITIAL_STATE);
}
