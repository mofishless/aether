import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterContext, ResolvedProviderConfig } from "@aether/core";
import { applySessionEvent, INITIAL_AGENT_STATUS } from "@aether/core";
import type { AgentStatus, ProviderEvent, Session } from "@aether/contracts";
import { createCodexAdapter } from "../src/adapter.js";

// ===== mock codex app-server × 适配器全旅程集成（P1-01 验收：无真 codex、无网络）=====
// mock = tests/helpers/mock-codex-server.mjs（node 直驱），场景 JSON 选定行为；
// wire 落盘断言协议形状（experimentalApi / 无 text_elements / 审批 decision / resume 参数）。

const MOCK_SERVER = fileURLToPath(new URL("./helpers/mock-codex-server.mjs", import.meta.url));
const SCENARIOS_DIR = fileURLToPath(new URL("./helpers/scenarios/", import.meta.url));

const OCCURRED_AT = "2026-01-01T00:00:00Z";

const cfg = (): ResolvedProviderConfig => ({
  kind: "codex-app-server",
  providerConfigId: "pc-codex-mock",
  displayName: "Codex (mock)",
  config: { cliPath: MOCK_SERVER },
});

const workdirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    workdirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

interface TestBench {
  readonly events: ProviderEvent[];
  readonly wireLog: string;
  readonly ctx: AdapterContext;
}

async function newBench(scenario: string): Promise<TestBench> {
  const dir = await mkdtemp(join(tmpdir(), "aether-codex-adapter-"));
  workdirs.push(dir);
  const wireLog = join(dir, "wire.log");
  const events: ProviderEvent[] = [];
  const ctx: AdapterContext = {
    emit: (ev) => {
      events.push(ev);
    },
    worktreePath: dir,
    env: {
      AETHER_CODEX_SCENARIO: join(SCENARIOS_DIR, scenario),
      AETHER_CODEX_WIRE_LOG: wireLog,
    },
    loadEvents: async () => [],
  };
  return { events, wireLog, ctx };
}

const wireEntries = (path: string): Array<{ dir: string; frame: Record<string, unknown> }> =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { dir: string; frame: Record<string, unknown> });

const typeSeq = (events: readonly ProviderEvent[]): string[] => events.map((event) => event.type);

const messageContents = (events: readonly ProviderEvent[]): string[] =>
  events
    .filter((event) => event.type === "message")
    .map((event) => (event as { content: string }).content);

/** fold：(初始状态, 事件序列) → 应用轨迹（与 claude 侧集成测试同款断言面） */
function fold(events: readonly ProviderEvent[]): { statuses: AgentStatus[]; rejected: number } {
  let current = INITIAL_AGENT_STATUS;
  const statuses: AgentStatus[] = [];
  let rejected = 0;
  for (const event of events) {
    const result = applySessionEvent(current, event);
    if (result.transition === "applied") {
      current = result.status;
      statuses.push(result.status);
    } else {
      rejected += 1;
    }
  }
  return { statuses, rejected };
}

describe("capabilities 与 discover", () => {
  it("capabilities 按 §10 定案如实声明", () => {
    const adapter = createCodexAdapter(cfg());
    expect(adapter.kind).toBe("codex-app-server");
    expect(adapter.capabilities).toEqual({
      canResume: true,
      followUpAtMessage: false,
      permissionFlags: true,
      structuredEvents: true,
      protocols: ["codex-app-server"],
    });
  });

  it("discover：mock --version 探测成功", { timeout: 30_000 }, async () => {
    const adapter = createCodexAdapter(cfg());
    const result = await adapter.discover();
    expect(result.available).toBe(true);
    expect(result.version).toBe("0.169.0");
  });

  it("kind 校验：非 codex-app-server 拒绝", () => {
    expect(() =>
      createCodexAdapter({ ...cfg(), kind: "claude-sdk" }),
    ).toThrowErrorMatchingInlineSnapshot(
      "[Error: createCodexAdapter 只接受 kind='codex-app-server'（收到 'claude-sdk'）]",
    );
  });
});

