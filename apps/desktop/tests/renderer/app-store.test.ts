import { beforeEach, describe, expect, it } from "vitest";
import {
  applyEventEnvelope,
  configureAppStore,
  createProject,
  createTask,
  handleConnected,
  MAX_EVENTS_PER_SESSION,
  refreshDiff,
  resetAppStore,
  respondPermission,
  selectProject,
  selectTask,
  sendFollowUp,
  spawnAgent,
  useAppStore,
  type AppStoreState,
  type RpcParams,
  type RpcPort,
} from "../../src/renderer/src/state/app-store.js";
import {
  STATIC_TOPIC,
  sessionEventsTopic,
  type EventEnvelope,
  type Session,
  type Task,
} from "@aether/contracts";

// P0-11 驾驶舱 store：注入缝（RpcPort 假件）驱动——连接引导、spawn 后事件推送落 store、
// 权限队列、事件去重/截断、渲染侧状态折叠与不可变更新断言。

const NOW = "2026-11-15T12:00:00.000Z";

function projectSummary(
  id: string,
  name: string,
): { id: string; name: string; rootPath: string; archivedAt: string | null } {
  return { id, name, rootPath: `D:\\tmp\\${id}`, archivedAt: null };
}

function taskOf(id: string, projectId: string, title: string): Task {
  return {
    id,
    projectId,
    parentTaskId: null,
    title,
    description: "",
    status: "todo",
    assigneeAgentProfileId: null,
    position: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function sessionOf(id: string, workspaceId: string, status: Session["status"]): Session {
  return {
    id,
    workspaceId,
    agentProfileId: "profile-1",
    externalSessionId: null,
    status,
    lineageParentId: null,
    checkpointRef: null,
    createdAt: NOW,
    lastActiveAt: NOW,
  };
}

function providerEvent(
  eventId: string,
  sessionId: string,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return { eventId, sessionId, occurredAt: NOW, ...overrides };
}

function envelope(topic: string, payload: unknown, seq = 1): EventEnvelope {
  return { topic, seq, emittedAt: NOW, payload: payload as never };
}

interface RecordedCall {
  method: string;
  params: RpcParams | undefined;
}

/** RPC 假件：按 method 脚本化应答；未脚本化方法返回 null（触发 wire 校验失败路径） */
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

/** 订满基础数据：1 项目 + 1 任务 + 1 会话（starting） */
async function bootstrapWithSession(rpc: FakeRpc): Promise<void> {
  rpc
    .on("subscribe", () => ({ cursor: 0 }))
    .on("projects.list", () => ({ items: [projectSummary("p1", "驾驶舱项目")] }))
    .on("tasks.list", () => ({ items: [taskOf("t1", "p1", "旅程任务")] }))
    .on("sessions.list", () => ({ items: [sessionOf("s1", "w1", "starting")] }))
    .on("sessions.listEvents", () => ({ events: [] }));
  configureAppStore(rpc);
  await handleConnected();
  await selectProject("p1");
  await selectTask("t1");
}

beforeEach(() => {
  resetAppStore();
});

describe("连接引导与订阅接线", () => {
  it("handleConnected：订阅静态 topic + 拉项目列表；booted 置位", async () => {
    const rpc = new FakeRpc();
    rpc
      .on("subscribe", () => ({ cursor: 0 }))
      .on("projects.list", () => ({
        items: [projectSummary("p1", "项目一")],
      }));
    configureAppStore(rpc);

    await handleConnected();
    const state = currentState();
    expect(state.booted).toBe(true);
    expect(state.projects).toHaveLength(1);
    const subscribeCall = rpc.calls.find((call) => call.method === "subscribe");
    expect(subscribeCall?.params?.["topics"]).toEqual([
      STATIC_TOPIC.taskUpdated,
      STATIC_TOPIC.workspaceStatus,
      STATIC_TOPIC.agentStatus,
    ]);
  });

  it("subscribe 失败不阻断引导（lastError 置位、booted 仍完成）", async () => {
    const rpc = new FakeRpc();
    rpc.on("projects.list", () => ({ items: [] }));
    rpc.on("subscribe", () => {
      throw new Error("daemon 方法执行失败");
    });
    configureAppStore(rpc);
    await handleConnected();
    const state = currentState();
    expect(state.booted).toBe(true);
    expect(state.lastError).toContain("事件订阅失败");
  });

  it("会话发现后 subscribe 补订具体 session topic（一次多 topic）", async () => {
    const rpc = new FakeRpc();
    await bootstrapWithSession(rpc);
    const subscribes = rpc.calls.filter((call) => call.method === "subscribe");
    const last = subscribes.at(-1);
    // 缺 subscribe 调用时兜底空数组（可选链短路成 undefined 再取成员会 TypeError）
    const topics = (last?.params?.["topics"] ?? []) as string[];
    expect(topics.includes(sessionEventsTopic("s1"))).toBe(true);
  });
});

describe("项目/任务/会话动作", () => {
  it("createProject：projects.create → 刷新列表并选中（后续 tasks.list 联动）", async () => {
    const rpc = new FakeRpc();
    rpc
      .on("projects.list", () => ({ items: [projectSummary("p9", "新项目")] }))
      .on("projects.create", () => ({ id: "p9", name: "新项目" }))
      .on("tasks.list", () => ({ items: [] }));
    configureAppStore(rpc);

    const ok = await createProject("新项目", "D:\\tmp\\repo");
    expect(ok).toBe(true);
    const createCall = rpc.calls.find((call) => call.method === "projects.create");
    expect(createCall?.params).toEqual({ name: "新项目", rootPath: "D:\\tmp\\repo" });
    expect(currentState().selectedProjectId).toBe("p9");
  });

  it("createTask：无选中项目时拒绝并提示；成功后选中任务并拉会话", async () => {
    const rpc = new FakeRpc();
    configureAppStore(rpc);
    const rejected = await createTask("任务");
    expect(rejected).toBe(false);
    expect(currentState().lastError).toContain("先选择项目");

    rpc.on("tasks.list", () => ({ items: [taskOf("t2", "p1", "任务二")] }));
    rpc.on("tasks.create", () => taskOf("t2", "p1", "任务二"));
    rpc.on("sessions.list", () => ({ items: [] }));
    await selectProject("p1");
    const ok = await createTask("任务二");
    expect(ok).toBe(true);
    expect(currentState().selectedTaskId).toBe("t2");
  });

  it("spawnAgent：agents.spawn 只带 taskId+prompt（agentProfileId 缺省=daemon 默认）；spawn 后刷新会话并激活", async () => {
    const rpc = new FakeRpc();
    await bootstrapWithSession(rpc);
    rpc
      .on("agents.spawn", () => ({ sessionId: "s2", workspaceId: "w2", status: "starting" }))
      .on("sessions.list", () => ({
        items: [sessionOf("s1", "w1", "stopped"), sessionOf("s2", "w2", "starting")],
      }))
      .on("sessions.listEvents", () => ({ events: [] }));

    const ok = await spawnAgent("请完成 mock 任务");
    expect(ok).toBe(true);
    const spawnCall = rpc.calls.find((call) => call.method === "agents.spawn");
    expect(spawnCall?.params).toEqual({ taskId: "t1", prompt: "请完成 mock 任务" });
    expect(currentState().activeSessionId).toBe("s2");
  });

  it("sendFollowUp：agents.followUp 带 sessionId+message", async () => {
    const rpc = new FakeRpc();
    await bootstrapWithSession(rpc);
    rpc.on("agents.followUp", () => ({ sessionId: "s1", workspaceId: "w1", status: "running" }));
    await selectTask("t1");
    useAppStore.setState((previous) => ({ ...previous, activeSessionId: "s1" }));

    const ok = await sendFollowUp("继续");
    expect(ok).toBe(true);
    const call = rpc.calls.find((c) => c.method === "agents.followUp");
    expect(call?.params).toEqual({ sessionId: "s1", message: "继续" });
  });
});

describe("事件推送落 store（渲染侧 §8.1 折叠）", () => {
  it("message 事件：追加事件流 + 会话状态 starting→running（不可变更新）", async () => {
    const rpc = new FakeRpc();
    await bootstrapWithSession(rpc);
    const before = currentState();
    const beforeSessions = before.sessions;

    applyEventEnvelope(
      envelope(
        sessionEventsTopic("s1"),
        providerEvent("e1", "s1", { type: "message", content: "你好" }),
      ),
    );
    const state = currentState();
    expect(state.eventsBySession["s1"]).toHaveLength(1);
    expect(state.eventsBySession["s1"]?.[0]).toMatchObject({ type: "message", content: "你好" });
    expect(state.sessions.find((s) => s.id === "s1")?.status).toBe("running");
    // 不可变：旧状态对象未被改动
    expect(beforeSessions).not.toBe(state.sessions);
    expect(beforeSessions[0]?.status).toBe("starting");
    expect(before.eventsBySession["s1"]).toBeUndefined();
  });

  it("permission_request 事件：入队 + 状态 waiting；respondPermission 出队且不传 processId", async () => {
    const rpc = new FakeRpc();
    rpc.on("agents.permission.respond", () => null);
    await bootstrapWithSession(rpc);

    applyEventEnvelope(
      envelope(
        sessionEventsTopic("s1"),
        providerEvent("e2", "s1", {
          type: "permission_request",
          requestId: "req-1",
          toolName: "Bash",
          summary: "rm -rf /",
        }),
      ),
    );
    let state = currentState();
    expect(state.pendingPermissions).toHaveLength(1);
    expect(state.sessions[0]?.status).toBe("waiting");

    await respondPermission("req-1", "approve");
    const call = rpc.calls.find((c) => c.method === "agents.permission.respond");
    expect(call?.params).toEqual({ requestId: "req-1", decision: "approve" });
    state = currentState();
    expect(state.pendingPermissions).toHaveLength(0);
  });

  it("respondPermission 应答被拒：请求重入队（弹层复现）且置 lastError，不静默", async () => {
    const rpc = new FakeRpc();
    rpc.on("agents.permission.respond", () => {
      throw new Error("未知 requestId");
    });
    await bootstrapWithSession(rpc);
    applyEventEnvelope(
      envelope(
        sessionEventsTopic("s1"),
        providerEvent("e9", "s1", {
          type: "permission_request",
          requestId: "req-rollback",
          toolName: "Bash",
          summary: "危险命令",
        }),
      ),
    );
    expect(currentState().pendingPermissions).toHaveLength(1);

    await respondPermission("req-rollback", "deny");
    const state = currentState();
    // 回滚：应答失败后请求重新入队（弹层复现，应答路径可达）
    expect(state.pendingPermissions).toHaveLength(1);
    expect(state.pendingPermissions[0]?.requestId).toBe("req-rollback");
    expect(state.lastError).toContain("权限应答失败");
  });

  it("session 终态事件：active 会话 → stopped 且清待批权限；终态吸收后续事件", async () => {
    const rpc = new FakeRpc();
    await bootstrapWithSession(rpc);
    applyEventEnvelope(
      envelope(
        sessionEventsTopic("s1"),
        providerEvent("e2", "s1", {
          type: "permission_request",
          requestId: "req-1",
          toolName: "Bash",
          summary: "危险命令",
        }),
      ),
    );
    applyEventEnvelope(
      envelope(
        sessionEventsTopic("s1"),
        providerEvent("e3", "s1", { type: "session", externalSessionId: "ext-1" }),
      ),
    );
    let state = currentState();
    expect(state.sessions[0]?.status).toBe("stopped");
    expect(state.pendingPermissions).toHaveLength(0); // 终态落地即清该会话待批

    applyEventEnvelope(
      envelope(
        sessionEventsTopic("s1"),
        providerEvent("e4", "s1", { type: "message", content: "迟到" }),
      ),
    );
    state = currentState();
    expect(state.sessions[0]?.status).toBe("stopped"); // 终态吸收
    expect(state.eventsBySession["s1"]).toHaveLength(3); // 事件流本身仍完整追加
  });

  it("agent.status topic 投影：载荷合法即更新；非法载荷忽略", async () => {
    const rpc = new FakeRpc();
    await bootstrapWithSession(rpc);
    applyEventEnvelope(
      envelope(STATIC_TOPIC.agentStatus, {
        sessionId: "s1",
        workspaceId: "w1",
        taskId: "t1",
        status: "running",
      }),
    );
    expect(currentState().sessions[0]?.status).toBe("running");
    applyEventEnvelope(
      envelope(STATIC_TOPIC.agentStatus, { sessionId: "s1", status: "不存在的状态" }, 2),
    );
    expect(currentState().sessions[0]?.status).toBe("running");
  });

  it("task.updated topic 投影：{task} 包装（contracts schema）替换列表内同 id 项；未知任务忽略", async () => {
    const rpc = new FakeRpc();
    await bootstrapWithSession(rpc);
    const updated = { ...taskOf("t1", "p1", "旅程任务"), status: "in_progress" as const };
    applyEventEnvelope(envelope(STATIC_TOPIC.taskUpdated, { task: updated }));
    expect(currentState().tasks[0]?.status).toBe("in_progress");
    applyEventEnvelope(
      envelope(STATIC_TOPIC.taskUpdated, { task: taskOf("t9", "p1", "别家的") }, 2),
    );
    expect(currentState().tasks).toHaveLength(1);
  });

  it("非法 ProviderEvent 载荷丢弃（wire fail-closed），事件流与状态不受影响", async () => {
    const rpc = new FakeRpc();
    await bootstrapWithSession(rpc);
    applyEventEnvelope(envelope(sessionEventsTopic("s1"), { type: "message" /* 缺必填键 */ }));
    const state = currentState();
    expect(state.eventsBySession["s1"]).toBeUndefined();
    expect(state.sessions[0]?.status).toBe("starting");
  });

  it("重复事件（同 eventId+occurredAt）去重；不同轮次同 eventId 不误删；超限截断", async () => {
    const rpc = new FakeRpc();
    await bootstrapWithSession(rpc);
    const event = providerEvent("e1", "s1", { type: "message", content: "同一条" });
    applyEventEnvelope(envelope(sessionEventsTopic("s1"), event));
    applyEventEnvelope(envelope(sessionEventsTopic("s1"), event, 2));
    expect(currentState().eventsBySession["s1"]).toHaveLength(1);

    // 第二轮回放：同 eventId、不同 occurredAt → 保留
    applyEventEnvelope(
      envelope(
        sessionEventsTopic("s1"),
        providerEvent("e1", "s1", {
          type: "message",
          content: "回放",
          occurredAt: "2026-11-15T12:00:05.000Z",
        }),
        3,
      ),
    );
    expect(currentState().eventsBySession["s1"]).toHaveLength(2);

    for (let i = 0; i < MAX_EVENTS_PER_SESSION + 20; i += 1) {
      applyEventEnvelope(
        envelope(
          sessionEventsTopic("s1"),
          providerEvent(`bulk-${i}`, "s1", { type: "message", content: `m${i}` }),
          100 + i,
        ),
      );
    }
    const events = currentState().eventsBySession["s1"] ?? [];
    expect(events).toHaveLength(MAX_EVENTS_PER_SESSION);
    // 2 条既有 + 520 条灌入 = 522，截断保留最新 500 → 最早保留 bulk-20、最晚 bulk-519
    expect(events.at(0)?.eventId).toBe("bulk-20");
    expect(events.at(-1)?.eventId).toBe("bulk-519");
  });

  it("未消费 topic（workspace.status / terminal.*）静默忽略", async () => {
    const rpc = new FakeRpc();
    await bootstrapWithSession(rpc);
    applyEventEnvelope(envelope(STATIC_TOPIC.workspaceStatus, { id: "w1", status: "ready" }));
    applyEventEnvelope(envelope("terminal.t1.output", { type: "output", data: "aGk=" }));
    const state = currentState();
    expect(state.eventsBySession["s1"]).toBeUndefined();
    expect(state.lastError).toBeNull();
  });
});

describe("diff 缓存", () => {
  it("refreshDiff：按活动会话 workspaceId 拉取并校验形状；无活动会话拒绝", async () => {
    const rpc = new FakeRpc();
    configureAppStore(rpc);
    const rejected = await refreshDiff();
    expect(rejected).toBe(false);
    expect(currentState().lastError).toContain("无活动会话");

    await bootstrapWithSession(rpc);
    useAppStore.setState((previous) => ({ ...previous, activeSessionId: "s1" }));
    rpc.on("diff.workspaceDiff", () => ({
      workspaceId: "w1",
      baseBranch: "main",
      files: [{ path: "a.md", status: "added", patch: "+ 新行\n" }],
    }));
    const ok = await refreshDiff();
    expect(ok).toBe(true);
    expect(currentState().diff).toMatchObject({ baseBranch: "main", files: [{ path: "a.md" }] });
    const call = rpc.calls.find((c) => c.method === "diff.workspaceDiff");
    expect(call?.params).toEqual({ workspaceId: "w1" });
  });

  it("diff 形状非法 → lastError 且不清空旧缓存", async () => {
    const rpc = new FakeRpc();
    await bootstrapWithSession(rpc);
    useAppStore.setState((previous) => ({ ...previous, activeSessionId: "s1" }));
    rpc.on("diff.workspaceDiff", () => ({
      workspaceId: "w1",
      baseBranch: "main",
      files: "不是数组",
    }));
    const ok = await refreshDiff();
    expect(ok).toBe(false);
    expect(currentState().lastError).toContain("diff.workspaceDiff 返回形状非法");
  });
});
