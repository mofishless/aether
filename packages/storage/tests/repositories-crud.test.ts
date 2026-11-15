import { describe, expect, it } from "vitest";
import {
  AgentProfileSchema,
  ExecutionProcessLogSchema,
  ExecutionProcessSchema,
  ProjectSchema,
  ProviderConfigSchema,
  SessionSchema,
  TaskSchema,
  WorkspaceSchema,
} from "@aether/contracts";
import {
  AgentProfileRepository,
  ExecutionProcessLogRepository,
  ExecutionProcessRepository,
  ProjectRepository,
  ProviderConfigRepository,
  SessionRepository,
  StorageError,
  TaskRepository,
  WorkspaceRepository,
  openStorage,
} from "../src/index.js";
import { expectIsoTimestamp, expectNotNull, firstOf } from "./helpers.js";

// 每个用例独立内存库（openStorage = 迁移 + 种子），互不串扰。

describe("repository CRUD（逐实体）", () => {
  it("project：create→findById→update（PATCH 语义）→findAll→delete", () => {
    const db = openStorage(":memory:");
    const projects = new ProjectRepository(db);
    const input = { name: "Aether", rootPath: "D:\\repo\\aether" };
    const before = { ...input };

    const created = projects.create(input);
    expect(ProjectSchema.safeParse(created).success).toBe(true);
    expect(input).toEqual(before); // 输入对象未被修改（不可变红线）
    expectIsoTimestamp(created.createdAt);
    expect(created.gitDefaultBranch).toBe("main"); // DDL 默认值
    expect(created.settingsJson).toBe("{}");
    expect(created.archivedAt).toBeNull();
    expect(projects.findById(created.id)).toEqual(created);

    const patch = { name: "Aether 2" };
    const updated = expectNotNull(projects.update(created.id, patch));
    expect(updated.name).toBe("Aether 2");
    expect(updated.rootPath).toBe(created.rootPath); // 未给字段不变
    expect(updated.createdAt).toBe(created.createdAt);
    expect(patch).toEqual({ name: "Aether 2" }); // patch 未被修改
    expect(created.name).toBe("Aether"); // 原实体未被修改

    expect(projects.findAll().some((p) => p.id === created.id)).toBe(true);

    expect(projects.delete(created.id)).toBe(true);
    expect(projects.findById(created.id)).toBeNull();
    expect(projects.delete(created.id)).toBe(false);
  });

  it("project：update 不存在的 id 返回 null", () => {
    const db = openStorage(":memory:");
    const projects = new ProjectRepository(db);
    expect(projects.update("no-such-id", { name: "x" })).toBeNull();
    expect(projects.findById("no-such-id")).toBeNull();
  });

  it("task：CRUD + 默认值 + 契约校验", () => {
    const db = openStorage(":memory:");
    const projects = new ProjectRepository(db);
    const tasks = new TaskRepository(db);
    const project = projects.create({ name: "P", rootPath: "D:\\p" });

    const created = tasks.create({ projectId: project.id, title: "实现存储层" });
    expect(TaskSchema.safeParse(created).success).toBe(true);
    expect(created.description).toBe("");
    expect(created.status).toBe("todo");
    expect(created.parentTaskId).toBeNull();
    expect(created.assigneeAgentProfileId).toBeNull();
    expect(created.position).toBe(0);
    expectIsoTimestamp(created.createdAt);
    expect(created.updatedAt).toBe(created.createdAt);

    expect(tasks.findById(created.id)).toEqual(created);
    const updated = expectNotNull(
      tasks.update(created.id, { status: "in_progress", position: 3.5 }),
    );
    expect(updated.status).toBe("in_progress");
    expect(updated.position).toBe(3.5);
    expect(updated.title).toBe("实现存储层"); // 未给字段不变
    expect(tasks.findAll().some((t) => t.id === created.id)).toBe(true);
    expect(tasks.delete(created.id)).toBe(true);
    expect(tasks.findById(created.id)).toBeNull();
  });

  it("workspace：CRUD + findByStatuses（崩溃恢复扫描口径）", () => {
    const db = openStorage(":memory:");
    const projects = new ProjectRepository(db);
    const workspaces = new WorkspaceRepository(db);
    const project = projects.create({ name: "P", rootPath: "D:\\p" });

    const created = workspaces.create({
      projectId: project.id,
      name: "wt-1",
      branch: "aether/task-1",
      worktreePath: "D:\\wt\\wt-1",
      storageKey: "wt-1",
    });
    expect(WorkspaceSchema.safeParse(created).success).toBe(true);
    expect(created.status).toBe("reserved");
    expect(created.taskId).toBeNull();
    expect(created.releasedAt).toBeNull();
    expectIsoTimestamp(created.createdAt);

    const other = workspaces.create({
      projectId: project.id,
      name: "wt-2",
      branch: "aether/task-2",
      worktreePath: "D:\\wt\\wt-2",
      storageKey: "wt-2",
    });
    expectNotNull(workspaces.update(other.id, { status: "creating" }));

    const scanned = workspaces.findByStatuses(["creating", "deleting", "orphaned"]);
    expect(scanned.map((w) => w.id)).toEqual([other.id]);
    expect(workspaces.findByStatuses([])).toEqual([]);

    expect(workspaces.findAll()).toHaveLength(2);
    expect(workspaces.delete(created.id)).toBe(true);
    expect(workspaces.findById(created.id)).toBeNull();
  });

  it("provider_config：CRUD + configJson 透传", () => {
    const db = openStorage(":memory:");
    const configs = new ProviderConfigRepository(db);
    // 种子已插入 1 条默认配置
    expect(configs.findAll()).toHaveLength(1);

    const created = configs.create({
      kind: "custom",
      displayName: "MyOpenAI",
      configJson: '{"baseUrl":"https://example.invalid/v1"}',
    });
    expect(ProviderConfigSchema.safeParse(created).success).toBe(true);
    expect(created.configJson).toBe('{"baseUrl":"https://example.invalid/v1"}');
    expectIsoTimestamp(created.createdAt);
    expect(created.updatedAt).toBe(created.createdAt);

    const updated = expectNotNull(configs.update(created.id, { displayName: "MyOpenAI 2" }));
    expect(updated.displayName).toBe("MyOpenAI 2");
    expect(updated.configJson).toBe(created.configJson); // 未给字段不变
    expect(configs.findAll()).toHaveLength(2);
    expect(configs.delete(created.id)).toBe(true);
    expect(configs.findAll()).toHaveLength(1);
  });

  it("agent_profile：CRUD + 全局（projectId=null）与默认值", () => {
    const db = openStorage(":memory:");
    const configs = new ProviderConfigRepository(db);
    const profiles = new AgentProfileRepository(db);
    const config = configs.create({ kind: "claude-sdk", displayName: "C2" });

    const created = profiles.create({
      projectId: null,
      name: "Worker",
      providerConfigId: config.id,
    });
    expect(AgentProfileSchema.safeParse(created).success).toBe(true);
    expect(created.model).toBeNull();
    expect(created.persona).toBe("");
    expect(created.autonomyJson).toBe("{}");
    expectIsoTimestamp(created.createdAt);

    const updated = expectNotNull(profiles.update(created.id, { model: "claude-sonnet-4-6" }));
    expect(updated.model).toBe("claude-sonnet-4-6");
    expect(updated.name).toBe("Worker");
    expect(profiles.findAll().some((p) => p.id === created.id)).toBe(true);
    expect(profiles.delete(created.id)).toBe(true);
    expect(profiles.findById(created.id)).toBeNull();
  });

  it("session：CRUD + touchStatus（status 与 last_active_at 同步）", () => {
    const db = openStorage(":memory:");
    const projects = new ProjectRepository(db);
    const workspaces = new WorkspaceRepository(db);
    const profiles = new AgentProfileRepository(db);
    const sessions = new SessionRepository(db);
    const project = projects.create({ name: "P", rootPath: "D:\\p" });
    const workspace = workspaces.create({
      projectId: project.id,
      name: "wt-1",
      branch: "b1",
      worktreePath: "D:\\wt\\wt-1",
      storageKey: "wt-1",
    });
    const profile = firstOf(profiles.findAll()); // 种子默认全局 profile

    const created = sessions.create({ workspaceId: workspace.id, agentProfileId: profile.id });
    expect(SessionSchema.safeParse(created).success).toBe(true);
    expect(created.status).toBe("starting");
    expect(created.externalSessionId).toBeNull();
    expect(created.lineageParentId).toBeNull();
    expect(created.checkpointRef).toBeNull();
    expect(created.lastActiveAt).toBe(created.createdAt);

    const touched = expectNotNull(sessions.touchStatus(created.id, "running"));
    expect(touched.status).toBe("running");
    expect(Date.parse(touched.lastActiveAt)).toBeGreaterThanOrEqual(
      Date.parse(created.lastActiveAt),
    );
    expect(touched.workspaceId).toBe(workspace.id); // 其余字段不变
    expect(sessions.touchStatus("no-such-id", "ready")).toBeNull();

    expect(sessions.delete(created.id)).toBe(true);
    expect(sessions.findById(created.id)).toBeNull();
  });

  it("execution_process：CRUD + 退出信息回填", () => {
    const db = openStorage(":memory:");
    const chain = createSessionChain(db);
    const processes = new ExecutionProcessRepository(db);

    const created = processes.create({
      sessionId: chain.sessionId,
      runReason: "coding_agent",
      commandJson: '{"argv":["claude","-p"],"env":["ANTHROPIC_API_KEY"]}',
    });
    expect(ExecutionProcessSchema.safeParse(created).success).toBe(true);
    expect(created.pid).toBeNull();
    expect(created.status).toBe("running");
    expect(created.exitCode).toBeNull();
    expect(created.endedAt).toBeNull();
    expectIsoTimestamp(created.startedAt);

    const updated = expectNotNull(
      processes.update(created.id, { status: "exited", exitCode: 0, pid: 4242 }),
    );
    expect(updated.status).toBe("exited");
    expect(updated.exitCode).toBe(0);
    expect(updated.pid).toBe(4242);
    expect(updated.runReason).toBe("coding_agent");
    expect(processes.findAll().some((p) => p.id === created.id)).toBe(true);
    expect(processes.delete(created.id)).toBe(true);
    expect(processes.findById(created.id)).toBeNull();
  });

  it("execution_process_log：create（rowid 主键）→findById→update→delete", () => {
    const db = openStorage(":memory:");
    const chain = createSessionChain(db);
    const processes = new ExecutionProcessRepository(db);
    const logs = new ExecutionProcessLogRepository(db);
    const process = processes.create({
      sessionId: chain.sessionId,
      runReason: "setup",
      commandJson: "{}",
    });

    const created = logs.create({ processId: process.id, seq: 1, rawJson: '{"type":"system"}' });
    expect(ExecutionProcessLogSchema.safeParse(created).success).toBe(true);
    expect(typeof created.id).toBe("number");
    expect(created.normalizedJson).toBeNull();
    expectIsoTimestamp(created.createdAt);

    const updated = expectNotNull(logs.update(created.id, { normalizedJson: '{"type":"init"}' }));
    expect(updated.normalizedJson).toBe('{"type":"init"}');
    expect(updated.rawJson).toBe('{"type":"system"}');
    expect(logs.findAll()).toHaveLength(1);
    expect(logs.delete(created.id)).toBe(true);
    expect(logs.findAll()).toHaveLength(0);
  });
});

