import { describe, it } from "vitest";
import {
  AgentProfileSchema,
  AgentStatusSchema,
  AutonomyLevelSchema,
  ExecutionProcessLogSchema,
  ExecutionProcessSchema,
  ExecutionProcessStatusSchema,
  PermissionDecisionSchema,
  ProjectSchema,
  ProviderConfigKindSchema,
  ProviderConfigSchema,
  ProviderKindSchema,
  RunReasonSchema,
  SessionSchema,
  TaskSchema,
  TaskStatusSchema,
  WorkspaceSchema,
  WorkspaceStatusSchema,
} from "../src/index.js";
import type {
  AgentProfile,
  ExecutionProcess,
  ExecutionProcessLog,
  Project,
  ProviderConfig,
  Session,
  Task,
  Workspace,
} from "../src/index.js";
import { expectRejected, expectRoundTrip } from "./helpers.js";

// 既有 domain 家族的守卫测试：storage 包并行依赖这些导出，此处锁定其形状不被无意识破坏。

const project: Project = {
  id: "p-1",
  name: "aether",
  rootPath: "D:\\Code\\Aether",
  gitDefaultBranch: "main",
  settingsJson: "{}",
  createdAt: "2026-11-15T08:00:00Z",
  archivedAt: null,
};

const task: Task = {
  id: "t-1",
  projectId: "p-1",
  parentTaskId: null,
  title: "落地契约包",
  description: "",
  status: "todo",
  assigneeAgentProfileId: null,
  position: 0,
  createdAt: "2026-11-15T08:00:00Z",
  updatedAt: "2026-11-15T08:00:00Z",
};

const workspace: Workspace = {
  id: "w-1",
  projectId: "p-1",
  taskId: "t-1",
  name: "aether-t-1",
  branch: "aether/t-1",
  worktreePath: "D:\\Code\\.aether-worktrees\\aether-t-1",
  storageKey: "workspace:w-1",
  status: "reserved",
  createdAt: "2026-11-15T08:00:00Z",
  releasedAt: null,
};

const providerConfig: ProviderConfig = {
  id: "pc-1",
  kind: "claude-sdk",
  displayName: "Claude",
  configJson: "{}",
  createdAt: "2026-11-15T08:00:00Z",
  updatedAt: "2026-11-15T08:00:00Z",
};

const agentProfile: AgentProfile = {
  id: "ap-1",
  projectId: null,
  name: "default",
  providerConfigId: "pc-1",
  model: null,
  persona: "",
  autonomyJson: "{}",
  createdAt: "2026-11-15T08:00:00Z",
  updatedAt: "2026-11-15T08:00:00Z",
};

const session: Session = {
  id: "s-1",
  workspaceId: "w-1",
  agentProfileId: "ap-1",
  externalSessionId: null,
  status: "starting",
  lineageParentId: null,
  checkpointRef: null,
  createdAt: "2026-11-15T08:00:00Z",
  lastActiveAt: "2026-11-15T08:00:00Z",
};

const executionProcess: ExecutionProcess = {
  id: "ep-1",
  sessionId: "s-1",
  runReason: "coding_agent",
  pid: 4242,
  commandJson: '["claude"]',
  status: "running",
  exitCode: null,
  startedAt: "2026-11-15T08:00:00Z",
  endedAt: null,
};

const executionProcessLog: ExecutionProcessLog = {
  id: 1,
  processId: "ep-1",
  seq: 1,
  rawJson: '{"type":"system"}',
  normalizedJson: null,
  createdAt: "2026-11-15T08:00:00Z",
};

describe("domain 实体 round-trip", () => {
  it("ProjectSchema", () => expectRoundTrip(ProjectSchema, project));
  it("TaskSchema", () => expectRoundTrip(TaskSchema, task));
  it("WorkspaceSchema", () => expectRoundTrip(WorkspaceSchema, workspace));
  it("ProviderConfigSchema", () => expectRoundTrip(ProviderConfigSchema, providerConfig));
  it("AgentProfileSchema", () => expectRoundTrip(AgentProfileSchema, agentProfile));
  it("SessionSchema", () => expectRoundTrip(SessionSchema, session));
  it("ExecutionProcessSchema", () => expectRoundTrip(ExecutionProcessSchema, executionProcess));
  it("ExecutionProcessLogSchema", () =>
    expectRoundTrip(ExecutionProcessLogSchema, executionProcessLog));
});

describe("domain 枚举反例", () => {
  it("TaskStatus 非法值被拒绝", () => {
    expectRejected(TaskStatusSchema, "blocked");
    expectRejected(TaskStatusSchema, "TODO");
  });
  it("WorkspaceStatus 非法值被拒绝", () => expectRejected(WorkspaceStatusSchema, "active"));
  it("AgentStatus 非法值被拒绝", () => expectRejected(AgentStatusSchema, "paused"));
  it("ExecutionProcessStatus 非法值被拒绝", () =>
    expectRejected(ExecutionProcessStatusSchema, "zombie"));
  it("RunReason 非法值被拒绝", () => expectRejected(RunReasonSchema, "misc"));
  it("ProviderKind 非法值被拒绝", () => expectRejected(ProviderKindSchema, "gemini"));
  it("ProviderConfigKind 非法值被拒绝", () => expectRejected(ProviderConfigKindSchema, "acp"));
  it("AutonomyLevel 非法值被拒绝", () => expectRejected(AutonomyLevelSchema, "full_auto"));
  it("PermissionDecision 非法值被拒绝", () => expectRejected(PermissionDecisionSchema, "maybe"));
});

describe("domain 实体反例：缺必填字段", () => {
  it("Task 缺 title 被拒绝", () => {
    const { title: _omit, ...withoutTitle } = task;
    expectRejected(TaskSchema, withoutTitle);
  });
  it("Session 缺 status 被拒绝", () => {
    const { status: _omit, ...withoutStatus } = session;
    expectRejected(SessionSchema, withoutStatus);
  });
});

describe("domain 时间戳字段必须是 UTC ISO-8601（z.iso.datetime()）", () => {
  it("斜杠日期 / 自然语言等非 ISO 字符串被拒绝", () => {
    expectRejected(ProjectSchema, { ...project, createdAt: "2026/11/15" });
    expectRejected(TaskSchema, { ...task, updatedAt: "yesterday" });
    expectRejected(ExecutionProcessSchema, { ...executionProcess, startedAt: "15-11-2026 08:00" });
  });
  it("缺时间部分的纯日期被拒绝", () => {
    expectRejected(ProjectSchema, { ...project, createdAt: "2026-11-15" });
  });
});
