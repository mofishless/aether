import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "@aether/contracts";
import { EPOCH_PLACEHOLDER, mapSdkMessage, normalizeStream } from "../src/normalize.js";

// ===== SDK 事件样本：形状依据 @anthropic-ai/claude-agent-sdk@0.3.325 sdk.d.ts =====
// （SDKSystemMessage/SDKAssistantMessage/SDKUserMessage/SDKResultMessage 等；
//   官方文档 https://code.claude.com/docs/en/agent-sdk/typescript）

const SESSION_ID = "session-1";
const OCCURRED_AT = "2026-01-01T00:00:00Z";

function ctx(seq: number) {
  return { sessionId: SESSION_ID, seq, occurredAt: OCCURRED_AT, eventIdPrefix: "live" };
}

function baseEvent(seq: number, suffix = ""): Record<string, unknown> {
  return {
    eventId: `live-${seq}${suffix ? `-${suffix}` : ""}`,
    sessionId: SESSION_ID,
    occurredAt: OCCURRED_AT,
  };
}

describe("mapSdkMessage：system/init → session(externalSessionId) + status(ready)", () => {
  const initMessage = {
    type: "system",
    subtype: "init",
    session_id: "ext-abc",
    claude_code_version: "2.1.325",
    model: "claude-sonnet-5-5",
    cwd: "/repo",
    tools: ["Read", "Bash"],
    permissionMode: "default",
    slash_commands: [],
    mcp_servers: [],
    output_style: "default",
    skills: [],
    plugins: [],
    apiKeySource: "none",
  };

  it("init 映射为 session + status(ready) 两条事件（顺序：session 先）", () => {
    const mapped = mapSdkMessage(initMessage, ctx(1));
    expect(mapped.events).toHaveLength(2);
    expect(mapped.events[0]).toEqual({
      ...baseEvent(1, "0"),
      type: "session",
      externalSessionId: "ext-abc",
    });
    expect(mapped.events[1]).toEqual({
      ...baseEvent(1, "1"),
      type: "status",
      status: "ready",
    });
    expect(mapped.externalSessionId).toBe("ext-abc");
    expect(mapped.terminal).toBeNull();
    expect(mapped.skippedType).toBeNull();
  });

  it("init 缺 session_id 时 externalSessionId 事件为 null（握手仍发生）", () => {
    const mapped = mapSdkMessage({ ...initMessage, session_id: undefined }, ctx(1));
    expect(mapped.events[0]).toEqual({
      ...baseEvent(1, "0"),
      type: "session",
      externalSessionId: null,
    });
  });
});

describe("mapSdkMessage：assistant → message / tool_use", () => {
  it("text 块 → message（content=块文本）", () => {
    const mapped = mapSdkMessage(
      {
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [{ type: "text", text: "你好，任务完成" }],
          stop_reason: null,
        },
        parent_tool_use_id: null,
        uuid: "u-1",
        session_id: "ext-abc",
      },
      ctx(2),
    );
    expect(mapped.events).toEqual([
      { ...baseEvent(2, "0"), type: "message", content: "你好，任务完成" },
    ]);
  });

  it("tool_use 块 → tool_use（toolUseId=块 id，input 原样透传）", () => {
    const input = { command: "npm test", description: "跑测试" };
    const mapped = mapSdkMessage(
      {
        type: "assistant",
        message: {
          id: "msg_2",
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_01", name: "Bash", input }],
        },
        parent_tool_use_id: null,
        uuid: "u-2",
        session_id: "ext-abc",
      },
      ctx(3),
    );
    expect(mapped.events).toEqual([
      { ...baseEvent(3, "0"), type: "tool_use", toolUseId: "toolu_01", name: "Bash", input },
    ]);
  });

  it("thinking 块与空 text 块静默丢弃（已知形状，无 ProviderEvent 成员）；多块混合保持顺序", () => {
    const mapped = mapSdkMessage(
      {
        type: "assistant",
        message: {
          id: "msg_3",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "推理中", signature: "sig" },
            { type: "text", text: "" },
            { type: "text", text: "第一步" },
            { type: "tool_use", id: "toolu_02", name: "Read", input: { file_path: "/x" } },
          ],
        },
        parent_tool_use_id: null,
        uuid: "u-3",
        session_id: "ext-abc",
      },
      ctx(4),
    );
    expect(mapped.events.map((ev) => ev.type)).toEqual(["message", "tool_use"]);
    expect((mapped.events[0] as Extract<ProviderEvent, { type: "message" }>).content).toBe(
      "第一步",
    );
    expect(mapped.events[1]).toEqual({
      ...baseEvent(4, "3"),
      type: "tool_use",
      toolUseId: "toolu_02",
      name: "Read",
      input: { file_path: "/x" },
    });
  });

  it("assistant 携带 error 字段 → error 事件", () => {
    const mapped = mapSdkMessage(
      {
        type: "assistant",
        message: { id: "msg_4", role: "assistant", content: [] },
        parent_tool_use_id: null,
        uuid: "u-4",
        session_id: "ext-abc",
        error: "rate_limit",
      },
      ctx(5),
    );
    expect(mapped.events).toHaveLength(1);
    expect(mapped.events[0]).toEqual({
      ...baseEvent(5, "0"),
      type: "error",
      message: "assistant rate_limit",
    });
  });

  it("subagent 帧（parent_tool_use_id 非空）照常映射（事件流含子代理活动）", () => {
    const mapped = mapSdkMessage(
      {
        type: "assistant",
        message: {
          id: "msg_5",
          role: "assistant",
          content: [{ type: "text", text: "子代理输出" }],
        },
        parent_tool_use_id: "toolu_parent",
        uuid: "u-5",
        session_id: "ext-abc",
      },
      ctx(6),
    );
    expect(mapped.events).toHaveLength(1);
    expect(mapped.events[0]?.type).toBe("message");
  });
});

