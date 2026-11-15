// 组装根测试（P0-10）：装配烟测 + 日志管线接线（P0-09 收口）+ sessionId 归属 + 优雅关闭。
// 全部依赖真实实现（内存库 / 真 TerminalPool / 真适配器注册表），只关 warmup。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "@aether/contracts";
import {
  ProviderEventSchema,
  TerminalExitFrameSchema,
  TerminalOutputFrameSchema,
  terminalExitTopic,
  terminalOutputTopic,
} from "@aether/contracts";
import { createAdapter } from "@aether/core";
import {
  AgentProfileRepository,
  ExecutionProcessLogRepository,
  ExecutionProcessRepository,
  ProjectRepository,
  SessionRepository,
  TaskRepository,
  WorkspaceRepository,
} from "@aether/storage";
import { createDaemonAssembly, type DaemonAssembly } from "../src/assembly/assembly.js";

/** fixture 首条 SDK 原始消息行（与 adapters/claude 管线测试同源，跨包只读共享） */
function firstFixtureLine(): string {
  const url = new URL(
    "../../../fixtures/aether-mock-cli/fixtures/happy-path.json",
    import.meta.url,
  );
  const parsed = JSON.parse(readFileSync(url, "utf8")) as {
    events: ReadonlyArray<{ emit: unknown }>;
  };
  const first = parsed.events[0];
  if (first === undefined) {
    throw new Error("fixture happy-path.json 缺 events");
  }
  return JSON.stringify(first.emit);
}

/** 建立 execution_process 外键链（project→task/workspace/profile→session→process） */
function seedProcess(assembly: DaemonAssembly): { sessionId: string; processId: string } {
  const projects = new ProjectRepository(assembly.db);
  const tasks = new TaskRepository(assembly.db);
  const workspaces = new WorkspaceRepository(assembly.db);
  const profiles = new AgentProfileRepository(assembly.db);
  const sessions = new SessionRepository(assembly.db);
  const processes = new ExecutionProcessRepository(assembly.db);

  const project = projects.create({ name: "装配测试", rootPath: "D:\\assembly" });
  tasks.create({ projectId: project.id, title: "T" });
  const workspace = workspaces.create({
    projectId: project.id,
    name: "wt-assembly",
    branch: "b",
    worktreePath: "D:\\wt\\wt-assembly",
    storageKey: "wt-assembly",
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
  return { sessionId: session.id, processId: process.id };
}

function makeAssembly(): DaemonAssembly {
  // 不调 warmupConptyInBackground：预热是入口层职责（含同步段），组装单测无需真 PTY
  return createDaemonAssembly({ dbPath: ":memory:" });
}

describe("组装根：适配器注册（§6.4 daemon 启动注册内置 kind）", () => {
  it("装配后 createAdapter('claude-sdk') 可用", () => {
    const assembly = makeAssembly();
    const adapter = createAdapter({
      kind: "claude-sdk",
      providerConfigId: "builtin-claude-sdk",
      displayName: "Claude",
      config: {},
    });
    expect(adapter.kind).toBe("claude-sdk");
    void assembly.close();
  });
});

describe("组装根：终端池 → 事件总线接线", () => {
  it("pool 输出/退出帧以 EventEnvelope（payload zod 校验后）发布到对应 topic", async () => {
    const assembly = makeAssembly();
    const envelopes: { topic: string; payload: unknown }[] = [];
    assembly.eventBus.addListener((frame) => {
      const notification = JSON.parse(frame) as { method: string; params: unknown };
      if (notification.method === "event") {
        const envelope = notification.params as { topic: string; payload: unknown };
        envelopes.push({ topic: envelope.topic, payload: envelope.payload });
      }
    });

    const handle = assembly.terminalPool.create({
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      // 跨平台确定性：node -e 打印探针后退出 0（两平台 exitCode 语义一致）
      file: process.execPath,
      args: ["-e", "console.log('aether-assembly-probe')"],
    });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (envelopes.some((entry) => entry.topic === terminalExitTopic(handle.terminalId))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // PTY 输出按块到达（探针串可能跨帧拆分）：拼全部输出帧再断言，每帧单独过 schema
    const outputFrames = envelopes
      .filter((entry) => entry.topic === terminalOutputTopic(handle.terminalId))
      .map((entry) => TerminalOutputFrameSchema.parse(entry.payload));
    expect(outputFrames.length).toBeGreaterThan(0);
    const joinedOutput = outputFrames
      .map((frame) => Buffer.from(frame.data, "base64").toString("utf8"))
      .join("");
    expect(joinedOutput).toContain("aether-assembly-probe");

    const exit = envelopes.find((entry) => entry.topic === terminalExitTopic(handle.terminalId));
    expect(exit).toBeDefined();
    const exitFrame = TerminalExitFrameSchema.parse(exit?.payload);
    expect(exitFrame.terminalId).toBe(handle.terminalId);
    expect(exitFrame.exitCode).toBe(0); // node -e 正常退出，双平台一致

    await assembly.close();
  }, 20_000);
});

describe("组装根：执行日志管线接线（P0-09 收口）", () => {
  it("createAgentEventContext.emit → ProviderEvent JSON 行入队 → flushNow 落库原样可查", () => {
    const assembly = makeAssembly();
    const seeded = seedProcess(assembly);
    const event: ProviderEvent = ProviderEventSchema.parse({
      eventId: `${seeded.processId}-1`,
      sessionId: seeded.sessionId,
      occurredAt: new Date().toISOString(),
      type: "message",
      content: "aether 组装管线测试",
    });

    const ctx = assembly.createAgentEventContext({
      processId: seeded.processId,
      worktreePath: "D:\\wt\\wt-assembly",
      loadEvents: async () => [],
    });
    ctx.emit(event);
    expect(assembly.logSink.pendingCount()).toBe(1);

    const written = assembly.logSink.flushNow();
    expect(written).toBe(1);
    const logs = new ExecutionProcessLogRepository(assembly.db);
    const rows = logs.findByProcessId(seeded.processId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rawJson).toBe(JSON.stringify(event)); // 定案：rawJson = 归一化事件 JSON
    expect(rows[0]?.seq).toBe(1);

    void assembly.close();
  });

  it("SDK 原始行直接灌 sink → replayProcessLogs 归属自动接线（sessionId 来自 execution_process 行）", () => {
    const assembly = makeAssembly();
    const seeded = seedProcess(assembly);
    const rawLine = firstFixtureLine();

    assembly.logSink.append(seeded.processId, rawLine);
    assembly.logSink.flushNow();

    const result = assembly.replayProcessLogs(seeded.processId);
    expect(result.backfilledRowCount).toBe(1);
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.sessionId === seeded.sessionId)).toBe(true);

    void assembly.close();
  });

  it("replayProcessLogs 未知 processId → 中文错误", () => {
    const assembly = makeAssembly();
    expect(() => assembly.replayProcessLogs("no-such-process")).toThrow(/no-such-process/);
    void assembly.close();
  });

  // spec-review minor 回归：emit 写入的行 = 归一化 ProviderEvent（mapSdkMessage
  // 只认 SDK 帧类型，直接走 normalizeLogs 会静默重放 0 事件）——重放服务须
  // 探测透传，对账口径（重放输出 == emit 入库事件）当下成立。
  it("emit 写入的归一化行 → replayProcessLogs 透传重放，事件不丢且归属修正", () => {
    const assembly = makeAssembly();
    const seeded = seedProcess(assembly);
    const event: ProviderEvent = ProviderEventSchema.parse({
      eventId: `${seeded.processId}-emit-1`,
      // 故意用与 execution_process 行不同的 sessionId：重放须统一改写为行归属
      sessionId: "session-foreign",
      occurredAt: new Date().toISOString(),
      type: "message",
      content: "emit 行重放回归",
    });
    assembly.logSink.append(seeded.processId, JSON.stringify(event));
    assembly.logSink.flushNow();

    const result = assembly.replayProcessLogs(seeded.processId);
    expect(result.backfilledRowCount).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: "message", content: "emit 行重放回归" });
    expect(result.events[0]?.sessionId).toBe(seeded.sessionId); // 归属修正生效
    void assembly.close();
  });
});

