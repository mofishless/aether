// agents 服务单测（P0-11）：假适配器 + 内存库 + 真 WorktreeLifecycleService（临时 git 仓库）。
// 覆盖：spawn 编排（session/process 行、emit 三发、状态机 fold、投影发布）、followUp/cancel/
// permission.respond 注册表语义、listSessionEvents 合并、错误映射（INVALID_PARAMS/INTERNAL）。
// 全链 mock CLI 集成（真 SDK spawn）另见 agents-mock-cli.integration.test.ts。
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ProviderEventSchema,
  STATIC_TOPIC,
  sessionEventsTopic,
  sessionStateTopic,
} from "@aether/contracts";
import type { ProviderEvent } from "@aether/contracts";
import {
  INITIAL_AGENT_STATUS,
  WorktreeLifecycleService,
  type AdapterCapabilities,
  type AdapterContext,
  type AgentAdapter,
  type AgentProcess,
  type DiscoverResult,
  type SessionRecord,
  type SpawnInput,
} from "@aether/core";
import { ExecutionLogSink } from "@aether/core";
import {
  AgentProfileRepository,
  ExecutionProcessLogRepository,
  ExecutionProcessRepository,
  ProjectRepository,
  ProviderConfigRepository,
  SessionRepository,
  TaskRepository,
  WorkspaceRepository,
  closeDatabase,
  openStorage,
} from "@aether/storage";
import type { DatabaseSync } from "node:sqlite";
import { AgentService } from "../src/agents/agents-service.js";
import { ServiceError } from "../src/service-error.js";
import { createEventBus } from "../src/events/event-bus.js";

// ===== 假适配器：记录调用、emit 由测试经捕获的 ctx 驱动、退出证明受控 =====
class FakeAdapter implements AgentAdapter {
  readonly kind = "claude-sdk" as const;
  readonly capabilities: AdapterCapabilities = {
    canResume: true,
    followUpAtMessage: false,
    permissionFlags: true,
    structuredEvents: true,
    protocols: [],
  };
  spawnCalls: SpawnInput[] = [];
  followUpCalls: { message: string }[] = [];
  cancelReasons: string[] = [];
  permissionCalls: { processId: string; requestId: string; decision: string }[] = [];
  disposedCount = 0;
  lastCtx: AdapterContext | null = null;
  lastProc: AgentProcess | null = null;
  failSpawn = false;
  failFollowUp = false;
  failPermission = false;
  private exitSettle: ((proof: { code: number | null; signal?: string }) => void) | null = null;

  async spawn(input: SpawnInput, ctx: AdapterContext): Promise<AgentProcess> {
    this.spawnCalls.push(input);
    this.lastCtx = ctx;
    if (this.failSpawn) {
      throw new Error("假适配器 spawn 失败");
    }
    const exited = new Promise<{ code: number | null; signal?: string }>((resolve) => {
      this.exitSettle = resolve;
    });
    const proc: AgentProcess = {
      processId: `fake-proc-${this.spawnCalls.length}`,
      pid: 4321,
      cancel: async (reason) => {
        this.cancelReasons.push(reason);
      },
      exited,
    };
    this.lastProc = proc;
    return proc;
  }

  async spawnFollowUp(proc: AgentProcess, input: { message: string }, ctx: AdapterContext) {
    this.followUpCalls.push(input);
    this.lastCtx = ctx;
    if (this.failFollowUp) {
      throw new Error("假适配器 followUp 失败");
    }
  }

  async discover(): Promise<DiscoverResult> {
    return { available: true };
  }

  async resume(_session: SessionRecord, _ctx: AdapterContext): Promise<AgentProcess> {
    throw new Error("测试不使用 resume");
  }

  async cancel(proc: AgentProcess, reason: string) {
    this.cancelReasons.push(reason);
  }

  async resolvePermission(processId: string, requestId: string, decision: string) {
    if (this.failPermission) {
      throw new Error("无待决权限请求（假适配器）");
    }
    this.permissionCalls.push({ processId, requestId, decision });
  }

  normalizeLogs() {
    return [];
  }

  async dispose() {
    this.disposedCount += 1;
  }

  /** 测试驱动：进程退出证明到达 */
  settleExit(code: number | null): void {
    this.exitSettle?.({ code });
  }
}