describe("happy 全旅程：握手→thread/start→turn 流→EOF 退出", () => {
  it(
    "事件序列 session→status→message→tool_use→tool_result；fold 全合法；wire 无 text_elements + experimentalApi",
    { timeout: 120_000 },
    async () => {
      const bench = await newBench("happy.json");
      const adapter = createCodexAdapter(cfg(), {
        now: () => OCCURRED_AT,
        newId: () => `proc-${crypto.randomUUID()}`,
      });
      const proc = await adapter.spawn(
        {
          sessionId: "session-happy",
          message: "跑一遍完整旅程",
          autonomy: "workspace_write",
          model: null,
        },
        bench.ctx,
      );
      expect(typeof proc.pid).toBe("number");

      // 等 turn 完成（最后的 tool_result 到达即 turn 内容齐了）
      await vi.waitFor(
        () => {
          expect(messageContents(bench.events)).toContain("第一轮回答");
          expect(typeSeq(bench.events)).toContain("tool_result");
        },
        { timeout: 30_000 },
      );

      const session = bench.events.find((event) => event.type === "session");
      expect(session).toMatchObject({ type: "session", externalSessionId: "thread-mock-happy" });
      expect(messageContents(bench.events)).toEqual(["第一轮回答"]);
      const toolUse = bench.events.find((event) => event.type === "tool_use");
      expect(toolUse).toMatchObject({ toolUseId: "item-cmd-1", name: "commandExecution" });

      // wire 断言：initialize 带 experimentalApi；turn/start 输入无 text_elements（§9-1）
      const wire = wireEntries(bench.wireLog);
      const initFrame = wire.find(
        (entry) => entry.dir === "in" && entry.frame["method"] === "initialize",
      );
      const initParams = initFrame?.frame["params"] as Record<string, unknown>;
      expect((initParams["capabilities"] as Record<string, unknown>)["experimentalApi"]).toBe(true);
      const turnFrame = wire.find(
        (entry) => entry.dir === "in" && entry.frame["method"] === "turn/start",
      );
      const turnParams = turnFrame?.frame["params"] as Record<string, unknown>;
      const input = turnParams["input"] as Array<Record<string, unknown>>;
      expect(input[0]).toEqual({ type: "text", text: "跑一遍完整旅程" });
      // thread/start 带 autonomy 映射（§6：workspace_write → workspace-write + on-request）
      const threadFrame = wire.find(
        (entry) => entry.dir === "in" && entry.frame["method"] === "thread/start",
      );
      const threadParams = threadFrame?.frame["params"] as Record<string, unknown>;
      expect(threadParams["sandbox"]).toBe("workspace-write");
      expect(threadParams["approvalPolicy"]).toBe("on-request");
      expect(threadParams["cwd"]).toBe(bench.ctx.worktreePath);

      // cancel → stdin EOF → mock 干净退出 → 终态 session（killedByUs/干净退出均 stopped 语义）
      await adapter.cancel(proc, "user_cancelled");
      const exit = await proc.exited;
      expect(exit.code).toBe(0);
      await vi.waitFor(
        () => {
          expect(typeSeq(bench.events).at(-1)).toBe("session");
        },
        { timeout: 30_000 },
      );
      const { statuses, rejected } = fold(bench.events);
      expect(statuses.at(-1)).toBe("stopped");
      expect(rejected).toBe(0);
      await adapter.dispose();
    },
  );

  it(
    "follow-up：thread 卸载后自动 thread/resume{excludeTurns:true} 重载 → 第二轮 turn",
    { timeout: 120_000 },
    async () => {
      const bench = await newBench("happy.json");
      const adapter = createCodexAdapter(cfg(), { now: () => OCCURRED_AT });
      const proc = await adapter.spawn(
        { sessionId: "session-followup", message: "第一轮", autonomy: "auto", model: null },
        bench.ctx,
      );
      await vi.waitFor(() => expect(messageContents(bench.events)).toContain("第一轮回答"), {
        timeout: 30_000,
      });

      await adapter.spawnFollowUp(proc, { message: "第二轮" }, bench.ctx);
      await vi.waitFor(
        () => expect(messageContents(bench.events)).toContain("第二轮回答（resume 后）"),
        {
          timeout: 30_000,
        },
      );

      // wire：thread/closed 后必有 thread/resume 且 excludeTurns=true（§7 即用即卸下的续聊路径）
      const wire = wireEntries(bench.wireLog);
      const resumeFrame = wire.find(
        (entry) => entry.dir === "in" && entry.frame["method"] === "thread/resume",
      );
      expect(resumeFrame).toBeDefined();
      const resumeParams = resumeFrame?.frame["params"] as Record<string, unknown>;
      expect(resumeParams["threadId"]).toBe("thread-mock-happy");
      expect(resumeParams["excludeTurns"]).toBe(true);

      await adapter.cancel(proc, "user_cancelled");
      expect((await proc.exited).code).toBe(0);
      await adapter.dispose();
    },
  );
});

