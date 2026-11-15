import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
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
import { expectNotNull, firstOf } from "./helpers.js";

/** 每用例独立内存库，构建完整链：project → task / workspace → session(全局 profile) → process → 2 行日志。 */
function buildChain(): DatabaseSync {
  const db = openStorage(":memory:");
  const projects = new ProjectRepository(db);
  const tasks = new TaskRepository(db);
  const workspaces = new WorkspaceRepository(db);
  const profiles = new AgentProfileRepository(db);
  const sessions = new SessionRepository(db);
  const processes = new ExecutionProcessRepository(db);
  const logs = new ExecutionProcessLogRepository(db);

  const project = projects.create({ name: "P", rootPath: "D:\\aether-chain" });
  tasks.create({ projectId: project.id, title: "T" });
  const workspace = workspaces.create({
    projectId: project.id,
    name: "wt-rel",
    branch: "b",
    worktreePath: "D:\\wt\\wt-rel",
    storageKey: "wt-rel",
  });
  const profile = firstOf(profiles.findAll()); // 全局种子 profile，不随 project 级联
  const session = sessions.create({ workspaceId: workspace.id, agentProfileId: profile.id });
  const process = processes.create({
    sessionId: session.id,
    runReason: "coding_agent",
    commandJson: "{}",
  });
  logs.appendBatch([
    { processId: process.id, seq: 1, rawJson: '{"i":1}' },
    { processId: process.id, seq: 2, rawJson: '{"i":2}' },
  ]);
  return db;
}

describe("级联与约束（DDL 照 SYSTEM_DESIGN §4.2）", () => {
  it("删 project 级联删 task/workspace → session → process → logs；全局 profile 保留", () => {
    const db = buildChain();
    const projects = new ProjectRepository(db);
    const tasks = new TaskRepository(db);
    const workspaces = new WorkspaceRepository(db);
    const sessions = new SessionRepository(db);
    const processes = new ExecutionProcessRepository(db);
    const logs = new ExecutionProcessLogRepository(db);
    const profiles = new AgentProfileRepository(db);
    const profile = firstOf(profiles.findAll());

    const removed = projects.delete(firstOf(projects.findAll()).id);
    expect(removed).toBe(true);
    expect(tasks.findAll()).toHaveLength(0);
    expect(workspaces.findAll()).toHaveLength(0);
    expect(sessions.findAll()).toHaveLength(0);
    expect(processes.findAll()).toHaveLength(0);
    expect(logs.findAll()).toHaveLength(0);
    expect(profiles.findById(profile.id)).not.toBeNull(); // 全局 profile 不在级联链上
  });

  it("删 workspace 级联删 session → process → logs；project/task 保留", () => {
    const db = buildChain();
    const projects = new ProjectRepository(db);
    const tasks = new TaskRepository(db);
    const workspaces = new WorkspaceRepository(db);
    const sessions = new SessionRepository(db);
    const processes = new ExecutionProcessRepository(db);
    const logs = new ExecutionProcessLogRepository(db);

    const removed = workspaces.delete(firstOf(workspaces.findAll()).id);
    expect(removed).toBe(true);
    expect(sessions.findAll()).toHaveLength(0);
    expect(processes.findAll()).toHaveLength(0);
    expect(logs.findAll()).toHaveLength(0);
    expect(projects.findAll()).toHaveLength(1);
    expect(tasks.findAll()).toHaveLength(1);
  });

  it("删 session 级联删 execution_process 及其 logs；workspace 保留", () => {
    const db = buildChain();
    const workspaces = new WorkspaceRepository(db);
    const sessions = new SessionRepository(db);
    const processes = new ExecutionProcessRepository(db);
    const logs = new ExecutionProcessLogRepository(db);

    const removed = sessions.delete(firstOf(sessions.findAll()).id);
    expect(removed).toBe(true);
    expect(processes.findAll()).toHaveLength(0);
    expect(logs.findAll()).toHaveLength(0);
    expect(workspaces.findAll()).toHaveLength(1);
  });

  it("agent_profile 被 session 引用时：provider_config 删除被 RESTRICT 拒绝，数据完好", () => {
    const db = buildChain();
    const configs = new ProviderConfigRepository(db);
    const profiles = new AgentProfileRepository(db);
    const sessions = new SessionRepository(db);
    const profile = firstOf(profiles.findAll());
    const config = expectNotNull(configs.findById(profile.providerConfigId));

    expect(() => configs.delete(config.id)).toThrow(StorageError);
    expect(() => profiles.delete(profile.id)).toThrow(StorageError); // session 引用 profile，同样 RESTRICT
    expect(configs.findById(config.id)).not.toBeNull();
    expect(profiles.findById(profile.id)).not.toBeNull();
    expect(sessions.findAll()).toHaveLength(1);
  });
});