// ===== 测试装置 =====
interface Harness {
  readonly db: DatabaseSync;
  readonly adapter: FakeAdapter;
  readonly service: AgentService;
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly workspaces: WorkspaceRepository;
  readonly profiles: AgentProfileRepository;
  readonly sessions: SessionRepository;
  readonly processes: ExecutionProcessRepository;
  readonly envelopes: { topic: string; payload: Record<string, unknown>; seq: number }[];
  readonly replayByProcess: Map<string, ProviderEvent[]>;
  dispose(): void;
}

function createHarness(options: { gitRoot?: string } = {}): Harness {
  const db = openStorage(":memory:");
  const eventBus = createEventBus();
  const envelopes: Harness["envelopes"] = [];
  eventBus.addListener((frame) => {
    const notification = JSON.parse(frame) as {
      method: string;
      params: { topic: string; payload: Record<string, unknown>; seq: number };
    };
    if (notification.method === "event") {
      envelopes.push(notification.params);
    }
  });
  const projects = new ProjectRepository(db);
  const tasks = new TaskRepository(db);
  const workspaces = new WorkspaceRepository(db);
  const profiles = new AgentProfileRepository(db);
  const sessions = new SessionRepository(db);
  const processes = new ExecutionProcessRepository(db);
  const logSink = new ExecutionLogSink({
    store: new ExecutionProcessLogRepository(db),
    onError: () => undefined,
  });
  const adapter = new FakeAdapter();
  const replayByProcess = new Map<string, ProviderEvent[]>();
  const worktrees = new WorktreeLifecycleService({
    store: workspaces,
    fallbackDir: join(tmpdir(), `aether-agents-fallback-${randomUUID().slice(0, 8)}`),
  });
  const service = new AgentService({
    eventBus,
    projects,
    tasks,
    workspaces,
    profiles,
    providerConfigs: new ProviderConfigRepository(db),
    sessions,
    processes,
    worktrees,
    createEventContext: (input) => ({
      worktreePath: input.worktreePath,
      env: input.env ?? {},
      loadEvents: input.loadEvents,
      emit: () => undefined, // 落库路径由集成测试覆盖；单测只测服务层三发包装
    }),
    replayProcessLogs: (processId) => ({
      events: replayByProcess.get(processId) ?? [],
      backfilledRowCount: 0,
    }),
    logSink,
    createAdapterInstance: () => adapter,
    log: () => undefined,
  });
  return {
    db,
    adapter,
    service,
    projects,
    tasks,
    workspaces,
    profiles,
    sessions,
    processes,
    envelopes,
    replayByProcess,
    dispose() {
      closeDatabase(db);
      if (options.gitRoot !== undefined) {
        rmSync(options.gitRoot, { recursive: true, force: true });
      }
    },
  };
}

// provider 配置档/事件构造的工具函数在文件顶部统一 import（见文件头 import 块）

/** 事件构造（ProviderEventSchema 形状；occurredAt 固定值） */
function makeEvent(sessionId: string, patch: Partial<ProviderEvent>): ProviderEvent {
  return ProviderEventSchema.parse({
    eventId: `ev-${randomUUID().slice(0, 8)}`,
    sessionId,
    occurredAt: "2026-11-15T00:00:00.000Z",
    ...patch,
  });
}

