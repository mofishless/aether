import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
// @aether/storage 已归位为本包 devDependencies（P0-10）：测试专用集成缝，
// 运行时依赖方向不变（adapter 不依赖 storage，见 package.json 注释位）。
import {
  AgentProfileRepository,
  ExecutionProcessLogRepository,
  ExecutionProcessRepository,
  ProjectRepository,
  SessionRepository,
  TaskRepository,
  WorkspaceRepository,
  openStorage,
} from "@aether/storage";
import type { ProviderEvent } from "@aether/contracts";
import {
  ExecutionLogReplayService,
  ExecutionLogSink,
  type ResolvedProviderConfig,
} from "@aether/core";
import { createClaudeAdapter } from "../src/adapter.js";

// ===== P0-09 集成：fixture JSONL → sink 落库 → 重放归一化 → 与在线直出对账 =====
// 验收 ①：同一份原始日志可重放（raw 落库 → 重放输出 == 直接 normalizeLogs）；
// 验收 ②：vendor 格式变更只改一个转换器——permission-ask 走同一管线同一
// 转换器仅换输入，可重放性不依赖 vendor 内部格式细节。

const CFG: ResolvedProviderConfig = {
  kind: "claude-sdk",
  providerConfigId: "pc-1",
  displayName: "Claude",
  config: {},
};

interface FixtureShape {
  readonly protocol: string;
  readonly events: ReadonlyArray<{ readonly emit: unknown }>;
}

function loadFixture(name: string): FixtureShape {
  const url = new URL(
    `../../../../fixtures/aether-mock-cli/fixtures/${name}.json`,
    import.meta.url,
  );
  const parsed = JSON.parse(readFileSync(url, "utf8")) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as FixtureShape).events)
  ) {
    throw new Error(`fixture '${name}' 形状非法：缺 events 数组`);
  }
  return parsed as FixtureShape;
}

interface PipelineSetup {
  readonly db: DatabaseSync;
  readonly sessionId: string;
  readonly processId: string;
  readonly logs: ExecutionProcessLogRepository;
}

/** 内存 SQLite + 完整外键链（project→…→session→process），与 storage 测试同法。 */
function setupPipeline(): PipelineSetup {
  const db = openStorage(":memory:");
  const projects = new ProjectRepository(db);
  const tasks = new TaskRepository(db);
  const workspaces = new WorkspaceRepository(db);
  const profiles = new AgentProfileRepository(db);
  const sessions = new SessionRepository(db);
  const processes = new ExecutionProcessRepository(db);
  const logs = new ExecutionProcessLogRepository(db);

  const project = projects.create({ name: "P", rootPath: "D:\\pipeline" });
  tasks.create({ projectId: project.id, title: "T" });
  const workspace = workspaces.create({
    projectId: project.id,
    name: "wt-pipeline",
    branch: "b",
    worktreePath: "D:\\wt\\wt-pipeline",
    storageKey: "wt-pipeline",
  });
  const profileId = profiles.findAll()[0]?.id;
  if (profileId === undefined) {
    throw new Error("种子 agent profile 缺失");
  }
  const session = sessions.create({ workspaceId: workspace.id, agentProfileId: profileId });
  const process = processes.create({
    sessionId: session.id,
    runReason: "coding_agent",
    commandJson: "{}",
  });
  return { db, sessionId: session.id, processId: process.id, logs };
}

interface PipelineResult {
  readonly events: ProviderEvent[];
  readonly backfilledRowCount: number;
}

/** 全管线：JSONL 灌 sink → flushNow 落库 → 重放（注入真实 normalizeLogs）。
 *  归属修正默认用 execution_process 行的真实 sessionId（P0-10 daemon 接线后的形态）。 */
function runPipeline(
  fixtureName: string,
  explicitSessionIdOverride?: string,
): { setup: PipelineSetup; result: PipelineResult } {
  const setup = setupPipeline();
  const sessionIdOverride = explicitSessionIdOverride ?? setup.sessionId;
  const fixture = loadFixture(fixtureName);
  const lines = fixture.events.map((entry) => JSON.stringify(entry.emit));

  const sink = new ExecutionLogSink({ store: setup.logs });
  for (const line of lines) {
    sink.append(setup.processId, line);
  }
  const written = sink.flushNow();
  if (written !== lines.length) {
    throw new Error(`flushNow 落库行数不符：${written} != ${lines.length}`);
  }
  sink.dispose();

  const adapter = createClaudeAdapter(CFG);
  const replay = new ExecutionLogReplayService(setup.logs);
  const result = replay.replayProcess(setup.processId, (raw) => adapter.normalizeLogs(raw), {
    sessionIdOverride,
  });
  return { setup, result };
}