// 约束拒绝负例（spec-review finding 7）：外键（REFERENCES）与 CHECK（枚举）在库层拒绝，
// repository 须把底层 SQLITE_CONSTRAINT_* 包装为 StorageError（toStorageError 路径）抛出。

describe("约束拒绝负例（外键 / CHECK）", () => {
  it("task：create 传不存在的 projectId → 外键拒绝，抛 StorageError", () => {
    const db = openStorage(":memory:"); // openDatabase 已 PRAGMA foreign_keys=ON
    const tasks = new TaskRepository(db);
    expect(() => tasks.create({ projectId: "ghost-project-id", title: "幽灵项目" })).toThrow(
      StorageError,
    );
  });

  it("task：create 传不存在的 parentTaskId（自引用外键）→ 外键拒绝，抛 StorageError", () => {
    const db = openStorage(":memory:");
    const projects = new ProjectRepository(db);
    const tasks = new TaskRepository(db);
    const project = projects.create({ name: "P", rootPath: "D:\\fk" });
    expect(() =>
      tasks.create({ projectId: project.id, parentTaskId: "ghost-parent-id", title: "幽灵父任务" }),
    ).toThrow(StorageError);
  });

  it("workspace：update 传非法枚举 status → CHECK 拒绝，包装为 StorageError（上下文完整）", () => {
    const db = openStorage(":memory:");
    const projects = new ProjectRepository(db);
    const workspaces = new WorkspaceRepository(db);
    const project = projects.create({ name: "P", rootPath: "D:\\check" });
    const created = workspaces.create({
      projectId: project.id,
      name: "wt-neg",
      branch: "b",
      worktreePath: "D:\\wt\\wt-neg",
      storageKey: "wt-neg",
    });

    let caught: unknown;
    try {
      // "bogus" 不在 WorkspaceStatus 枚举内；as never 表明故意越界（绕过编译期检查）
      workspaces.update(created.id, { status: "bogus" as never });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StorageError);
    const storageError = caught as StorageError;
    expect(storageError.operation).toBe("update");
    expect(storageError.table).toBe("workspace");
    expect(storageError.entityId).toBe(created.id);
    expect(storageError.detail).toBeDefined(); // 原始 SQLite CHECK 约束错误保留在 detail
    expect(workspaces.findById(created.id)?.status).toBe("reserved"); // 原行未被破坏
  });
});

/** 构造 session 级依赖链（project → workspace → 种子 profile → session）。 */
function createSessionChain(db: ReturnType<typeof openStorage>): { sessionId: string } {
  const projects = new ProjectRepository(db);
  const workspaces = new WorkspaceRepository(db);
  const profiles = new AgentProfileRepository(db);
  const sessions = new SessionRepository(db);
  const project = projects.create({ name: "P", rootPath: "D:\\chain" });
  const workspace = workspaces.create({
    projectId: project.id,
    name: "wt-chain",
    branch: "b",
    worktreePath: "D:\\wt\\wt-chain",
    storageKey: "wt-chain",
  });
  const profile = firstOf(profiles.findAll());
  const session = sessions.create({ workspaceId: workspace.id, agentProfileId: profile.id });
  return { sessionId: session.id };
}