describe("agents.spawn 编排（假适配器 + 显式 workspaceId）", () => {
  let h: Harness;

  beforeAll(() => {
    h = createHarness();
  });
  afterAll(() => {
    h.dispose();
  });

  let seedCount = 0;

  function seed(): { taskId: string; workspaceId: string; profileId: string } {
    // rootPath 是项目唯一身份：多次 seed 须各自唯一
    seedCount += 1;
    const project = h.projects.create({ name: "P", rootPath: `D:\\p-${seedCount}` });
    const task = h.tasks.create({ projectId: project.id, title: "T" });
    const workspace = h.workspaces.create({
      projectId: project.id,
      name: `w-${seedCount}`,
      branch: `aether/w-${seedCount}`,
      worktreePath: `D:\\wt\\w-${seedCount}`,
      storageKey: `w-${seedCount}`,
    });
    const profileId = h.profiles.findAll()[0]?.id ?? "";
    return { taskId: task.id, workspaceId: workspace.id, profileId };
  }

  it("未知 taskId → ServiceError invalid_params（中文消息）", async () => {
    const seeded = seed();
    await expect(
      h.service.spawn({ taskId: "no-such", agentProfileId: seeded.profileId, prompt: "hi" }),
    ).rejects.toMatchObject({ kind: "invalid_params" });
    await expect(
      h.service.spawn({
        taskId: "no-such",
        agentProfileId: seeded.profileId,
        prompt: "hi",
      }),
    ).rejects.toThrow(/未知任务/);
  });

  it("未知 agentProfileId → invalid_params；未知 workspaceId → invalid_params", async () => {
    const seeded = seed();
    await expect(
      h.service.spawn({
        taskId: seeded.taskId,
        agentProfileId: "no-profile",
        prompt: "hi",
      }),
    ).rejects.toThrow(/未知 agent 配置档/);
    await expect(
      h.service.spawn({
        taskId: seeded.taskId,
        workspaceId: "no-workspace",
        agentProfileId: seeded.profileId,
        prompt: "hi",
      }),
    ).rejects.toThrow(/未知工作区/);
  });

  it("全链：session/process 行 + emit 三发 + 状态机 fold + 投影 + pid 回写", async () => {
    const seeded = seed();
    const handle = await h.service.spawn({
      taskId: seeded.taskId,
      workspaceId: seeded.workspaceId,
      agentProfileId: seeded.profileId,
      prompt: "接线测试",
    });
    const sessionId = handle.sessionId;
    expect(handle.workspaceId).toBe(seeded.workspaceId);
    expect(handle.status).toBe(INITIAL_AGENT_STATUS);

    // adapter 入参：autonomy 缺省只读（fail-closed 定案）
    expect(h.adapter.spawnCalls).toHaveLength(1);
    expect(h.adapter.spawnCalls[0]).toMatchObject({
      sessionId,
      message: "接线测试",
      autonomy: "read_only",
    });

    // 行：session starting；process coding_agent + kind 归属 + pid 回写
    const session = h.sessions.findById(sessionId);
    expect(session?.status).toBe("starting");
    const rows = h.processes.findAll().filter((row) => row.sessionId === sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runReason).toBe("coding_agent");
    expect(JSON.parse(rows[0]?.commandJson ?? "{}")).toEqual({ kind: "claude-sdk" });
    expect(rows[0]?.pid).toBe(4321);
    expect(rows[0]?.status).toBe("running");

    // 初始状态点 + spawn 成功后的 task.updated
    const agentStatuses = h.envelopes.filter((e) => e.topic === STATIC_TOPIC.agentStatus);
    expect(agentStatuses[0]?.payload).toMatchObject({ sessionId, status: "starting" });
    expect(h.envelopes.some((e) => e.topic === STATIC_TOPIC.taskUpdated)).toBe(true);

    // 驱动泵：session(init) → ready；message → running；session(终) → stopped
    const ctx = h.adapter.lastCtx;
    expect(ctx).not.toBeNull();
    ctx?.emit(makeEvent(sessionId, { type: "session", externalSessionId: null }));
    ctx?.emit(makeEvent(sessionId, { type: "message", content: "干活" }));
    ctx?.emit(makeEvent(sessionId, { type: "session", externalSessionId: "ext-1" }));

    const states = h.envelopes
      .filter((e) => e.topic === sessionStateTopic(sessionId))
      .map((e) => {
        const payload = e.payload as { previous: string; status: string };
        return { previous: payload.previous, status: payload.status };
      });
    expect(states).toEqual([
      { previous: "starting", status: "ready" },
      { previous: "ready", status: "running" },
      { previous: "running", status: "stopped" },
    ]);
    // session 行状态随迁移推进
    expect(h.sessions.findById(sessionId)?.status).toBe("stopped");
    // session.<id>.events 归一化流发布（三发之②）
    const eventStream = h.envelopes.filter((e) => e.topic === sessionEventsTopic(sessionId));
    expect(eventStream).toHaveLength(3);
    // agent.status 投影推到位（发射后重新过滤——上面快照早于泵驱动）
    const latestStatuses = h.envelopes.filter((e) => e.topic === STATIC_TOPIC.agentStatus);
    expect(latestStatuses.at(-1)?.payload).toMatchObject({ sessionId, status: "stopped" });
    // 终态保守写：进程行 exited（无退出证明时）
    expect(h.processes.findById(rows[0]?.id ?? "")?.status).toBe("exited");
  });
});