describe("组装根：优雅关闭", () => {
  it("close() 幂等；关闭后数据库不可再查（连接已释放）", async () => {
    const assembly = makeAssembly();
    await assembly.close();
    await assembly.close(); // 幂等
    const logs = new ExecutionProcessLogRepository(assembly.db);
    expect(() => logs.findByProcessId("any")).toThrow();
  });
});

describe("组装根：P0-11 服务装配与 warmup 孤儿收口", () => {
  it("装配暴露 catalog/agents/diff 服务（router 依赖源）", () => {
    const assembly = makeAssembly();
    expect(assembly.catalog).toBeDefined();
    expect(assembly.agents).toBeDefined();
    expect(assembly.diff).toBeDefined();
    expect(assembly.agents.registeredSessionCount).toBe(0); // daemon 重启后表清空（内存态）
    void assembly.close();
  });

  it("warmup 注入缝幂等；close() 等待在途 warmup 收口（哑 PTY 不在池中，不吊进程）", async () => {
    let started = 0;
    let releaseWarmup: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseWarmup = resolve;
    });
    const assembly = createDaemonAssembly({
      dbPath: ":memory:",
      warmup: () => {
        started += 1;
        return gate;
      },
    });
    assembly.warmupConptyInBackground();
    assembly.warmupConptyInBackground(); // 在途不重复发起
    expect(started).toBe(1);

    let closed = false;
    const closing = assembly.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false); // warmup 未收口 → close 阻塞等待（孤儿收口语义）
    releaseWarmup();
    await closing;
    expect(closed).toBe(true);
  });
});
