import { beforeEach, describe, expect, it } from "vitest";
import type { Session, Task } from "@aether/contracts";
import {
  configureAppStore,
  resetAppStore,
  selectProviderKind,
  spawnAgent,
  useAppStore,
  type AppStoreState,
  type RpcParams,
  type RpcPort,
} from "../../src/renderer/src/state/app-store.js";
import {
  capabilityOf,
  isProviderKind,
  PROVIDER_CAPABILITIES,
  SPAWN_PROVIDER_KINDS,
} from "../../src/renderer/src/state/provider-capabilities.js";

// P1-01 支撑件：provider 会话恢复能力差异标注——静态能力表内容口径（协议定案 §5
// 差异表）、徽标引用稳定性（模块级冻结常量，防渲染抖动）、store 动作（选择器不可变
// 更新 + spawn 本地记录 kind + spawn 载荷显式携带 providerKind——F2 接线后真实
// 驱动 daemon 路由）。

const NOW = "2026-11-15T12:00:00.000Z";

function sessionOf(id: string): Session {
  return {
    id,
    workspaceId: `ws-${id}`,
    agentProfileId: "profile-1",
    externalSessionId: null,
    status: "starting",
    lineageParentId: null,
    checkpointRef: null,
    createdAt: NOW,
    lastActiveAt: NOW,
  };
}