describe("agents 缺省 worktree（真临时 git 仓库）", () => {
  it("workspaceId 缺省 → createForTask（rootPath 下建 worktree+分支）+ workspace.status 投影", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), `aether-agents-git-${randomUUID().slice(0, 8)}-`));
    const projectRoot = join(baseDir, "project");
    mkdirSync(projectRoot);
    const git = (args: readonly string[]): string =>
      execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", windowsHide: true }).trim();
    git(["init"]);
    git(["config", "user.email", "aether@test.local"]);
    git(["config", "user.name", "Aether Test"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(projectRoot, "README.md"), "# agents service fixture\n");
    git(["add", "-A"]);
    git(["commit", "-m", "init"]);

    const h = createHarness({ gitRoot: baseDir });
    try {
      const project = h.projects.create({ name: "P", rootPath: projectRoot });
      const task = h.tasks.create({ projectId: project.id, title: "T" });
      const profileId = h.profiles.findAll()[0]?.id ?? "";
      const handle = await h.service.spawn({
        taskId: task.id,
        agentProfileId: profileId,
        prompt: "缺省工作区",
      });
      // worktree 落盘 + 分支存在（持久预留先行 → ready）
      const workspace = h.workspaces.findById(handle.workspaceId);
      expect(workspace?.status).toBe("ready");
      expect(workspace?.taskId).toBe(task.id);
      expect(workspace?.branch.startsWith("aether/")).toBe(true);
      const branchList = git(["branch", "--list", workspace?.branch ?? ""]);
      expect(branchList).toContain(workspace?.branch ?? "");
      // workspace.status 投影发布
      const statusEvents = h.envelopes.filter((e) => e.topic === STATIC_TOPIC.workspaceStatus);
      expect(statusEvents.at(-1)?.payload).toMatchObject({
        workspaceId: handle.workspaceId,
        projectId: project.id,
        status: "ready",
      });
      h.adapter.settleExit(0);
    } finally {
      h.dispose();
    }
  }, 30_000);
});

