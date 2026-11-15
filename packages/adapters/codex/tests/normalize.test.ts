import { describe, expect, it } from "vitest";
import {
  approvalEventFor,
  approvalSummary,
  approvalToolName,
  autonomyToCodexPolicy,
  extractApprovalKey,
  isApprovalMethod,
  isoFromEmittedAt,
  mapNotification,
  mapResumeTurns,
  mapThreadItem,
  normalizeFrames,
  textUserInput,
  v1ApprovalDecision,
  v2ApprovalDecision,
} from "../src/normalize.js";
import type { ItemEventContext } from "../src/normalize.js";
import type { ProviderEvent } from "@aether/contracts";
import { applySessionEvent, INITIAL_AGENT_STATUS } from "@aether/core";

// ===== 归一化纯函数全分支单测（协议定案 §3/§4/§6/§10 映射定案）=====

const SESSION = "session-test";
const FALLBACK = "2026-01-01T00:00:00.000Z";
const TS_MS = 1767225600000; // 2026-01-01T00:00:00Z
const TS_ISO = new Date(TS_MS).toISOString();

const itemCtx = (prefix = "item/completed"): ItemEventContext => ({
  sessionId: SESSION,
  threadId: "thread-1",
  turnId: "turn-1",
  occurredAt: TS_ISO,
  eventIdPrefix: prefix,
});

describe("textUserInput：蛇形必填数组陷阱（§9-1）", () => {
  it("构造只含 type/text，省略 text_elements", () => {
    const input = textUserInput("你好");
    expect(input).toEqual({ type: "text", text: "你好" });
    expect("text_elements" in input).toBe(false);
  });
});