describe("审批桥（§4：双向 RPC，应答回传原 id）", () => {
  it(
    "approve → permission_request(requestId=approvalId) → 决策 accept 回传 → exitCode 0 + 回显消息",
    { timeout: 120_000 },
    async () => {
      const bench = await newBench("approval.json");
      const adapter = createCodexAdapter(cfg(), { now: () => OCCURRED_AT });
      const proc = await adapter.spawn(
        {
          sessionId: "session-approval",
          message: "触发审批",
          autonomy: "workspace_write",
          model: null,
        },
        bench.ctx,
      );
      await vi.waitFor(() => expect(typeSeq(bench.events)).toContain("permission_request"), {
        timeout: 30_000,
      });
      const request = bench.events.find((event) => event.type === "permission_request");
      expect(request).toMatchObject({
        eventId: "approval:approval-1",
        requestId: "approval-1",
        toolName: "commandExecution",
        summary: "命令：npm test",
      });
      const { statuses } = fold(bench.events);
      expect(statuses).toContain("waiting");

      await adapter.resolvePermission(proc.processId, "approval-1", "approve");
      await vi.waitFor(() => expect(messageContents(bench.events).join("")).toContain("审批结果"), {
        timeout: 30_000,
      });
      expect(messageContents(bench.events).join("")).toContain('"accept"');
      const toolResult = bench.events.find((event) => event.type === "tool_result");
      expect(toolResult).toMatchObject({ toolUseId: "item-cmd-1", isError: false });

      // wire：应答帧原样回传服务端 id（字符串）；result 是 {decision} 对象（协议 §4，
      // 双线对账：与 fixtures codex 引擎的 frame.result.decision 读法一致）
      const wire = wireEntries(bench.wireLog);
      const decision = wire.find((entry) => entry.dir === "decision");
      expect(decision?.frame).toMatchObject({ id: "srv-1", decision: "accept" });
      const answerFrame = wire.find((entry) => entry.dir === "in" && entry.frame["id"] === "srv-1");
      expect(answerFrame?.frame["result"]).toEqual({ decision: "accept" });

      await adapter.cancel(proc, "user_cancelled");
      expect((await proc.exited).code).toBe(0);
      await adapter.dispose();
    },
  );

  it("deny → decline（decline≠cancel：agent 继续 turn 完成）", { timeout: 120_000 }, async () => {
    const bench = await newBench("approval.json");
    const adapter = createCodexAdapter(cfg(), { now: () => OCCURRED_AT });
    const proc = await adapter.spawn(
      { sessionId: "session-deny", message: "触发审批", autonomy: "workspace_write", model: null },
      bench.ctx,
    );
    await vi.waitFor(() => expect(typeSeq(bench.events)).toContain("permission_request"), {
      timeout: 30_000,
    });
    await adapter.resolvePermission(proc.processId, "approval-1", "deny");
    await vi.waitFor(() => expect(messageContents(bench.events).join("")).toContain('"decline"'), {
      timeout: 30_000,
    });
    const toolResult = bench.events.find((event) => event.type === "tool_result");
    expect(toolResult).toMatchObject({ isError: true });
    const wire = wireEntries(bench.wireLog);
    expect(wire.find((entry) => entry.dir === "decision")?.frame).toMatchObject({
      id: "srv-1",
      decision: "decline",
    });
    await adapter.cancel(proc, "user_cancelled");
    await adapter.dispose();
  });

  it("无待决请求的 resolvePermission 抛错（防错答）", async () => {
    const adapter = createCodexAdapter(cfg());
    await expect(adapter.resolvePermission("proc-none", "req-none", "approve")).rejects.toThrow(
      /无待决权限请求/,
    );
  });

  it(
    "permissions approve → 应答 = 请求 params.permissions 原样回授 + scope:turn（官方 schema，F1）",
    { timeout: 120_000 },
    async () => {
      const bench = await newBench("permissions-approval.json");
      const adapter = createCodexAdapter(cfg(), { now: () => OCCURRED_AT });
      const proc = await adapter.spawn(
        {
          sessionId: "session-perm-approve",
          message: "触发权限扩展审批",
          autonomy: "workspace_write",
          model: null,
        },
        bench.ctx,
      );
      await vi.waitFor(() => expect(typeSeq(bench.events)).toContain("permission_request"), {
        timeout: 30_000,
      });
      const request = bench.events.find((event) => event.type === "permission_request");
      expect(request).toMatchObject({
        requestId: "approval-1",
        toolName: "permissions",
      });

      await adapter.resolvePermission(proc.processId, "approval-1", "approve");
      // 回显消息含授予形状（mock 把应答 result 整对象回显；先等往返完成再读 wire）
      await vi.waitFor(
        () =>
          expect(messageContents(bench.events).join("")).toContain('"network":{"enabled":true}'),
        { timeout: 30_000 },
      );
      // wire：应答帧（in, id=srv-1）result 是授予形状——permissions 原样回授 + scope:turn
      const wire = wireEntries(bench.wireLog);
      const answerFrame = wire.find((entry) => entry.dir === "in" && entry.frame["id"] === "srv-1");
      expect(answerFrame?.frame["result"]).toEqual({
        permissions: {
          fileSystem: {
            entries: [{ access: "write", path: { type: "path", path: "D:/wt/mock" } }],
          },
          network: { enabled: true },
        },
        scope: "turn",
      });
      await adapter.cancel(proc, "user_cancelled");
      await adapter.dispose();
    },
  );

  it(
    "permissions deny → 应答 = 空授权（{fileSystem:null,network:null}——唯一合法拒绝形状，F1）",
    { timeout: 120_000 },
    async () => {
      const bench = await newBench("permissions-approval.json");
      const adapter = createCodexAdapter(cfg(), { now: () => OCCURRED_AT });
      const proc = await adapter.spawn(
        {
          sessionId: "session-perm-deny",
          message: "触发权限扩展审批",
          autonomy: "workspace_write",
          model: null,
        },
        bench.ctx,
      );
      await vi.waitFor(() => expect(typeSeq(bench.events)).toContain("permission_request"), {
        timeout: 30_000,
      });
      await adapter.resolvePermission(proc.processId, "approval-1", "deny");
      // 空授权 = 拒绝语义：mock 回显后命令 exitCode 1（tool_result isError；先等往返）
      await vi.waitFor(
        () => expect(bench.events.some((event) => event.type === "tool_result")).toBe(true),
        { timeout: 30_000 },
      );
      const toolResult = bench.events.find((event) => event.type === "tool_result");
      expect(toolResult).toMatchObject({ isError: true });
      // wire：应答帧（in, id=srv-1）result 是空授予形状——全 null + scope:turn
      const wire = wireEntries(bench.wireLog);
      const answerFrame = wire.find((entry) => entry.dir === "in" && entry.frame["id"] === "srv-1");
      expect(answerFrame?.frame["result"]).toEqual({
        permissions: { fileSystem: null, network: null },
        scope: "turn",
      });
      await adapter.cancel(proc, "user_cancelled");
      await adapter.dispose();
    },
  );
});

