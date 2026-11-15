import { beforeEach, describe, expect, it } from "vitest";
import {
  applyClientSnapshot,
  MAX_TRANSITIONS,
  recordEvent,
  resetConnectionStore,
  useConnectionStore,
  type ConnectionStoreState,
} from "../../src/renderer/src/state/connection-store.js";
import type { RpcClientSnapshot } from "../../src/renderer/src/rpc/rpc-client.js";

// 渲染层连接 store：不可变更新、状态迁移历史追加与截断（P0-10 骨架 store）。

function snapshot(overrides: Partial<RpcClientSnapshot>): RpcClientSnapshot {
  return {
    state: "connecting",
    attempt: 1,
    daemonVersion: null,
    protocolVersion: null,
    lastError: null,
    eventsSubscribed: false,
    ...overrides,
  };
}

function currentState(): ConnectionStoreState {
  return useConnectionStore.getState();
}

beforeEach(() => {
  resetConnectionStore();
});

describe("连接 store", () => {
  it("初始状态：connecting、零事件、空迁移历史", () => {
    const state = currentState();
    expect(state.connectionState).toBe("connecting");
    expect(state.eventCount).toBe(0);
    expect(state.transitions).toEqual([]);
    expect(state.daemonVersion).toBeNull();
  });

  it("applyClientSnapshot：状态变化时追加迁移历史，不变时只更新字段", () => {
    applyClientSnapshot(snapshot({ state: "connecting" }));
    applyClientSnapshot(snapshot({ state: "connected", daemonVersion: "1.2.3", attempt: 1 }));
    let state = currentState();
    expect(state.connectionState).toBe("connected");
    expect(state.daemonVersion).toBe("1.2.3");
    expect(state.transitions).toEqual(["connecting", "connected"]);

    // 同状态再快照：字段更新但不重复追加历史
    const before = state;
    applyClientSnapshot(snapshot({ state: "connected", daemonVersion: "1.4.0", attempt: 2 }));
    state = currentState();
    expect(state.daemonVersion).toBe("1.4.0");
    expect(state.attempt).toBe(2);
    expect(state.transitions).toEqual(["connecting", "connected"]);
    expect(before).not.toBe(state); // 不可变：生成新对象
  });

  it("applyClientSnapshot 不修改旧状态对象（不可变更新）", () => {
    applyClientSnapshot(snapshot({ state: "connected" }));
    const before = currentState();
    const beforeTransitions = before.transitions;
    applyClientSnapshot(snapshot({ state: "disconnected", lastError: "连接关闭" }));
    expect(before.connectionState).toBe("connected");
    expect(beforeTransitions).toEqual(["connected"]); // 首个观测状态即 connected（store 初始为空历史）
    expect(currentState().transitions).toEqual(["connected", "disconnected"]);
  });

  it("recordEvent 递增事件计数且不改动其他字段", () => {
    applyClientSnapshot(snapshot({ state: "connected" }));
    const before = currentState();
    recordEvent();
    recordEvent();
    const state = currentState();
    expect(state.eventCount).toBe(2);
    expect(before.eventCount).toBe(0);
    expect(state.connectionState).toBe("connected");
    expect(state.daemonVersion).toBe(before.daemonVersion);
  });

  it("迁移历史截断至上限，保留最新", () => {
    const states = ["connecting", "disconnected"] as const;
    for (let i = 0; i < MAX_TRANSITIONS + 5; i += 1) {
      applyClientSnapshot(snapshot({ state: states[i % 2] ?? "connecting", attempt: i + 1 }));
    }
    const state = currentState();
    expect(state.transitions.length).toBe(MAX_TRANSITIONS);
    // 最后一次迁移必在末尾
    expect(state.transitions.at(-1)).toBe(state.connectionState);
  });

  it("resetConnectionStore 恢复初始状态（测试隔离用）", () => {
    applyClientSnapshot(snapshot({ state: "connected", daemonVersion: "1.0.0" }));
    recordEvent();
    resetConnectionStore();
    expect(currentState().connectionState).toBe("connecting");
    expect(currentState().eventCount).toBe(0);
    expect(currentState().transitions).toEqual([]);
  });
});