describe("followUp / cancel / permission.respond（注册表语义）", () => {
  let h: Harness;
  let sessionId: string;

  beforeAll(async () => {
    h = createHarness();
    const project = h.projects.create({ name: "P", rootPath: "D:\\p" });
    const task = h.tasks.create({ projectId: project.id, title: "T" });
    const workspace = h.workspaces.create({
      projectId: project.id,
      name: "w-2",
      branch: "aether/w-2",
      worktreePath: "D:\\wt\\w-2",
      storageKey: "w-2",
    });
    const profileId = h.profiles.findAll()[0]?.id ?? "";
    const handle = await h.service.spawn({
      taskId: task.id,
      workspaceId: workspace.id,
      agentProfileId: profileId,
      prompt: "第一轮",
    });
    sessionId = handle.sessionId;
  });
  afterAll(() => {
    h.dispose();
  });

  it("未知 sessionId followUp/cancel → invalid_params 中文（daemon 重启表清空语义）", async () => {
    await expect(h.service.followUp({ sessionId: "ghost", message: "m" })).rejects.toThrow(
      /会话未在运行/,
    );
    await expect(h.service.cancel({ sessionId: "ghost" })).rejects.toThrow(/会话未在运行/);
  });

  it("followUp：新 follow_up 进程行 + 同一 proc 追问", async () => {
    await h.service.followUp({ sessionId, message: "接着说" });
    expect(h.adapter.followUpCalls).toHaveLength(1);
    expect(h.adapter.followUpCalls[0]?.message).toBe("接着说");
    const rows = h.processes.findAll().filter((row) => row.sessionId === sessionId);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.runReason).toBe("follow_up");
    expect(JSON.parse(rows[1]?.commandJson ?? "{}")).toEqual({ kind: "claude-sdk" });
  });

  it("permission.respond：当前 run 行 id 命中（双口径含 adapter id）；未知 → invalid_params", async () => {
    await expect(
      h.service.respondPermission({ processId: "ghost", requestId: "r", decision: "approve" }),
    ).rejects.toThrow(/权限应答无对应运行会话/);
    // followUp 已推进 entry.processId 到 follow_up 行：查表口径 = 当前 run 行 id（at(-1)）
    const rowId =
      h.processes
        .findAll()
        .filter((r) => r.sessionId === sessionId)
        .at(-1)?.id ?? "";
    await h.service.respondPermission({
      processId: rowId,
      requestId: "req-1",
      decision: "deny",
    });
    expect(h.adapter.permissionCalls).toEqual([
      { processId: h.adapter.lastProc?.processId, requestId: "req-1", decision: "deny" },
    ]);
    h.adapter.failPermission = true;
    await expect(
      h.service.respondPermission({ processId: rowId, requestId: "r2", decision: "approve" }),
    ).rejects.toThrow(/权限应答未送达/);
    h.adapter.failPermission = false;
  });

  it("cancel：adapter.cancel(user_cancelled) → 退出证明到达后注册表清理 + 首轮行 killed", async () => {
    await h.service.cancel({ sessionId });
    expect(h.adapter.cancelReasons).toContain("user_cancelled");
    // 证明未到：条目仍在（自然完成保留追问能力 → cancel 后等待证明清理）
    await expect(h.service.followUp({ sessionId, message: "m" })).resolves.toBeDefined();
    h.adapter.settleExit(1);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(h.service.followUp({ sessionId, message: "m" })).rejects.toThrow(/会话未在运行/);
    // 退出证明绑定首轮 proc（port 限制）：coding_agent 行终局 killed + exitCode；
    // follow_up 行由泵终态收口（fake 适配器未发事件，维持 running 语义正确）
    const rows = h.processes.findAll().filter((r) => r.sessionId === sessionId);
    expect(rows[0]?.runReason).toBe("coding_agent");
    expect(rows[0]?.status).toBe("killed");
    expect(rows[0]?.exitCode).toBe(1);
  });

  it("自然退出（非 cancel）：注册表保留（追问可达），行终局 exited + exitCode", async () => {
    const project = h.projects.findAll()[0] ?? null;
    expect(project).not.toBeNull();
    const task = h.tasks.create({ projectId: project?.id ?? "", title: "T2" });
    const workspace = h.workspaces.create({
      projectId: project?.id ?? "",
      name: "w-natural",
      branch: "aether/w-natural",
      worktreePath: "D:\\wt\\w-natural",
      storageKey: "w-natural",
    });
    const profileId = h.profiles.findAll()[0]?.id ?? "";
    const handle = await h.service.spawn({
      taskId: task.id,
      workspaceId: workspace.id,
      agentProfileId: profileId,
      prompt: "自然完成",
    });
    h.adapter.settleExit(0);
    await new Promise((resolve) => setImmediate(resolve));
    const row = h.processes
      .findAll()
      .filter((r) => r.sessionId === handle.sessionId)
      .at(-1);
    expect(row?.status).toBe("exited");
    expect(row?.exitCode).toBe(0);
    // 未 cancel：条目保留（followUp 可达——mock CLI 集成测试复验该语义）
    await expect(
      h.service.followUp({ sessionId: handle.sessionId, message: "m" }),
    ).resolves.toBeDefined();
  });
});