describe("执行日志管线集成（fixture → sink → SQLite → 重放）", () => {
  it("验收 ①：happy-path 重放输出 == 直接 normalizeLogs(events)，sessionId 已按归属修正", () => {
    const { setup, result } = runPipeline("happy-path");
    const adapter = createClaudeAdapter(CFG);
    const fixture = loadFixture("happy-path");

    // 在线直出对照：直接 normalizeLogs 原始事件序列
    const direct = adapter.normalizeLogs(fixture.events.map((entry) => entry.emit));
    const expected = direct.map((event) => ({ ...event, sessionId: setup.sessionId }));

    expect(result.events).toEqual(expected);
    expect(result.events.every((event) => event.sessionId === setup.sessionId)).toBe(true);
    expect(result.events.some((event) => event.sessionId === "replay")).toBe(false);
    setup.db.close();
  });

  it("回填核对：每行 normalized_json == 该行单独 normalize 后按归属修正的事件数组", () => {
    const { setup, result } = runPipeline("happy-path", "session-owned");
    const adapter = createClaudeAdapter(CFG);
    const rows = setup.logs.findByProcessId(setup.processId);

    expect(rows).toHaveLength(5); // fixture 事件数
    expect(result.backfilledRowCount).toBe(5);
    for (const row of rows) {
      const perRow = adapter.normalizeLogs([row.rawJson]);
      const expectedJson = JSON.stringify(
        perRow.map((event) => ({ ...event, sessionId: "session-owned" })),
      );
      expect(row.normalizedJson).toBe(expectedJson); // NULL=未归一化 → 已全部回填
    }
    setup.db.close();
  });

  it("验收 ②：permission-ask 走同一管线同一转换器仅换输入——重放同样成立", () => {
    const { setup, result } = runPipeline("permission-ask");
    const adapter = createClaudeAdapter(CFG);
    const fixture = loadFixture("permission-ask");

    const direct = adapter.normalizeLogs(fixture.events.map((entry) => entry.emit));
    const expected = direct.map((event) => ({ ...event, sessionId: setup.sessionId }));

    expect(result.events).toEqual(expected);
    expect(result.events.length).toBeGreaterThan(0);
    // control_request 帧被容忍跳过（计数不进入事件序列），不影响可重放性
    expect(result.events.some((event) => event.type === "permission_request")).toBe(false);
    setup.db.close();
  });

  it("落库口径：raw_json 原样（JSONL 字节不变）、seq 1..N 连续、normalized 初值为 NULL→已回填", () => {
    const fixture = loadFixture("happy-path");
    const lines = fixture.events.map((entry) => JSON.stringify(entry.emit));
    const setup = setupPipeline();

    const sink = new ExecutionLogSink({ store: setup.logs });
    for (const line of lines) {
      sink.append(setup.processId, line);
    }
    expect(setup.logs.findByProcessId(setup.processId)).toEqual([]); // flush 前不可见
    sink.flushNow();

    const rows = setup.logs.findByProcessId(setup.processId);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.map((row) => row.rawJson)).toEqual(lines); // 原样落库
    expect(rows.every((row) => row.normalizedJson === null)).toBe(true); // 原始先存
    sink.dispose();
    setup.db.close();
  });
});

// ===== 验收 ③ 后半句：真实 storage 下"查询不被阻塞"（spec-review 补测）=====
// node:sqlite 是同步 API：后台 flush 的单事务 INSERT 执行期间持有事件循环，
// 查询要么在 flush 前要么在 flush 后，单次查询时延 = 自身耗时 + 至多让路一个
// flush 批次。此轮用真实内存库证明该上界有界（core 压测的假 store 不含此路径）。
describe("写路径压测：真实 storage 查询时延有界", () => {
  it("灌入期间穿插 findByProcessId：单次查询 < 200ms，最终行数与 seq 完整", async () => {
    const setup = setupPipeline();
    // 同步灌入循环让出事件循环后，默认 10k 单进程背压在 12k 行下会拒行——
    // 与 core 压测同理放宽容量，背压语义由 sink 单测锁定。
    const sink = new ExecutionLogSink({ store: setup.logs, maxQueuedPerProcess: 50_000 });

    const lineCount = 12_000;
    const pad = "x".repeat(1000);
    let maxQueryMs = 0;
    let queryCount = 0;

    for (let seq = 1; seq <= lineCount; seq += 1) {
      sink.append(setup.processId, `{"seq":${seq},"pad":"${pad}"}`);
      if (seq % 2_000 === 0) {
        // 真让出一拍：200ms 定时 / 500 行定量的后台 flush 得以介入，
        // 随后立即查询——测到的正是"排在一个 flush 批次之后"的最坏情形
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        const queryStart = performance.now();
        setup.logs.findByProcessId(setup.processId);
        maxQueryMs = Math.max(maxQueryMs, performance.now() - queryStart);
        queryCount += 1;
      }
    }

    expect(queryCount).toBe(6);
    // 500 行 × ~1KiB 单事务内存库实测毫秒级；200ms 为 CI 2 核慢机留足余量
    expect(maxQueryMs).toBeLessThan(200);

    sink.flushNow();
    const rows = setup.logs.findByProcessId(setup.processId);
    expect(rows).toHaveLength(lineCount);
    expect(rows[rows.length - 1]?.seq).toBe(lineCount); // seq 单调到尾（完整性抽检）
    sink.dispose();
    setup.db.close();
  }, 30_000);
});