describe("error 通知与 turn 失败（§10：willRetry 才置 fail）", () => {
  it("transient：willRetry=true 不产 error 事件，turn 正常完成", { timeout: 120_000 }, async () => {
    const bench = await newBench("transient-error.json");
    const adapter = createCodexAdapter(cfg(), { now: () => OCCURRED_AT });
    const proc = await adapter.spawn(
      { sessionId: "session-transient", message: "瞬时错误", autonomy: "read_only", model: null },
      bench.ctx,
    );
    await vi.waitFor(() => expect(messageContents(bench.events)).toContain("重试后完成"), {
      timeout: 30_000,
    });
    expect(bench.events.filter((event) => event.type === "error")).toHaveLength(0);
    await adapter.cancel(proc, "user_cancelled");
    await adapter.dispose();
  });

  it(
    "turn-failed：willRetry=false + turn/completed(failed) → error 事件（配额耗尽）",
    { timeout: 120_000 },
    async () => {
      const bench = await newBench("turn-failed.json");
      const adapter = createCodexAdapter(cfg(), { now: () => OCCURRED_AT });
      const proc = await adapter.spawn(
        { sessionId: "session-failed", message: "失败路径", autonomy: "read_only", model: null },
        bench.ctx,
      );
      await vi.waitFor(
        () => {
          const errors = bench.events.filter((event) => event.type === "error");
          expect(errors).toHaveLength(1);
          expect((errors[0] as { message: string }).message).toContain("配额耗尽");
        },
        { timeout: 30_000 },
      );
      const { statuses } = fold(bench.events);
      expect(statuses.at(-1)).toBe("error");
      await adapter.cancel(proc, "user_cancelled");
      expect((await proc.exited).code).toBe(0);
      await adapter.dispose();
    },
  );
});

