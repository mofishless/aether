import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  AgentProfileRepository,
  ExecutionProcessLogRepository,
  ExecutionProcessRepository,
  ProjectRepository,
  SessionRepository,
  TaskRepository,
  WorkspaceRepository,
  openStorage,
} from "../src/index.js";
import { countRows, firstOf } from "./helpers.js";

// 按 processId 读序列（P0-09 重放路径）+ updateNormalized 回填：
// execution_process_log 的 normalized_json 旁路回填依赖行级 UPDATE，
// 重放服务按 seq 升序读原始行序列后逐行回填。

interface SequenceSetup {
  readonly db: DatabaseSync;
  readonly processIdA: string;
  readonly processIdB: string;
  readonly logs: ExecutionProcessLogRepository;
}

function setupTwoProcesses(): SequenceSetup {
  const db = openStorage(":memory:");
  const projects = new ProjectRepository(db);
  const tasks = new TaskRepository(db);
  const workspaces = new WorkspaceRepository(db);
  const profiles = new AgentProfileRepository(db);
  const sessions = new SessionRepository(db);
  const processes = new ExecutionProcessRepository(db);
  const logs = new ExecutionProcessLogRepository(db);

  const project = projects.create({ name: "P", rootPath: "D:\\seq" });
  tasks.create({ projectId: project.id, title: "T" });
  const workspace = workspaces.create({
    projectId: project.id,
    name: "wt-seq",
    branch: "b",
    worktreePath: "D:\\wt\\wt-seq",
    storageKey: "wt-seq",
  });
  const session = sessions.create({
    workspaceId: workspace.id,
    agentProfileId: firstOf(profiles.findAll()).id,
  });
  const processA = processes.create({
    sessionId: session.id,
    runReason: "coding_agent",
    commandJson: "{}",
  });
  const processB = processes.create({
    sessionId: session.id,
    runReason: "coding_agent",
    commandJson: "{}",
  });
  return { db, processIdA: processA.id, processIdB: processB.id, logs };
}

describe("ExecutionProcessLogRepository.findByProcessId（重放读序列）", () => {
  it("只返回该进程的行，按 seq 升序（两进程交错写入）", () => {
    const setup = setupTwoProcesses();
    setup.logs.appendBatch([
      { processId: setup.processIdA, seq: 1, rawJson: '{"a":1}' },
      { processId: setup.processIdB, seq: 1, rawJson: '{"b":1}' },
      { processId: setup.processIdA, seq: 2, rawJson: '{"a":2}' },
      { processId: setup.processIdB, seq: 2, rawJson: '{"b":2}' },
      { processId: setup.processIdA, seq: 3, rawJson: '{"a":3}' },
    ]);

    const rowsA = setup.logs.findByProcessId(setup.processIdA);
    expect(rowsA.map((row) => row.processId)).toEqual([
      setup.processIdA,
      setup.processIdA,
      setup.processIdA,
    ]);
    expect(rowsA.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(rowsA.map((row) => row.rawJson)).toEqual(['{"a":1}', '{"a":2}', '{"a":3}']);

    const rowsB = setup.logs.findByProcessId(setup.processIdB);
    expect(rowsB.map((row) => row.seq)).toEqual([1, 2]);
  });

  it("不存在的进程返回空数组（不抛）", () => {
    const setup = setupTwoProcesses();
    expect(setup.logs.findByProcessId("00000000-0000-0000-0000-000000000000")).toEqual([]);
  });
});

describe("ExecutionProcessLogRepository.updateNormalized（旁路回填）", () => {
  it("回填指定行的 normalized_json，不影响其他行", () => {
    const setup = setupTwoProcesses();
    setup.logs.appendBatch([
      { processId: setup.processIdA, seq: 1, rawJson: '{"a":1}' },
      { processId: setup.processIdA, seq: 2, rawJson: '{"a":2}' },
    ]);
    const rows = setup.logs.findByProcessId(setup.processIdA);
    const first = firstOf(rows);
    const second = rows[1];

    setup.logs.updateNormalized(first.id, '[{"type":"message"}]');

    const after = setup.logs.findByProcessId(setup.processIdA);
    expect(after[0]?.normalizedJson).toBe('[{"type":"message"}]');
    expect(after[1]?.normalizedJson).toBeNull();
    // 回填不改 raw/seq（append-only 口径）
    expect(after[0]?.rawJson).toBe('{"a":1}');
    expect(countRows(setup.db, "execution_process_log")).toBe(2);
    expect(second).toBeDefined();
  });

  it("不存在的 id：静默无副作用（重放幂等，不抛）", () => {
    const setup = setupTwoProcesses();
    expect(() => setup.logs.updateNormalized(999999, "[]")).not.toThrow();
    expect(countRows(setup.db, "execution_process_log")).toBe(0);
  });
});