describe("spawn/followUp 失败路径与 listSessionEvents", () => {
  it("adapter.spawn 抛错 → process 行 failed + 会话 error 投影 + internal 错误", async () => {
    const h = createHarness();
    try {
      const project = h.projects.create({ name: "P", rootPath: "D:\\p" });
      const task = h.tasks.create({ projectId: project.id, title: "T" });
      const workspace = h.workspaces.create({
        projectId: project.id,
        name: "w-3",
        branch: "aether/w-3",
        worktreePath: "D:\\wt\\w-3",
        storageKey: "w-3",
      });
      const profileId = h.profiles.findAll()[0]?.id ?? "";
      h.adapter.failSpawn = true;
      const error = await h.service
        .spawn({
          taskId: task.id,
          workspaceId: workspace.id,
          agentProfileId: profileId,
          prompt: "x",
        })
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ServiceError);
      expect((error as ServiceError).kind).toBe("internal");
      expect((error as ServiceError).message).toContain("agent 进程启动失败");
      // 泵未驱动 → 防御终态：session 行 error + agent.status error
      const session = h.sessions.findAll().at(-1);
      expect(session?.status).toBe("error");
      const row = h.processes.findAll().at(-1);
      expect(row?.status).toBe("failed");
    } finally {
      h.dispose();
    }
  });

  it("listSessionEvents：未知会话 → invalid_params；多进程行按时间序合并", async () => {
    const h = createHarness();
    try {
      // listSessionEvents 是同步方法：同步抛错须以函数断言（rejects 不适用）
      expect(() => h.service.listSessionEvents("ghost")).toThrow(/未知会话/);
      const project = h.projects.create({ name: "P", rootPath: "D:\\p" });
      const workspace = h.workspaces.create({
        projectId: project.id,
        name: "w-4",
        branch: "aether/w-4",
        worktreePath: "D:\\wt\\w-4",
        storageKey: "w-4",
      });
      const profileId = h.profiles.findAll()[0]?.id ?? "";
      const session = h.sessions.create({ workspaceId: workspace.id, agentProfileId: profileId });
      const first = h.processes.create({
        sessionId: session.id,
        runReason: "coding_agent",
        commandJson: "{}",
        endedAt: "2026-11-15T00:00:02Z",
      });
      const second = h.processes.create({
        sessionId: session.id,
        runReason: "follow_up",
        commandJson: "{}",
      });
      h.replayByProcess.set(first.id, [
        makeEvent(session.id, { type: "message", content: "第一轮" }),
      ]);
      h.replayByProcess.set(second.id, [
        makeEvent(session.id, { type: "message", content: "第二轮追问" }),
      ]);
      const events = h.service.listSessionEvents(session.id);
      expect(events.map((event) => (event.type === "message" ? event.content : ""))).toEqual([
        "第一轮",
        "第二轮追问",
      ]);
    } finally {
      h.dispose();
    }
  });
});

// ===== P0-11 gate 补：缺省 agentProfileId、requestId 反查应答、sessions.list 联表 =====
describe("spawn 缺省 agentProfileId（gate 契约对账）", () => {
  it("缺省 → 种子的全局默认 profile；显式未知 id 仍 invalid_params", async () => {
    const h = createHarness();
    try {
      const project = h.projects.create({ name: "P", rootPath: "D:\\p-default" });
      const task = h.tasks.create({ projectId: project.id, title: "T" });
      const workspace = h.workspaces.create({
        projectId: project.id,
        name: "w-default",
        branch: "aether/w-default",
        worktreePath: "D:\\wt\\w-default",
        storageKey: "w-default",
      });
      const defaultProfile = h.profiles.findAll()[0];
      expect(defaultProfile).toBeDefined();

      const handle = await h.service.spawn({
        taskId: task.id,
        workspaceId: workspace.id,
        prompt: "缺省配置档",
      });
      expect(h.sessions.findById(handle.sessionId)?.agentProfileId).toBe(defaultProfile?.id);

      await expect(
        h.service.spawn({
          taskId: task.id,
          workspaceId: workspace.id,
          agentProfileId: "no-profile",
          prompt: "x",
        }),
      ).rejects.toThrow(/未知 agent 配置档/);
    } finally {
      h.dispose();
    }
  });

  it("默认 profile 被删且未重播种子 → internal（缺省解析不可静默降级）", async () => {
    const h = createHarness();
    try {
      const defaultProfile = h.profiles.findAll()[0];
      expect(defaultProfile).toBeDefined();
      h.profiles.delete(defaultProfile?.id ?? "");
      const project = h.projects.create({ name: "P", rootPath: "D:\\p-nodefault" });
      const task = h.tasks.create({ projectId: project.id, title: "T" });
      await expect(h.service.spawn({ taskId: task.id, prompt: "x" })).rejects.toMatchObject({
        kind: "internal",
      });
    } finally {
      h.dispose();
    }
  });
});