describe("autonomyToCodexPolicy：§6 双维映射", () => {
  it("三档映射逐项核对", () => {
    expect(autonomyToCodexPolicy("read_only")).toEqual({
      sandbox: "read-only",
      approvalPolicy: "untrusted",
    });
    expect(autonomyToCodexPolicy("workspace_write")).toEqual({
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    });
    expect(autonomyToCodexPolicy("auto")).toEqual({
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
  });
});

describe("审批映射（§4：v2 为主 + v1 蛇形兜底；decline≠cancel）", () => {
  it("v2：allow→accept / always→acceptForSession / deny→decline", () => {
    expect(v2ApprovalDecision("allow")).toBe("accept");
    expect(v2ApprovalDecision("always")).toBe("acceptForSession");
    expect(v2ApprovalDecision("deny")).toBe("decline");
  });

  it("v1：蛇形 ReviewDecision 兜底", () => {
    expect(v1ApprovalDecision("allow")).toBe("approved");
    expect(v1ApprovalDecision("always")).toBe("approved_for_session");
    expect(v1ApprovalDecision("deny")).toEqual({ denied: { rejection: "用户拒绝" } });
  });

  it("方法识别与短名", () => {
    expect(isApprovalMethod("item/commandExecution/requestApproval")).toBe(true);
    expect(isApprovalMethod("item/fileChange/requestApproval")).toBe(true);
    expect(isApprovalMethod("item/permissions/requestApproval")).toBe(true);
    expect(isApprovalMethod("execCommandApproval")).toBe(true);
    expect(isApprovalMethod("applyPatchApproval")).toBe(true);
    expect(isApprovalMethod("item/unknown/requestApproval")).toBe(false);
    expect(approvalToolName("item/commandExecution/requestApproval")).toBe("commandExecution");
    expect(approvalToolName("item/fileChange/requestApproval")).toBe("fileChange");
    expect(approvalToolName("item/permissions/requestApproval")).toBe("permissions");
    expect(approvalToolName("execCommandApproval")).toBe("execCommand(v1)");
  });

  it("extractApprovalKey：approvalId 优先于 itemId", () => {
    expect(extractApprovalKey({ approvalId: "apr-1", itemId: "item-1" })).toBe("apr-1");
    expect(extractApprovalKey({ itemId: "item-1" })).toBe("item-1");
    expect(extractApprovalKey({})).toBeNull();
  });

  it("approvalSummary：命令/文件清单/权限扩展三态", () => {
    expect(
      approvalSummary("item/commandExecution/requestApproval", { item: { command: "npm test" } }),
    ).toBe("命令：npm test");
    // 双线对账（P1-01）：fixtures codex 引擎/真实 wire 的 commandExecution 命令在
    // params.call（CommandCall {command, cwd?}）——item/call/平铺三形状都容错
    expect(
      approvalSummary("item/commandExecution/requestApproval", {
        threadId: "thread-1",
        itemId: "item-2",
        call: { command: "echo aether", cwd: "D:/wt/mock" },
        reason: "超出沙箱策略",
      }),
    ).toBe("命令：echo aether");
    expect(
      approvalSummary("item/fileChange/requestApproval", {
        item: { changes: [{ path: "/a.ts" }, { path: "/b.ts" }] },
      }),
    ).toBe("文件变更：/a.ts, /b.ts");
    expect(approvalSummary("item/permissions/requestApproval", {})).toBe("权限扩展请求");
  });

  it("approvalEventFor：eventId=approval:${key}，requestId 同 key；未识别方法返回 null", () => {
    const mapped = approvalEventFor(
      "item/commandExecution/requestApproval",
      { approvalId: "apr-9", itemId: "item-9", item: { command: "rm -rf /" } },
      { sessionId: SESSION, occurredAt: TS_ISO, fallbackKey: "srv-1" },
    );
    expect(mapped).not.toBeNull();
    expect(mapped?.event).toEqual({
      eventId: "approval:apr-9",
      sessionId: SESSION,
      occurredAt: TS_ISO,
      type: "permission_request",
      requestId: "apr-9",
      toolName: "commandExecution",
      summary: "命令：rm -rf /",
    });
    // 无 approvalId/itemId 时用兜底键
    const fallback = approvalEventFor(
      "item/fileChange/requestApproval",
      {},
      {
        sessionId: SESSION,
        occurredAt: TS_ISO,
        fallbackKey: "srv-2",
      },
    );
    expect(fallback?.event.eventId).toBe("approval:srv-2");
    expect(fallback?.key).toBe("srv-2");
    expect(
      approvalEventFor(
        "unknown/method",
        {},
        { sessionId: SESSION, occurredAt: TS_ISO, fallbackKey: "x" },
      ),
    ).toBeNull();
  });
});

describe("mapThreadItem：变体 × 相位全分支", () => {
  it("commandExecution：started→tool_use；completed→tool_result（exitCode 判 isError）", () => {
    const started = mapThreadItem(
      { type: "commandExecution", id: "item-cmd", command: "npm test", cwd: "/w" },
      "live-started",
      itemCtx("item/started"),
    );
    expect(started.events).toEqual([
      {
        eventId: `item/started:thread-1:item-cmd:${TS_ISO}`,
        sessionId: SESSION,
        occurredAt: TS_ISO,
        type: "tool_use",
        toolUseId: "item-cmd",
        name: "commandExecution",
        input: { command: "npm test", cwd: "/w" },
      },
    ]);
    const ok = mapThreadItem(
      {
        type: "commandExecution",
        id: "item-cmd",
        command: "npm test",
        exitCode: 0,
        aggregatedOutput: "ok",
      },
      "live-completed",
      itemCtx("item/completed"),
    );
    expect(ok.events[0]?.type).toBe("tool_result");
    expect(ok.events[0]).toMatchObject({ isError: false, toolUseId: "item-cmd" });
    const fail = mapThreadItem(
      { type: "commandExecution", id: "item-cmd", command: "npm test", exitCode: 2 },
      "live-completed",
      itemCtx("item/completed"),
    );
    expect(fail.events[0]).toMatchObject({ isError: true });
  });

  it("agentMessage/reasoning/plan：completed→message（reasoning/plan 附 kind）；started 零事件", () => {
    const agent = mapThreadItem(
      { type: "agentMessage", id: "i1", text: "hi" },
      "live-completed",
      itemCtx(),
    );
    expect(agent.events).toEqual([
      {
        eventId: `item/completed:thread-1:i1:${TS_ISO}`,
        sessionId: SESSION,
        occurredAt: TS_ISO,
        type: "message",
        content: "hi",
      },
    ]);
    const reasoning = mapThreadItem(
      { type: "reasoning", id: "i1", text: "想想" },
      "live-completed",
      itemCtx(),
    );
    expect(reasoning.events[0]).toMatchObject({
      type: "message",
      content: "想想",
      kind: "reasoning",
    });
    const plan = mapThreadItem(
      { type: "plan", id: "i1", text: "三步走" },
      "live-completed",
      itemCtx(),
    );
    expect(plan.events[0]).toMatchObject({ type: "message", kind: "plan" });
    const started = mapThreadItem(
      { type: "agentMessage", id: "i1", text: "hi" },
      "live-started",
      itemCtx("item/started"),
    );
    expect(started.events).toHaveLength(0);
  });

  it("fileChange 与 mcpToolCall：tool_use/tool_result 对", () => {
    const fileStarted = mapThreadItem(
      { type: "fileChange", id: "if1", changes: [{ path: "/a.ts" }] },
      "live-started",
      itemCtx("item/started"),
    );
    expect(fileStarted.events[0]).toMatchObject({ type: "tool_use", name: "fileChange" });
    const fileDone = mapThreadItem(
      { type: "fileChange", id: "if1", changes: [{ path: "/a.ts" }], exitCode: 0 },
      "live-completed",
      itemCtx("item/completed"),
    );
    expect(fileDone.events[0]).toMatchObject({ type: "tool_result", isError: false });
    const mcpStarted = mapThreadItem(
      { type: "mcpToolCall", id: "im1", server: "srv", tool: "search", arguments: { q: 1 } },
      "live-started",
      itemCtx("item/started"),
    );
    expect(mcpStarted.events[0]).toMatchObject({
      type: "tool_use",
      name: "search",
      input: { server: "srv" },
    });
    const mcpDone = mapThreadItem(
      { type: "mcpToolCall", id: "im1", status: "failed", result: "boom" },
      "live-completed",
      itemCtx("item/completed"),
    );
    expect(mcpDone.events[0]).toMatchObject({ type: "tool_result", isError: true });
  });

  it("errorContext：completed→error 事件", () => {
    const mapped = mapThreadItem(
      { type: "errorContext", id: "ie1", message: "上下文炸了" },
      "live-completed",
      itemCtx(),
    );
    expect(mapped.events[0]).toMatchObject({ type: "error", message: "上下文炸了" });
  });

  it("userMessage/webSearch：计数跳过；未知变体与非对象：计数跳过", () => {
    expect(
      mapThreadItem({ type: "userMessage", id: "i", text: "x" }, "live-completed", itemCtx())
        .skippedType,
    ).toBe("item/userMessage");
    expect(
      mapThreadItem({ type: "webSearch", id: "i" }, "live-completed", itemCtx()).skippedType,
    ).toBe("item/webSearch");
    expect(
      mapThreadItem({ type: "futureThing", id: "i" }, "live-completed", itemCtx()).skippedType,
    ).toBe("item/futureThing");
    expect(mapThreadItem("not-an-object", "live-completed", itemCtx()).skippedType).toBe(
      "item/非对象",
    );
  });

  it("hydrated：工具项 → tool_use+tool_result 双事件（eventId u 后缀区分）", () => {
    const mapped = mapThreadItem(
      { type: "commandExecution", id: "ih1", command: "ls", exitCode: 0 },
      "hydrated",
      itemCtx("history:thread-1"),
    );
    expect(mapped.events.map((event) => event.type)).toEqual(["tool_use", "tool_result"]);
    expect(mapped.events[0]?.eventId).toBe(`history:thread-1:u:thread-1:ih1:${TS_ISO}`);
    expect(mapped.events[1]?.eventId).toBe(`history:thread-1:thread-1:ih1:${TS_ISO}`);
    const message = mapThreadItem(
      { type: "agentMessage", id: "ih2", text: "历史" },
      "hydrated",
      itemCtx("history:thread-1"),
    );
    expect(message.events.map((event) => event.type)).toEqual(["message"]);
  });

  it("id 缺失时 eventId 用 turnId 兜底（公式 itemId||turnId）", () => {
    const mapped = mapThreadItem(
      { type: "agentMessage", text: "x" },
      "live-completed",
      itemCtx("item/completed"),
    );
    expect(mapped.events[0]?.eventId).toBe(`item/completed:thread-1:turn-1:${TS_ISO}`);
  });
});

describe("mapNotification：方法分支 + 侧信号", () => {
  const ctx = { sessionId: SESSION, occurredAtFallback: FALLBACK };

  it("turn/started → status running；emittedAtMs → ISO occurredAt", () => {
    const mapped = mapNotification(
      {
        method: "turn/started",
        params: { threadId: "t1", turn: { id: "turn-9", status: "inProgress" } },
        emittedAtMs: TS_MS,
      },
      ctx,
    );
    expect(mapped.events).toEqual([
      {
        eventId: `turn/started:t1:turn-9:${TS_ISO}`,
        sessionId: SESSION,
        occurredAt: TS_ISO,
        type: "status",
        status: "running",
      },
    ]);
    expect(mapped.signals.turnId).toBe("turn-9");
  });

  it("turn/completed completed/interrupted → 零事件；failed → error 事件", () => {
    const done = mapNotification(
      {
        method: "turn/completed",
        params: { threadId: "t1", turn: { id: "turn-9", status: "completed" } },
        emittedAtMs: TS_MS,
      },
      ctx,
    );
    expect(done.events).toHaveLength(0);
    expect(done.signals.turnCompletedStatus).toBe("completed");
    const interrupted = mapNotification(
      {
        method: "turn/completed",
        params: { threadId: "t1", turn: { id: "turn-9", status: "interrupted" } },
        emittedAtMs: TS_MS,
      },
      ctx,
    );
    expect(interrupted.events).toHaveLength(0);
    const failed = mapNotification(
      {
        method: "turn/completed",
        params: {
          threadId: "t1",
          turn: { id: "turn-9", status: "failed", error: { message: "配额耗尽" } },
        },
        emittedAtMs: TS_MS,
      },
      ctx,
    );
    expect(failed.events).toEqual([
      {
        eventId: `turn/completed:t1:turn-9:${TS_ISO}`,
        sessionId: SESSION,
        occurredAt: TS_ISO,
        type: "error",
        message: "配额耗尽",
      },
    ]);
    expect(failed.signals.turnError).toBe("配额耗尽");
  });

  it("item/started 与 item/completed：item 内嵌与字段平铺两种形状", () => {
    const embedded = mapNotification(
      {
        method: "item/completed",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "i1", text: "嵌套" },
        },
        emittedAtMs: TS_MS,
      },
      ctx,
    );
    expect(embedded.events[0]).toMatchObject({ type: "message", content: "嵌套" });
    const flat = mapNotification(
      {
        method: "item/completed",
        params: { threadId: "t1", turnId: "turn-1", type: "agentMessage", id: "i1", text: "平铺" },
        emittedAtMs: TS_MS,
      },
      ctx,
    );
    expect(flat.events[0]).toMatchObject({ type: "message", content: "平铺" });
  });

  it("error 通知：willRetry=true 跳过计数；false → error 事件（§10 定案）", () => {
    const transient = mapNotification(
      {
        method: "error",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          error: { message: "网络抖动" },
          willRetry: true,
        },
        emittedAtMs: TS_MS,
      },
      ctx,
    );
    expect(transient.events).toHaveLength(0);
    expect(transient.skippedType).toBe("error/willRetry");
    expect(transient.signals.errorWillRetry).toBe(true);
    const fatal = mapNotification(
      {
        method: "error",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          error: { message: "配额耗尽" },
          willRetry: false,
        },
        emittedAtMs: TS_MS,
      },
      ctx,
    );
    expect(fatal.events).toEqual([
      {
        eventId: `error:t1:turn-1:${TS_ISO}`,
        sessionId: SESSION,
        occurredAt: TS_ISO,
        type: "error",
        message: "配额耗尽",
      },
    ]);
  });

  it("thread/status/changed → threadStatus 信号；thread/closed 与 thread/started 不产事件", () => {
    const statusChanged = mapNotification(
      {
        method: "thread/status/changed",
        params: { threadId: "t1", status: { type: "notLoaded" } },
        emittedAtMs: TS_MS,
      },
      ctx,
    );
    expect(statusChanged.events).toHaveLength(0);
    expect(statusChanged.signals.threadStatus).toBe("notLoaded");
    const closed = mapNotification(
      { method: "thread/closed", params: { threadId: "t1" }, emittedAtMs: TS_MS },
      ctx,
    );
    expect(closed.events).toHaveLength(0);
    expect(closed.signals.threadId).toBe("t1");
    const started = mapNotification(
      { method: "thread/started", params: { thread: { id: "t1" } }, emittedAtMs: TS_MS },
      ctx,
    );
    expect(started.events).toHaveLength(0);
    expect(started.signals.threadId).toBe("t1");
  });

  it("未知方法 → skippedType 标签（容忍不崩）", () => {
    const mapped = mapNotification(
      { method: "thread/someFuture", params: {}, emittedAtMs: TS_MS },
      ctx,
    );
    expect(mapped.events).toHaveLength(0);
    expect(mapped.skippedType).toBe("notification/thread/someFuture");
  });
});