describe("mapSdkMessage：user → tool_result", () => {
  it("tool_result 块 → tool_result（isError 缺省 false）", () => {
    const mapped = mapSdkMessage(
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "退出码 0" }],
        },
        parent_tool_use_id: null,
        uuid: "u-6",
        session_id: "ext-abc",
        tool_use_result: { stdout: "退出码 0" },
      },
      ctx(7),
    );
    expect(mapped.events).toEqual([
      {
        ...baseEvent(7, "0"),
        type: "tool_result",
        toolUseId: "toolu_01",
        output: "退出码 0",
        isError: false,
      },
    ]);
  });

  it("is_error:true 透传；文本型 user 消息静默丢弃", () => {
    const mapped = mapSdkMessage(
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "旁路文本" },
            { type: "tool_result", tool_use_id: "toolu_02", content: "失败", is_error: true },
          ],
        },
        parent_tool_use_id: null,
        uuid: "u-7",
        session_id: "ext-abc",
      },
      ctx(8),
    );
    expect(mapped.events).toHaveLength(1);
    expect(mapped.events[0]).toEqual({
      ...baseEvent(8, "1"),
      type: "tool_result",
      toolUseId: "toolu_02",
      output: "失败",
      isError: true,
    });
  });
});

describe("mapSdkMessage：result → 终态意图（不立即物化事件）", () => {
  const successResult = {
    type: "result",
    subtype: "success",
    result: "ok",
    is_error: false,
    duration_ms: 1200,
    duration_api_ms: 900,
    num_turns: 1,
    session_id: "ext-abc",
    usage: { input_tokens: 10, output_tokens: 5 },
    total_cost_usd: 0.01,
  };

  it("success → terminal(clean)（事件数组为空，externalSessionId 提取）", () => {
    const mapped = mapSdkMessage(successResult, ctx(9));
    expect(mapped.events).toEqual([]);
    expect(mapped.terminal).toEqual({ kind: "clean", externalSessionId: "ext-abc" });
    expect(mapped.externalSessionId).toBe("ext-abc");
  });

  it("success 但 is_error=true（轮内 API 错误文本）→ terminal(error)", () => {
    const mapped = mapSdkMessage(
      { ...successResult, is_error: true, result: "API overloaded" },
      ctx(9),
    );
    expect(mapped.terminal).toEqual({ kind: "error", message: "API overloaded" });
  });

  it("error_max_turns → terminal(error)，消息取 errors 数组", () => {
    const mapped = mapSdkMessage(
      {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 4,
        session_id: "ext-abc",
        usage: { input_tokens: 1, output_tokens: 1 },
        total_cost_usd: 0,
        permission_denials: [],
        errors: ["超过最大轮次"],
        modelUsage: {},
      },
      ctx(9),
    );
    expect(mapped.terminal).toEqual({ kind: "error", message: "超过最大轮次" });
  });

  it("error_during_execution 无 errors 数组时用 subtype 兜底", () => {
    const mapped = mapSdkMessage(
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        session_id: "ext-abc",
        usage: { input_tokens: 1, output_tokens: 1 },
        total_cost_usd: 0,
        permission_denials: [],
        errors: [],
        modelUsage: {},
      },
      ctx(9),
    );
    expect(mapped.terminal).toEqual({ kind: "error", message: "error_during_execution" });
  });
});

