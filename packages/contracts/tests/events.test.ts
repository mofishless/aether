import { describe, expect, expectTypeOf, it } from "vitest";
import {
  EventEnvelopeSchema,
  STATIC_TOPIC,
  processLogsTopic,
  sessionEventsTopic,
  sessionStateTopic,
  terminalOutputTopic,
} from "../src/index.js";
import type { EventEnvelope } from "../src/index.js";
import { expectRejected, expectRoundTrip } from "./helpers.js";

describe("EventEnvelopeSchema round-trip", () => {
  it("对象 payload", () => {
    expectRoundTrip(EventEnvelopeSchema, {
      topic: "session.s-1.events",
      seq: 42,
      emittedAt: "2026-11-15T08:30:00Z",
      payload: { type: "message", content: "正在分析代码" },
    });
  });

  it("字符串 payload", () => {
    expectRoundTrip(EventEnvelopeSchema, {
      topic: "task.updated",
      seq: 1,
      emittedAt: "2026-11-15T08:30:00.123Z",
      payload: "task-updated",
    });
  });
});

describe("EventEnvelopeSchema 反例", () => {
  it("seq 非正整数（0 / 负数 / 浮点 / 字符串）", () => {
    expectRejected(EventEnvelopeSchema, {
      topic: "t",
      seq: 0,
      emittedAt: "2026-11-15T08:00:00Z",
      payload: null,
    });
    expectRejected(EventEnvelopeSchema, {
      topic: "t",
      seq: -1,
      emittedAt: "2026-11-15T08:00:00Z",
      payload: null,
    });
    expectRejected(EventEnvelopeSchema, {
      topic: "t",
      seq: 1.5,
      emittedAt: "2026-11-15T08:00:00Z",
      payload: null,
    });
    expectRejected(EventEnvelopeSchema, {
      topic: "t",
      seq: "1",
      emittedAt: "2026-11-15T08:00:00Z",
      payload: null,
    });
  });
  it("emittedAt 非 ISO 日期时间", () => {
    expectRejected(EventEnvelopeSchema, {
      topic: "t",
      seq: 1,
      emittedAt: "yesterday",
      payload: null,
    });
    expectRejected(EventEnvelopeSchema, {
      topic: "t",
      seq: 1,
      emittedAt: 1731652800000,
      payload: null,
    });
    expectRejected(EventEnvelopeSchema, {
      topic: "t",
      seq: 1,
      emittedAt: "2026-11-15",
      payload: null,
    });
  });
  it("缺必填字段 topic", () => {
    expectRejected(EventEnvelopeSchema, {
      seq: 1,
      emittedAt: "2026-11-15T08:00:00Z",
      payload: null,
    });
  });
  it("空 topic 被拒绝", () => {
    expectRejected(EventEnvelopeSchema, {
      topic: "",
      seq: 1,
      emittedAt: "2026-11-15T08:00:00Z",
      payload: null,
    });
  });
  it("未知字段被拒绝（wire 边界 fail-closed，与 rpc.ts envelope 约定一致）", () => {
    expectRejected(EventEnvelopeSchema, {
      topic: "t",
      seq: 1,
      emittedAt: "2026-11-15T08:00:00Z",
      payload: null,
      extra: "unknown-field",
    });
  });
});

describe("Topic 常量与构造器（§5.4 表全覆盖）", () => {
  it("静态投影 topic", () => {
    expect(STATIC_TOPIC.taskUpdated).toBe("task.updated");
    expect(STATIC_TOPIC.mailboxUpdated).toBe("mailbox.updated");
    expect(STATIC_TOPIC.workspaceStatus).toBe("workspace.status");
    expect(STATIC_TOPIC.agentStatus).toBe("agent.status");
  });

  it("参数化 topic 构造器产出点分层级字符串", () => {
    expect(sessionEventsTopic("s-1")).toBe("session.s-1.events");
    expect(sessionStateTopic("s-1")).toBe("session.s-1.state");
    expect(terminalOutputTopic("t-1")).toBe("terminal.t-1.output");
    expect(processLogsTopic("ep-1")).toBe("process.ep-1.logs");
  });

  it("构造出的 topic 均能通过 envelope 校验", () => {
    const topic = sessionEventsTopic("s-1");
    expectRoundTrip(EventEnvelopeSchema, {
      topic,
      seq: 3,
      emittedAt: "2026-11-15T08:30:00Z",
      payload: null,
    });
  });

  it("EventEnvelope<T> 泛型 payload（编译期）", () => {
    expectTypeOf<EventEnvelope<string>>().toEqualTypeOf<{
      topic: string;
      seq: number;
      emittedAt: string;
      payload: string;
    }>();
  });
});