describe("mapResumeTurns：§5 全量水合（确定性 eventId）", () => {
  it("turns 内 items 映射为历史事件；userMessage 跳过计数；同输入重放同 eventId", () => {
    const turns = [
      {
        id: "turn-h1",
        status: "completed",
        completedAt: "2026-01-01T00:00:05.000Z",
        items: [
          { type: "agentMessage", id: "h1", text: "历史一" },
          { type: "commandExecution", id: "h2", command: "ls", exitCode: 0 },
        ],
      },
      {
        id: "turn-h2",
        startedAt: "2026-01-01T00:01:00.000Z",
        items: [{ type: "userMessage", id: "h3", text: "跳过我" }],
      },
    ];
    const first = mapResumeTurns(turns, {
      sessionId: SESSION,
      threadId: "t1",
      occurredAtFallback: FALLBACK,
    });
    expect(first.events.map((event) => event.type)).toEqual(["message", "tool_use", "tool_result"]);
    expect(first.events[0]).toMatchObject({
      eventId: "history:t1:h1:2026-01-01T00:00:05.000Z",
      occurredAt: "2026-01-01T00:00:05.000Z",
    });
    expect(first.skipped["item/userMessage"]).toBe(1);
    const second = mapResumeTurns(turns, {
      sessionId: SESSION,
      threadId: "t1",
      occurredAtFallback: FALLBACK,
    });
    expect(second.events.map((event) => event.eventId)).toEqual(
      first.events.map((event) => event.eventId),
    );
  });

  it("非数组 turns → 空结果", () => {
    expect(
      mapResumeTurns(undefined, {
        sessionId: SESSION,
        threadId: "t1",
        occurredAtFallback: FALLBACK,
      }).events,
    ).toEqual([]);
  });
});

