import { describe, expect, it } from "vitest";
import {
  AgentProfileRepository,
  ExecutionProcessLogRepository,
  ExecutionProcessRepository,
  ProjectRepository,
  SessionRepository,
  StorageError,
  TaskRepository,
  WorkspaceRepository,
  openStorage,
} from "../src/index.js";
import { ExecutionProcessLogSchema } from "@aether/contracts";
import type { DatabaseSync } from "node:sqlite";
import { countRows, expectIsoTimestamp, firstOf } from "./helpers.js";

/** 构造一条 session（含全部上游依赖）供日志挂载。 */
function setupLogRepo(): {
  db: DatabaseSync;
  processId: string;
  logs: ExecutionProcessLogRepository;
} {
  const db = openStorage(":memory:");
  const projects = new ProjectRepository(db);
  const tasks = new TaskRepository(db);
  const workspaces = new WorkspaceRepository(db);
  const profiles = new AgentProfileRepository(db);
  const sessions = new SessionRepository(db);
  const processes = new ExecutionProcessRepository(db);
  const logs = new ExecutionProcessLogRepository(db);

  const project = projects.create({ name: "P", rootPath: "D:\\logs" });
  tasks.create({ projectId: project.id, title: "T" });
  const workspace = workspaces.create({
    projectId: project.id,
    name: "wt-logs",
    branch: "b",
    worktreePath: "D:\\wt\\wt-logs",
    storageKey: "wt-logs",
  });
  const session = sessions.create({
    workspaceId: workspace.id,
    agentProfileId: firstOf(profiles.findAll()).id,
  });
  const process = processes.create({
    sessionId: session.id,
    runReason: "coding_agent",
    commandJson: "{}",
  });
  return { db, processId: process.id, logs };
}

describe("ExecutionProcessLogRepository.appendBatch（§4.4 批量写路径）", () => {
  it("批量写入成功：id 递增、normalizedJson 默认 null、createdAt 可解析、契约校验通过", () => {
    const setup = setupLogRepo();
    const written = setup.logs.appendBatch([
      { processId: setup.processId, seq: 1, rawJson: '{"i":1}' },
      { processId: setup.processId, seq: 2, rawJson: '{"i":2}' },
      { processId: setup.processId, seq: 3, rawJson: '{"i":3}', normalizedJson: '{"n":3}' },
    ]);
    expect(written).toBe(3);

    const all = setup.logs.findAll();
    expect(all).toHaveLength(3);
    expect(all.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(all[0]?.id).toBeLessThan(all[2]?.id ?? Number.NaN); // rowid 单调
    expect(all[0]?.normalizedJson).toBeNull();
    expect(all[2]?.normalizedJson).toBe('{"n":3}');
    expectIsoTimestamp(firstOf(all).createdAt);
    for (const row of all) {
      expect(ExecutionProcessLogSchema.safeParse(row).success).toBe(true);
    }
  });

  it("混入外键非法行（processId 不存在）→ 整批回滚（表内行数为 0）并抛 StorageError", () => {
    const setup = setupLogRepo();
    const ghostProcessId = "00000000-0000-0000-0000-000000000000";
    expect(() =>
      setup.logs.appendBatch([
        { processId: setup.processId, seq: 1, rawJson: "ok-1" },
        { processId: ghostProcessId, seq: 2, rawJson: "bad-fk" },
        { processId: setup.processId, seq: 3, rawJson: "ok-2" },
      ]),
    ).toThrow(StorageError);
    expect(countRows(setup.db, "execution_process_log")).toBe(0);

    // 回滚后连接仍可用：合法批次可继续写入
    setup.logs.appendBatch([{ processId: setup.processId, seq: 1, rawJson: "retry" }]);
    expect(countRows(setup.db, "execution_process_log")).toBe(1);
  });

  it("空数组零副作用", () => {
    const setup = setupLogRepo();
    expect(setup.logs.appendBatch([])).toBe(0);
    expect(countRows(setup.db, "execution_process_log")).toBe(0);
  });
});
