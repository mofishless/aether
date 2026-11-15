import { describe, expectTypeOf, it } from "vitest";
import { ProviderEventSchema } from "../src/index.js";
import type { ProviderEventType } from "../src/index.js";
import { expectRejected, expectRoundTrip } from "./helpers.js";

// 判别联合成员恰为 7 种（SYSTEM_DESIGN §6.2）：
// status / message / tool_use / tool_result / permission_request / session / error。

const base = {
  eventId: "evt-1",
  sessionId: "s-1",
  occurredAt: "2026-11-15T08:00:00Z",
};

describe("ProviderEventSchema 各成员 round-trip", () => {
  it("status", () => {
    expectRoundTrip(ProviderEventSchema, { ...base, type: "status", status: "running" });
  });
  it("message", () => {
    expectRoundTrip(ProviderEventSchema, { ...base, type: "message", content: "正在分析代码" });
  });
  it("tool_use", () => {
    expectRoundTrip(ProviderEventSchema, {
      ...base,
      type: "tool_use",
      toolUseId: "tu-1",
      name: "bash",
      input: { command: "pnpm test" },
    });
  });
  it("tool_result", () => {
    expectRoundTrip(ProviderEventSchema, {
      ...base,
      type: "tool_result",
      toolUseId: "tu-1",
      output: "all green",
      isError: false,
    });
  });
  it("permission_request", () => {
    expectRoundTrip(ProviderEventSchema, {
      ...base,
      type: "permission_request",
      requestId: "pr-1",
      toolName: "bash",
      summary: "rm -rf node_modules",
    });
  });
  it("session（externalSessionId 可空）", () => {
    expectRoundTrip(ProviderEventSchema, { ...base, type: "session", externalSessionId: "ext-9" });
    expectRoundTrip(ProviderEventSchema, { ...base, type: "session", externalSessionId: null });
  });
  it("error", () => {
    expectRoundTrip(ProviderEventSchema, { ...base, type: "error", message: "CLI 退出码 1" });
  });
});

describe("ProviderEventSchema 反例", () => {
  it("未知判别成员", () => {
    expectRejected(ProviderEventSchema, { ...base, type: "unknown_kind" });
  });
  it("status 载荷的枚举值非法", () => {
    expectRejected(ProviderEventSchema, { ...base, type: "status", status: "paused" });
  });
  it("message 缺 content", () => {
    expectRejected(ProviderEventSchema, { ...base, type: "message" });
  });
  it("tool_use 缺 name", () => {
    expectRejected(ProviderEventSchema, {
      ...base,
      type: "tool_use",
      toolUseId: "tu-1",
      input: {},
    });
  });
  it("tool_result 缺 isError", () => {
    expectRejected(ProviderEventSchema, {
      ...base,
      type: "tool_result",
      toolUseId: "tu-1",
      output: "x",
    });
  });
  it("permission_request 缺 toolName", () => {
    expectRejected(ProviderEventSchema, {
      ...base,
      type: "permission_request",
      requestId: "pr-1",
      summary: "x",
    });
  });
  it("缺公共字段 eventId", () => {
    expectRejected(ProviderEventSchema, {
      sessionId: "s-1",
      occurredAt: "2026-11-15T08:00:00Z",
      type: "message",
      content: "x",
    });
  });
  it("occurredAt 非 ISO", () => {
    expectRejected(ProviderEventSchema, {
      ...base,
      type: "error",
      occurredAt: "just now",
      message: "x",
    });
  });
});

describe("ProviderEvent 类型面（编译期）", () => {
  it("判别成员恰为 7 种", () => {
    expectTypeOf<ProviderEventType>().toEqualTypeOf<
      "status" | "message" | "tool_use" | "tool_result" | "permission_request" | "session" | "error"
    >();
  });
});