describe("normalizeFrames：旁路重放（normalizeLogs 路径）", () => {
  it("raw 行混合通知/审批请求/响应/坏行 → 事件 + 跳过计数", () => {
    const raw = [
      JSON.stringify({
        method: "turn/started",
        params: { threadId: "t1", turn: { id: "turn-1" } },
        emittedAtMs: TS_MS,
      }),
      JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "i1", text: "重放消息" },
        },
        emittedAtMs: TS_MS,
      }),
      JSON.stringify({
        id: "srv-1",
        method: "item/commandExecution/requestApproval",
        params: { approvalId: "apr-1", item: { command: "npm i" } },
      }),
      JSON.stringify({ id: 1, result: {} }),
      "{bad",
      "   ",
    ];
    const { events, skipped } = normalizeFrames(raw, {
      sessionId: SESSION,
      occurredAtFallback: FALLBACK,
    });
    expect(events.map((event) => event.type)).toEqual(["status", "message", "permission_request"]);
    expect(events[2]).toMatchObject({ eventId: "approval:apr-1", requestId: "apr-1" });
    expect(skipped["响应/未知形状"]).toBe(1);
    expect(skipped["非法 JSON 行"]).toBe(1);
    expect(skipped["空行"]).toBe(1);
  });

  it("对象直入（已解析帧）与非对象跳过", () => {
    const { events, skipped } = normalizeFrames(
      [
        { method: "error", params: { threadId: "t1", error: { message: "m" }, willRetry: false } },
        42,
      ],
      { sessionId: SESSION, occurredAtFallback: FALLBACK },
    );
    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect(skipped["非对象帧"]).toBe(1);
  });
});