describe("取消（§10 定案：interrupt → 等 turn/completed ≤5s → EOF → 树杀兜底）", () => {
  it(
    "interruptible：中断后 turn/completed(interrupted)，不产 error，终态 session/stopped",
    { timeout: 120_000 },
    async () => {
      const bench = await newBench("interruptible.json");
      const adapter = createCodexAdapter(cfg(), { now: () => OCCURRED_AT });
      const proc = await adapter.spawn(
        {
          sessionId: "session-interrupt",
          message: "长任务",
          autonomy: "workspace_write",
          model: null,
        },
        bench.ctx,
      );
      await vi.waitFor(() => expect(messageContents(bench.events)).toContain("开始长任务"), {
        timeout: 30_000,
      });
      await adapter.cancel(proc, "user_cancelled");
      const exit = await proc.exited;
      expect(exit.code).toBe(0);
      await vi.waitFor(
        () => {
          expect(typeSeq(bench.events).at(-1)).toBe("session");
        },
        { timeout: 30_000 },
      );
      expect(bench.events.filter((event) => event.type === "error")).toHaveLength(0);
      expect(messageContents(bench.events)).not.toContain("不应到达（被中断）");
      const { statuses, rejected } = fold(bench.events);
      expect(statuses.at(-1)).toBe("stopped");
      expect(rejected).toBe(0);
      await adapter.dispose();
    },
  );
});

describe("服务端 mid-turn 死亡与 respawn（P1-01 评审 F3）", () => {
  it(
    "mid-turn 死亡 → ensureServer respawn 重置 activeTurnId → followUp 恢复成功（不空等 5s）",
    { timeout: 120_000 },
    async () => {
      const bench = await newBench("crash-midturn.json");
      const adapter = createCodexAdapter(cfg(), { now: () => OCCURRED_AT });
      const proc = await adapter.spawn(
        { sessionId: "session-crash", message: "长任务", autonomy: "read_only", model: null },
        bench.ctx,
      );
      await vi.waitFor(() => expect(messageContents(bench.events)).toContain("长任务进行中"), {
        timeout: 30_000,
      });
      // mock mid-turn exit(3)：turn/completed 永不到达 → 退出证明物化 error 事件
      await vi.waitFor(
        () =>
          expect(
            bench.events.some(
              (event) =>
                event.type === "error" &&
                (event as { message: string }).message.includes("非零退出"),
            ),
          ).toBe(true),
        { timeout: 30_000 },
      );

      // followUp：respawn + thread/resume 重载 + 新 turn——respawn 未重置 activeTurnId
      // 时 startTurn 会先空等 turn/completed（5s 上限）再抛"上一 turn 尚未完成"冲突
      // （缺陷存在则此 await 直接 rejects，无需额外时序断言）
      await adapter.spawnFollowUp(proc, { message: "继续" }, bench.ctx);
      await vi.waitFor(() => expect(messageContents(bench.events)).toContain("复活后的回答"), {
        timeout: 30_000,
      });

      // wire：respawn 后必有第二条 initialize + thread/resume（同 thread 重载）
      const wire = wireEntries(bench.wireLog);
      const initCount = wire.filter(
        (entry) => entry.dir === "in" && entry.frame["method"] === "initialize",
      ).length;
      expect(initCount).toBe(2);
      const resumeFrame = wire.find(
        (entry) => entry.dir === "in" && entry.frame["method"] === "thread/resume",
      );
      const resumeParams = resumeFrame?.frame["params"] as Record<string, unknown>;
      expect(resumeParams["threadId"]).toBe("thread-mock-crash");
      expect(resumeParams["excludeTurns"]).toBe(true);

      await adapter.cancel(proc, "user_cancelled");
      await adapter.dispose();
    },
  );
});