describe("mapSdkMessage：已知无映射与未知事件 → 跳过并计数", () => {
  it.each([
    [
      "stream_event（partial message，includePartialMessages 关闭时不出现）",
      { type: "stream_event" },
    ],
    [
      "system/status（compacting/requesting，P0 无对应成员）",
      { type: "system", subtype: "status", status: "requesting" },
    ],
    ["system/compact_boundary", { type: "system", subtype: "compact_boundary" }],
    ["未知类型 banana", { type: "banana" }],
    ["无 type 字段的垃圾输入", { nope: 1 }],
    ["null 输入", null],
  ])("%s → 事件空、skippedType 打标签", (_name, message) => {
    const mapped = mapSdkMessage(message, ctx(10));
    expect(mapped.events).toEqual([]);
    expect(mapped.terminal).toBeNull();
    expect(mapped.externalSessionId).toBeNull();
    expect(typeof mapped.skippedType).toBe("string");
    expect(mapped.skippedType).not.toBe("");
  });

  it("skippedType：未知类型用 type 字符串；无 type 用 unknown；system 子类型带 subtype 后缀", () => {
    expect(mapSdkMessage({ type: "banana" }, ctx(1)).skippedType).toBe("banana");
    expect(mapSdkMessage({ nope: 1 }, ctx(1)).skippedType).toBe("unknown");
    expect(mapSdkMessage({ type: "system", subtype: "compact_boundary" }, ctx(1)).skippedType).toBe(
      "system/compact_boundary",
    );
  });
});

describe("normalizeStream：整流归一化（normalizeLogs 旁路转换器共用路径）", () => {
  const journey: unknown[] = [
    {
      type: "system",
      subtype: "init",
      session_id: "ext-abc",
      claude_code_version: "2.1.325",
      model: "m",
      cwd: "/r",
      tools: [],
      permissionMode: "default",
      slash_commands: [],
      mcp_servers: [],
      output_style: "default",
      skills: [],
      plugins: [],
      apiKeySource: "none",
    },
    {
      type: "assistant",
      message: { id: "m1", role: "assistant", content: [{ type: "text", text: "hi" }] },
      parent_tool_use_id: null,
      uuid: "u1",
      session_id: "ext-abc",
    },
    {
      type: "result",
      subtype: "success",
      result: "ok",
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      session_id: "ext-abc",
      usage: {},
      total_cost_usd: 0,
    },
  ];

  it("完整旅程：materialize 终态（clean → session end 事件）+ 事件计数", () => {
    const { events, skipped, terminal } = normalizeStream({
      sessionId: SESSION_ID,
      messages: journey,
    });
    expect(events.map((ev) => ev.type)).toEqual(["session", "status", "message", "session"]);
    const last = events.at(-1) as Extract<ProviderEvent, { type: "session" }>;
    expect(last.externalSessionId).toBe("ext-abc");
    expect(last.eventId).toBe("log-3-end");
    expect(terminal).toEqual({ kind: "clean", externalSessionId: "ext-abc" });
    expect(skipped).toEqual({});
  });

  it("错误终态 materialize 为 error 事件", () => {
    const initMessage = journey[0];
    const { events } = normalizeStream({
      sessionId: SESSION_ID,
      messages: [
        initMessage,
        {
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 2,
          session_id: "ext-abc",
          usage: {},
          total_cost_usd: 0,
          permission_denials: [],
          errors: ["too many"],
          modelUsage: {},
        },
      ],
    });
    expect(events.at(-1)?.type).toBe("error");
  });

  it("未知事件跳过并按类型计数；消息缺失 vendor timestamp 时用占位纪元", () => {
    const { events, skipped } = normalizeStream({
      sessionId: SESSION_ID,
      messages: [
        { type: "banana" },
        { type: "banana" },
        { type: "task_progress" },
        {
          type: "assistant",
          message: { id: "m", role: "assistant", content: [{ type: "text", text: "x" }] },
          parent_tool_use_id: null,
          uuid: "u",
          session_id: "s",
        },
      ],
    });
    expect(skipped).toEqual({ banana: 2, task_progress: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]?.occurredAt).toBe(EPOCH_PLACEHOLDER);
    expect(events[0]?.eventId).toBe("log-4-0");
  });

  it("vendor timestamp 优先（assistant/user 帧可带 ISO timestamp）", () => {
    const { events } = normalizeStream({
      sessionId: SESSION_ID,
      messages: [
        {
          type: "assistant",
          message: { id: "m", role: "assistant", content: [{ type: "text", text: "x" }] },
          parent_tool_use_id: null,
          uuid: "u",
          session_id: "s",
          timestamp: "2026-02-03T04:05:06Z",
        },
      ],
    });
    expect(events[0]?.occurredAt).toBe("2026-02-03T04:05:06Z");
  });

  it("空输入 → 空事件、无终态", () => {
    const result = normalizeStream({ sessionId: SESSION_ID, messages: [] });
    expect(result.events).toEqual([]);
    expect(result.terminal).toBeNull();
    expect(result.skipped).toEqual({});
  });

  it("normalizeStream 对每个 ProviderEvent 通过 contracts schema 校验", async () => {
    const { ProviderEventSchema } = await import("@aether/contracts");
    const { events } = normalizeStream({ sessionId: SESSION_ID, messages: journey });
    for (const ev of events) {
      expect(() => ProviderEventSchema.parse(ev)).not.toThrow();
    }
  });
});