describe("isoFromEmittedAt", () => {
  it("毫秒 → ISO；非法/缺失回退", () => {
    expect(isoFromEmittedAt(TS_MS, FALLBACK)).toBe(TS_ISO);
    expect(isoFromEmittedAt(undefined, FALLBACK)).toBe(FALLBACK);
    expect(isoFromEmittedAt(Number.NaN, FALLBACK)).toBe(FALLBACK);
  });
});

describe("事件序列与核心状态机的折叠冒烟（ready→running→…，§8.1 合法性）", () => {
  it("spawn 在线路径事件序列全部合法迁移", () => {
    const events: ProviderEvent[] = [];
    const push = (mapped: { events: ProviderEvent[] }): void => {
      events.push(...mapped.events);
    };
    push(
      mapNotification(
        {
          method: "turn/started",
          params: { threadId: "t", turn: { id: "tu" } },
          emittedAtMs: TS_MS,
        },
        { sessionId: SESSION, occurredAtFallback: FALLBACK },
      ),
    );
    push(
      mapNotification(
        {
          method: "item/completed",
          params: {
            threadId: "t",
            turnId: "tu",
            item: { type: "agentMessage", id: "i", text: "m" },
          },
          emittedAtMs: TS_MS,
        },
        { sessionId: SESSION, occurredAtFallback: FALLBACK },
      ),
    );
    let status = INITIAL_AGENT_STATUS;
    for (const event of events) {
      const result = applySessionEvent(status, event);
      expect(result.transition).toBe("applied");
      status = result.status;
    }
    expect(status).toBe("running");
  });
});
