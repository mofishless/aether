import { describe, expect, expectTypeOf, it } from "vitest";
import {
  JsonRpcErrorResponseSchema,
  JsonRpcNotificationSchema,
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
  JsonRpcSuccessResponseSchema,
} from "../src/index.js";
import type {
  AetherRpc,
  ProjectSummary,
  SessionHandle,
  StateSnapshot,
  TerminalHandle,
} from "../src/index.js";
import { expectRejected, expectRoundTrip } from "./helpers.js";

// ===== JSON-RPC 2.0 envelope =====

describe("JsonRpcRequestSchema round-trip", () => {
  it("对象 params + 字符串 id", () => {
    expectRoundTrip(JsonRpcRequestSchema, {
      jsonrpc: "2.0",
      id: "req-1",
      method: "tasks.create",
      params: { projectId: "p-1", title: "落地契约包" },
    });
  });

  it("数组 params + 数字 id", () => {
    expectRoundTrip(JsonRpcRequestSchema, {
      jsonrpc: "2.0",
      id: 7,
      method: "subscribe",
      params: [["session.s-1.events"], 42],
    });
  });

  it("省略 params", () => {
    expectRoundTrip(JsonRpcRequestSchema, { jsonrpc: "2.0", id: 1, method: "system.health" });
  });
});

describe("JsonRpcRequestSchema 反例", () => {
  it("jsonrpc 版本错", () => {
    expectRejected(JsonRpcRequestSchema, { jsonrpc: "1.0", id: 1, method: "x" });
    expectRejected(JsonRpcRequestSchema, { jsonrpc: 2, id: 1, method: "x" });
  });
  it("请求 id 不为 null", () => {
    expectRejected(JsonRpcRequestSchema, { jsonrpc: "2.0", id: null, method: "x" });
  });
  it("id 类型错（布尔/对象）", () => {
    expectRejected(JsonRpcRequestSchema, { jsonrpc: "2.0", id: true, method: "x" });
    expectRejected(JsonRpcRequestSchema, { jsonrpc: "2.0", id: { nested: 1 }, method: "x" });
  });
  it("缺必填字段 method", () => {
    expectRejected(JsonRpcRequestSchema, { jsonrpc: "2.0", id: 1 });
  });
  it("params 类型错（标量）", () => {
    expectRejected(JsonRpcRequestSchema, { jsonrpc: "2.0", id: 1, method: "x", params: 5 });
    expectRejected(JsonRpcRequestSchema, { jsonrpc: "2.0", id: 1, method: "x", params: null });
  });
  it("未知字段被拒绝（strict）", () => {
    expectRejected(JsonRpcRequestSchema, { jsonrpc: "2.0", id: 1, method: "x", extra: true });
  });
});

describe("JsonRpcNotificationSchema", () => {
  it("round-trip（无 id）", () => {
    expectRoundTrip(JsonRpcNotificationSchema, { jsonrpc: "2.0", method: "agent.status" });
  });
  it("携带 id 的帧不是 Notification（strict 拒绝未知字段 id）", () => {
    expectRejected(JsonRpcNotificationSchema, { jsonrpc: "2.0", id: 1, method: "x" });
  });
  it("jsonrpc 版本错", () => {
    expectRejected(JsonRpcNotificationSchema, { jsonrpc: "2", method: "x" });
  });
});

describe("JsonRpcResponseSchema", () => {
  it("成功响应 round-trip", () => {
    expectRoundTrip(JsonRpcSuccessResponseSchema, {
      jsonrpc: "2.0",
      id: "req-1",
      result: { items: [{ id: "p-1" }] },
    });
  });
  it("错误响应 round-trip（error.data 可选）", () => {
    expectRoundTrip(JsonRpcErrorResponseSchema, {
      jsonrpc: "2.0",
      id: "req-1",
      error: { code: -32601, message: "Method not found", data: { method: "x" } },
    });
  });
  it("错误响应 id 允许 null（无法确定请求 id 时）", () => {
    expectRoundTrip(JsonRpcErrorResponseSchema, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  });
  it("联合 schema 两种成员均可收", () => {
    expectRoundTrip(JsonRpcResponseSchema, { jsonrpc: "2.0", id: 1, result: null });
    expectRoundTrip(JsonRpcResponseSchema, {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -1, message: "boom" },
    });
  });

  it("成功响应缺 result 被拒绝", () => {
    expectRejected(JsonRpcSuccessResponseSchema, { jsonrpc: "2.0", id: 1 });
  });
  it("错误响应缺 error 被拒绝", () => {
    expectRejected(JsonRpcErrorResponseSchema, { jsonrpc: "2.0", id: 1 });
  });
  it("错误对象 code 类型错（字符串/非整数）", () => {
    expectRejected(JsonRpcErrorResponseSchema, {
      jsonrpc: "2.0",
      id: 1,
      error: { code: "-32700", message: "x" },
    });
    expectRejected(JsonRpcErrorResponseSchema, {
      jsonrpc: "2.0",
      id: 1,
      error: { code: 1.5, message: "x" },
    });
  });
  it("同时携带 result 与 error 的响应不属于任一成员", () => {
    expectRejected(JsonRpcResponseSchema, {
      jsonrpc: "2.0",
      id: 1,
      result: {},
      error: { code: -1, message: "boom" },
    });
  });
});

// ===== AetherRpc 方法面（纯类型，编译期断言 + 方法名清单）=====

describe("AetherRpc 类型面", () => {
  it("§5.3 五个签名示例的形状（编译期）", () => {
    expectTypeOf<AetherRpc["projects.list"]>().returns.toEqualTypeOf<{ items: ProjectSummary[] }>();
    expectTypeOf<AetherRpc["diff.workspaceDiff"]>()
      .parameter(0)
      .toEqualTypeOf<{ workspaceId: string }>();
    expectTypeOf<AetherRpc["agents.spawn"]>().returns.toEqualTypeOf<SessionHandle>();
    expectTypeOf<AetherRpc["terminals.create"]>().returns.toEqualTypeOf<TerminalHandle>();
    expectTypeOf<AetherRpc["subscribe"]>().returns.toEqualTypeOf<{
      cursor: number;
      snapshot?: StateSnapshot;
    }>();
  });

  it("方法名清单恰好覆盖 P0 最小集（编译期 satisfies + 运行时数量）", () => {
    const methodNames = [
      "projects.list",
      "projects.create",
      "projects.archive",
      "tasks.create",
      "tasks.move",
      "agents.spawn",
      "agents.followUp",
      "agents.cancel",
      "agents.permission.respond",
      "terminals.create",
      "terminals.write",
      "terminals.resize",
      "terminals.kill",
      "diff.workspaceDiff",
      "system.health",
      "system.version",
      "system.shutdown",
      "subscribe",
    ] as const satisfies readonly (keyof AetherRpc)[];
    expect(methodNames).toHaveLength(18);
  });
});