describe("permission.respond 缺省 processId（requestId 反查）", () => {
  it("permission_request 入列 → requestId 反查命中；应答出列；终态清列", async () => {
    const h = createHarness();
    try {
      const project = h.projects.create({ name: "P", rootPath: "D:\\p-perm" });
      const task = h.tasks.create({ projectId: project.id, title: "T" });
      const workspace = h.workspaces.create({
        projectId: project.id,
        name: "w-perm",
        branch: "aether/w-perm",
        worktreePath: "D:\\wt\\w-perm",
        storageKey: "w-perm",
      });
      const handle = await h.service.spawn({
        taskId: task.id,
        workspaceId: workspace.id,
        prompt: "权限旅程",
      });
      const sessionId = handle.sessionId;
      const ctx = h.adapter.lastCtx;
      expect(ctx).not.toBeNull();

      // 泵驱动：ready → 权限请求 waiting
      ctx?.emit(makeEvent(sessionId, { type: "session", externalSessionId: null }));
      ctx?.emit(
        makeEvent(sessionId, {
          type: "permission_request",
          requestId: "req-gate-1",
          toolName: "Bash",
          summary: "mock 危险命令",
        }),
      );
      expect(h.sessions.findById(sessionId)?.status).toBe("waiting");

      // 未知 requestId → invalid_params（无对应运行会话）
      await expect(
        h.service.respondPermission({ requestId: "req-unknown", decision: "approve" }),
      ).rejects.toThrow(/权限应答无对应运行会话/);

      // 缺省 processId：按 requestId 反查命中，adapter 收到运行时 processId
      await h.service.respondPermission({ requestId: "req-gate-1", decision: "approve" });
      expect(h.adapter.permissionCalls.at(-1)).toEqual({
        processId: h.adapter.lastProc?.processId,
        requestId: "req-gate-1",
        decision: "approve",
      });

      // 已应答出列：同 requestId 再答 → 反查落空
      await expect(
        h.service.respondPermission({ requestId: "req-gate-1", decision: "deny" }),
      ).rejects.toThrow(/权限应答无对应运行会话/);

      // 终态清列：新请求入列 → 终态事件 → 应答落空
      ctx?.emit(
        makeEvent(sessionId, {
          type: "permission_request",
          requestId: "req-gate-2",
          toolName: "Bash",
          summary: "第二轮",
        }),
      );
      ctx?.emit(makeEvent(sessionId, { type: "session", externalSessionId: "ext-perm" }));
      expect(h.sessions.findById(sessionId)?.status).toBe("stopped");
      await expect(
        h.service.respondPermission({ requestId: "req-gate-2", decision: "approve" }),
      ).rejects.toThrow(/权限应答无对应运行会话/);
    } finally {
      h.dispose();
    }
  });
});

describe("listSessionsByTask（sessions.list 服务面）", () => {
  it("未知任务 → invalid_params；workspace.taskId 联表只收本任务会话", () => {
    const h = createHarness();
    try {
      expect(() => h.service.listSessionsByTask("ghost")).toThrow(/未知任务/);
      const profileId = h.profiles.findAll()[0]?.id ?? "";
      const project = h.projects.create({ name: "P", rootPath: "D:\\p-list" });
      const taskA = h.tasks.create({ projectId: project.id, title: "A" });
      const taskB = h.tasks.create({ projectId: project.id, title: "B" });
      const workspaceA = h.workspaces.create({
        projectId: project.id,
        taskId: taskA.id,
        name: "w-a",
        branch: "aether/w-a",
        worktreePath: "D:\\wt\\w-a",
        storageKey: "w-a",
      });
      const workspaceB = h.workspaces.create({
        projectId: project.id,
        taskId: taskB.id,
        name: "w-b",
        branch: "aether/w-b",
        worktreePath: "D:\\wt\\w-b",
        storageKey: "w-b",
      });
      // workspaceB 下另挂一个无关工作区（无 taskId）——不应被计入任何任务
      h.workspaces.create({
        projectId: project.id,
        name: "w-orphan",
        branch: "aether/w-orphan",
        worktreePath: "D:\\wt\\w-orphan",
        storageKey: "w-orphan",
      });
      const sessionA1 = h.sessions.create({
        workspaceId: workspaceA.id,
        agentProfileId: profileId,
      });
      const sessionA2 = h.sessions.create({
        workspaceId: workspaceA.id,
        agentProfileId: profileId,
      });
      h.sessions.create({ workspaceId: workspaceB.id, agentProfileId: profileId });

      const listed = h.service.listSessionsByTask(taskA.id);
      expect(listed.items.map((session) => session.id)).toEqual([sessionA1.id, sessionA2.id]);
    } finally {
      h.dispose();
    }
  });
});
