// RPC 路由纯函数单测：system 三方法 round-trip、未知方法 -32601、malformed envelope。
// 所有响应帧均用 contracts 的 strict schema 断言（wire 边界 fail-closed）。
import { describe, expect, it } from "vitest";
import {
  JSON_RPC_ERROR_CODES,
  JsonRpcErrorResponseSchema,
  JsonRpcSuccessResponseSchema,
  PROTOCOL_VERSION,
} from "@aether/contracts";
import { routeMessage } from "../src/rpc/router.js";

const deps = { daemonVersion: "0.0.1", protocolVersion: PROTOCOL_VERSION };

function requestFrame(method: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...extra });
}

describe("routeMessage system 三方法", () => {
  it("system.health → Success，result 匹配契约 SystemHealth {ok}", async () => {
    const outcome = await routeMessage(requestFrame("system.health"), deps);
    expect(outcome?.kind).toBe("response");
    if (outcome?.kind !== "response") return;
    const frame = JsonRpcSuccessResponseSchema.parse(JSON.parse(outcome.frame));
    expect(frame).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  it("system.version → Success，result 匹配契约 SystemVersion", async () => {
    const outcome = await routeMessage(requestFrame("system.version"), deps);
    expect(outcome?.kind).toBe("response");
    if (outcome?.kind !== "response") return;
    const frame = JsonRpcSuccessResponseSchema.parse(JSON.parse(outcome.frame));
    expect(frame.result).toEqual({ daemonVersion: "0.0.1", protocolVersion: 1 });
  });

  it("system.shutdown → Success（result null）且带 shutdown 效果", async () => {
    const outcome = await routeMessage(requestFrame("system.shutdown"), deps);
    expect(outcome?.kind).toBe("response-and-shutdown");
    if (outcome?.kind !== "response-and-shutdown") return;
    const frame = JsonRpcSuccessResponseSchema.parse(JSON.parse(outcome.frame));
    expect(frame).toEqual({ jsonrpc: "2.0", id: 1, result: null });
  });

  it("system 方法带 params → INVALID_PARAMS -32602（fail-closed）", async () => {
    const outcome = await routeMessage(
      requestFrame("system.health", { params: { extra: true } }),
      deps,
    );
    expect(outcome?.kind).toBe("response");
    if (outcome?.kind !== "response") return;
    const frame = JsonRpcErrorResponseSchema.parse(JSON.parse(outcome.frame));
    expect(frame.error.code).toBe(JSON_RPC_ERROR_CODES.INVALID_PARAMS);
  });
});

describe("routeMessage 错误分支", () => {
  it("未知方法 → -32601，id 回显", async () => {
    const outcome = await routeMessage(requestFrame("no.such.method"), deps);
    expect(outcome?.kind).toBe("response");
    if (outcome?.kind !== "response") return;
    const frame = JsonRpcErrorResponseSchema.parse(JSON.parse(outcome.frame));
    expect(frame.id).toBe(1);
    expect(frame.error.code).toBe(JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND);
  });

  it("非 JSON 文本 → PARSE_ERROR -32700，id 为 null", async () => {
    const outcome = await routeMessage("{{{not-json", deps);
    expect(outcome?.kind).toBe("response");
    if (outcome?.kind !== "response") return;
    const frame = JsonRpcErrorResponseSchema.parse(JSON.parse(outcome.frame));
    expect(frame.id).toBeNull();
    expect(frame.error.code).toBe(JSON_RPC_ERROR_CODES.PARSE_ERROR);
  });

  it("envelope 未知字段（strict 拒绝）→ INVALID_REQUEST -32600，id 回显", async () => {
    const outcome = await routeMessage(requestFrame("system.health", { bogus: 1 }), deps);
    expect(outcome?.kind).toBe("response");
    if (outcome?.kind !== "response") return;
    const frame = JsonRpcErrorResponseSchema.parse(JSON.parse(outcome.frame));
    expect(frame.id).toBe(1);
    expect(frame.error.code).toBe(JSON_RPC_ERROR_CODES.INVALID_REQUEST);
  });

  it("缺 method → INVALID_REQUEST -32600", async () => {
    const outcome = await routeMessage(JSON.stringify({ jsonrpc: "2.0", id: 7 }), deps);
    expect(outcome?.kind).toBe("response");
    if (outcome?.kind !== "response") return;
    const frame = JsonRpcErrorResponseSchema.parse(JSON.parse(outcome.frame));
    expect(frame.id).toBe(7);
    expect(frame.error.code).toBe(JSON_RPC_ERROR_CODES.INVALID_REQUEST);
  });

  it("id 为 null 的伪 Request → INVALID_REQUEST，响应 id 只能是 null", async () => {
    const outcome = await routeMessage(
      JSON.stringify({ jsonrpc: "2.0", id: null, method: "system.health" }),
      deps,
    );
    expect(outcome?.kind).toBe("response");
    if (outcome?.kind !== "response") return;
    const frame = JsonRpcErrorResponseSchema.parse(JSON.parse(outcome.frame));
    expect(frame.id).toBeNull();
    expect(frame.error.code).toBe(JSON_RPC_ERROR_CODES.INVALID_REQUEST);
  });
});

describe("routeMessage notification", () => {
  it("合法 notification（无 id）→ 不回帧（JSON-RPC 2.0 规范）", async () => {
    const outcome = await routeMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "system.health" }),
      deps,
    );
    expect(outcome?.kind).toBe("none");
  });

  it("未知方法的 notification → 同样不回帧", async () => {
    const outcome = await routeMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "who.am.i" }),
      deps,
    );
    expect(outcome?.kind).toBe("none");
  });
});