function taskOf(id: string, projectId: string): Task {
  return {
    id,
    projectId,
    parentTaskId: null,
    title: "旅程任务",
    description: "",
    status: "todo",
    assigneeAgentProfileId: null,
    position: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

interface RecordedCall {
  method: string;
  params: RpcParams | undefined;
}

/** RPC 假件：按 method 脚本化应答并记录调用（对照 app-store.test.ts 的 FakeRpc 模式） */
class FakeRpc implements RpcPort {
  readonly calls: RecordedCall[] = [];
  private readonly handlers = new Map<string, (params?: RpcParams) => unknown>();

  on(method: string, handler: (params?: RpcParams) => unknown): this {
    this.handlers.set(method, handler);
    return this;
  }

  async request<T>(method: string, params?: RpcParams): Promise<T> {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    return (handler?.(params) ?? null) as T;
  }
}

function currentState(): AppStoreState {
  return useAppStore.getState();
}

/** 最小可 spawn 环境：任务已选 + sessions.list 可见性即时命中 */
function bootstrapSpawn(rpc: FakeRpc): void {
  rpc
    .on("subscribe", () => ({ cursor: 0 }))
    .on("sessions.list", () => ({ items: [sessionOf("s-spawn")] }))
    .on("sessions.listEvents", () => ({ events: [] }))
    .on("agents.spawn", () => ({
      sessionId: "s-spawn",
      workspaceId: "ws-s-spawn",
      status: "starting",
    }));
  configureAppStore(rpc);
  useAppStore.setState((previous) => ({
    ...previous,
    selectedProjectId: "p1",
    selectedTaskId: "t1",
    tasks: [taskOf("t1", "p1")],
  }));
}

beforeEach(() => {
  resetAppStore();
});

describe("provider 能力表（协议定案 §5 差异口径）", () => {
  it("claude-sdk 与 codex-app-server 均可恢复，且差异标注与协议 §5 表逐条对应", () => {
    const claude = PROVIDER_CAPABILITIES["claude-sdk"];
    const codex = PROVIDER_CAPABILITIES["codex-app-server"];

    expect(claude.canResume).toBe(true);
    expect(claude.resumeSummary).toContain("--resume");
    expect(claude.badges.join("\n")).toContain("历史水合：SDK 内部完成");
    expect(claude.badges.join("\n")).toContain("不支持 rejoin");

    expect(codex.canResume).toBe(true);
    expect(codex.resumeSummary).toContain("threadId");
    // F7：恢复徽标带限定语——能力为真但 UI 恢复入口随 P3-01 落地（不放话）
    expect(codex.badges).toContain("支持会话恢复（thread/resume，入口随 P3-01 落地）");
    expect(claude.badges).toContain("支持会话恢复（--resume，入口随 P3-01 落地）");
    expect(codex.badges.join("\n")).toContain("响应内嵌 turns");
    expect(codex.badges.join("\n")).toContain("支持 rejoin");
  });

  it("五个 ProviderKind 键完备；custom/acp/tui 为占位（canResume=false 不放话）", () => {
    expect(Object.keys(PROVIDER_CAPABILITIES).sort()).toEqual([
      "acp",
      "claude-sdk",
      "codex-app-server",
      "custom",
      "tui",
    ]);
    for (const kind of ["custom", "acp", "tui"] as const) {
      expect(PROVIDER_CAPABILITIES[kind].canResume).toBe(false);
    }
  });

  it("徽标为模块级冻结常量：重复取用引用稳定（防渲染层抖动）", () => {
    for (const kind of SPAWN_PROVIDER_KINDS) {
      const first = capabilityOf(kind);
      const second = capabilityOf(kind);
      expect(Object.is(first, second)).toBe(true);
      expect(Object.isFrozen(first.badges)).toBe(true);
    }
    expect(SPAWN_PROVIDER_KINDS).toEqual(["claude-sdk", "codex-app-server"]);
  });

  it("isProviderKind 运行时守卫：合法值通过，未知值拒绝", () => {
    expect(isProviderKind("claude-sdk")).toBe(true);
    expect(isProviderKind("codex-app-server")).toBe(true);
    expect(isProviderKind("openai")).toBe(false);
    expect(isProviderKind(42)).toBe(false);
    expect(isProviderKind(undefined)).toBe(false);
  });
});

describe("store：provider 选择与 spawn 记录", () => {
  it("缺省 selectedProviderKind=claude-sdk；selectProviderKind 不可变更新且同值 no-op", () => {
    expect(currentState().selectedProviderKind).toBe("claude-sdk");
    const before = currentState();

    selectProviderKind("codex-app-server");
    const after = currentState();
    expect(after.selectedProviderKind).toBe("codex-app-server");
    expect(after).not.toBe(before);
    expect(after.sessionProviderKinds).toBe(before.sessionProviderKinds); // 无关字段引用不动

    const onceMore = currentState();
    selectProviderKind("codex-app-server"); // 同值重复选择
    expect(currentState()).toBe(onceMore); // 返回原引用（短路，不产生新状态）
  });

  it("未知 kind 被边界守卫拒绝：置 lastError 且状态不动", () => {
    const before = currentState();
    selectProviderKind("bogus" as never);
    expect(currentState().selectedProviderKind).toBe(before.selectedProviderKind);
    expect(currentState().lastError).toContain("bogus");
  });

  it("spawn 载荷显式携带所选 providerKind（F2 接线：真实驱动 daemon 路由）；本地记录所选 kind", async () => {
    const rpc = new FakeRpc();
    bootstrapSpawn(rpc);

    // 缺省 claude-sdk：spawn 后本地记录；载荷显式携带 providerKind
    await spawnAgent("跑一遍");
    expect(currentState().sessionProviderKinds["s-spawn"]).toBe("claude-sdk");
    const spawnCall = rpc.calls.find((call) => call.method === "agents.spawn");
    expect(spawnCall?.params).toEqual({
      taskId: "t1",
      prompt: "跑一遍",
      providerKind: "claude-sdk",
    });

    // 切到 codex-app-server：载荷随之切换 + 新会话记录所选 kind（本地标注数据源）
    rpc.on("agents.spawn", () => ({
      sessionId: "s-codex",
      workspaceId: "ws-s-codex",
      status: "starting",
    }));
    rpc.on("sessions.list", () => ({
      items: [sessionOf("s-spawn"), sessionOf("s-codex")],
    }));
    selectProviderKind("codex-app-server");
    await spawnAgent("用 codex 跑");
    const codexCall = rpc.calls.filter((call) => call.method === "agents.spawn").at(-1);
    expect(codexCall?.params).toEqual({
      taskId: "t1",
      prompt: "用 codex 跑",
      providerKind: "codex-app-server",
    });
    expect(currentState().sessionProviderKinds["s-codex"]).toBe("codex-app-server");
    expect(currentState().sessionProviderKinds["s-spawn"]).toBe("claude-sdk"); // 既有记录不清
  });
});