describe("恢复（§5/§10：thread/resume 默认全量水合 + rejoin）", () => {
  const sessionRecord = (id: string, threadId: string): Session => ({
    id,
    workspaceId: "ws-1",
    agentProfileId: "ap-1",
    externalSessionId: threadId,
    status: "starting",
    lineageParentId: null,
    checkpointRef: null,
    createdAt: "2026-01-01T00:00:00Z",
    lastActiveAt: "2026-01-01T00:00:00Z",
  });

  it(
    "resume：session 事件 + 历史水合（message/推理/计划/工具双事件）→ follow-up rejoin 新 turn",
    { timeout: 120_000 },
    async () => {
      const bench = await newBench("resume.json");
      const adapter = createCodexAdapter(cfg(), { now: () => OCCURRED_AT });
      const proc = await adapter.resume(
        sessionRecord("session-resume", "thread-mock-resume"),
        bench.ctx,
      );
      expect(typeof proc.pid).toBe("number");

      await vi.waitFor(
        () => {
          expect(messageContents(bench.events)).toContain("历史消息一");
          expect(messageContents(bench.events)).toContain("历史推理摘要");
        },
        { timeout: 30_000 },
      );
      const session = bench.events.find((event) => event.type === "session");
      expect(session).toMatchObject({ externalSessionId: "thread-mock-resume" });
      // 水合：工具项 → tool_use+tool_result 双事件；userMessage 跳过
      expect(typeSeq(bench.events)).toEqual(
        expect.arrayContaining(["session", "message", "message", "tool_use", "tool_result"]),
      );
      expect(messageContents(bench.events)).not.toContain("用户历史输入（应跳过）");

      // rejoin 后续聊：turn/start 直接发（threadLoaded）
      await adapter.spawnFollowUp(proc, { message: "接着历史说" }, bench.ctx);
      await vi.waitFor(() => expect(messageContents(bench.events)).toContain("rejoin 后的新回答"), {
        timeout: 30_000,
      });
      await adapter.cancel(proc, "user_cancelled");
      expect((await proc.exited).code).toBe(0);
      await adapter.dispose();
    },
  );

  it("resume 前置条件：externalSessionId 为空 → 抛错", async () => {
    const bench = await newBench("resume.json");
    const adapter = createCodexAdapter(cfg());
    await expect(adapter.resume(sessionRecord("s2", ""), bench.ctx)).rejects.toThrow(
      /externalSessionId 为空/,
    );
    await adapter.dispose();
  });
});

describe("normalizeLogs 旁路重放", () => {
  it("原始 wire 行 → 事件（session/审批/通知共存）", () => {
    const adapter = createCodexAdapter(cfg());
    const raw = [
      JSON.stringify({ id: 1, result: { userAgent: "codex" } }),
      JSON.stringify({
        method: "turn/started",
        params: { threadId: "t", turn: { id: "tu" } },
        emittedAtMs: 1767225600000,
      }),
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "t",
          turnId: "tu",
          item: { type: "agentMessage", id: "i", text: "重放" },
        },
        emittedAtMs: 1767225600001,
      }),
      JSON.stringify({
        id: "srv-9",
        method: "item/commandExecution/requestApproval",
        params: { approvalId: "a9" },
      }),
    ];
    const events = adapter.normalizeLogs(raw);
    expect(events.map((event) => event.type)).toEqual(["status", "message", "permission_request"]);
    expect(events[2]).toMatchObject({ eventId: "approval:a9" });
    expect(
      events.every((event) => event.sessionId === "replay" || event.sessionId.length > 0),
    ).toBe(true);
  });
});

describe("dispose 幂等与未知句柄", () => {
  it("未知 processId 的 cancel 静默无操作；dispose 空表不抛", async () => {
    const adapter = createCodexAdapter(cfg());
    await expect(
      adapter.cancel(
        {
          processId: "nope",
          pid: null,
          cancel: async () => undefined,
          exited: Promise.resolve({ code: 0 }),
        },
        "user_cancelled",
      ),
    ).resolves.toBeUndefined();
    await expect(adapter.dispose()).resolves.toBeUndefined();
  });
});
