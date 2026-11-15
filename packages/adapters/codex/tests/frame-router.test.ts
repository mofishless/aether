import { describe, expect, it } from "vitest";
import {
  classifyFrame,
  createFrameRouter,
  createFrameRouterCounters,
  parseFrameLine,
  type ServerNotificationFrame,
  type ServerRequestFrame,
} from "../src/frame-router.js";

// ===== 帧路由纯函数单测（协议定案 §1 四分支 / §9-3 键判别 / §8 未知容忍）=====

describe("parseFrameLine：读行 → 剥行尾 \\r → JSON.parse", () => {
  it("正常行解析为对象", () => {
    const parsed = parseFrameLine('{"id":1,"method":"initialize"}');
    expect(parsed).toEqual({ status: "frame", frame: { id: 1, method: "initialize" } });
  });

  it("剥 Windows CRLF 行尾（§1 读取侧义务）", () => {
    const parsed = parseFrameLine('{"method":"error"}\r');
    expect(parsed.status).toBe("frame");
  });

  it("空行与空白行 → empty（计数不崩）", () => {
    expect(parseFrameLine("")).toEqual({ status: "empty" });
    expect(parseFrameLine("   \r").status).toBe("empty");
  });

  it("非法 JSON → invalid 携带原因，不抛", () => {
    const parsed = parseFrameLine("{oops");
    expect(parsed.status).toBe("invalid");
    if (parsed.status === "invalid") {
      expect(parsed.error.length).toBeGreaterThan(0);
    }
  });

  it("顶层非对象（数组/数字）→ invalid", () => {
    expect(parseFrameLine("[1,2]").status).toBe("invalid");
    expect(parseFrameLine("42").status).toBe("invalid");
  });
});

describe("classifyFrame：四分支键判别（无 jsonrpc 键可依赖）", () => {
  it("id + method → 请求（id 整数与字符串皆可，§10）", () => {
    expect(
      classifyFrame({ id: 7, method: "item/commandExecution/requestApproval", params: { x: 1 } }),
    ).toEqual({
      kind: "request",
      frame: { id: 7, method: "item/commandExecution/requestApproval", params: { x: 1 } },
    });
    expect(classifyFrame({ id: "srv-1", method: "execCommandApproval" })).toEqual({
      kind: "request",
      frame: { id: "srv-1", method: "execCommandApproval" },
    });
  });

  it("method 无 id → 通知（带/不带 emittedAtMs）", () => {
    expect(
      classifyFrame({ method: "turn/started", params: { threadId: "t" }, emittedAtMs: 123 }),
    ).toEqual({
      kind: "notification",
      frame: { method: "turn/started", params: { threadId: "t" }, emittedAtMs: 123 },
    });
    expect(classifyFrame({ method: "initialized", params: {} })).toEqual({
      kind: "notification",
      frame: { method: "initialized", params: {} },
    });
  });

  it("id + result → 成功响应；id + error → 错误响应（错误对象带 data 透传）", () => {
    expect(classifyFrame({ id: 3, result: { userAgent: "codex" } })).toEqual({
      kind: "response",
      id: 3,
      result: { userAgent: "codex" },
    });
    expect(
      classifyFrame({
        id: "4",
        error: { code: -32600, message: "Not initialized", data: { reason: "x" } },
      }),
    ).toEqual({
      kind: "errorResponse",
      id: "4",
      error: { code: -32600, message: "Not initialized", data: { reason: "x" } },
    });
  });

  it("method 优先于 result：id+method+result 判为请求（服务端请求形态）", () => {
    expect(classifyFrame({ id: 9, method: "x", result: null }).kind).toBe("request");
  });

  it("无判别键 / 非 error 对象 / 非对象 → unknown", () => {
    expect(classifyFrame({ hello: "world" }).kind).toBe("unknown");
    expect(classifyFrame({ id: 1, error: "not-an-object" }).kind).toBe("unknown");
    expect(classifyFrame(null).kind).toBe("unknown");
    expect(classifyFrame([1]).kind).toBe("unknown");
    expect(classifyFrame({ id: 1 }).kind).toBe("unknown"); // 有 id 无 result/error/method
  });
});

describe("createFrameRouter：白名单分发 + 未知方法容忍计数（§8）", () => {
  interface Collected {
    requests: ServerRequestFrame[];
    notifications: ServerNotificationFrame[];
    responses: Array<{ id: string | number; payload: unknown }>;
    unknownRequests: ServerRequestFrame[];
  }
  const collect = (): Collected => ({
    requests: [],
    notifications: [],
    responses: [],
    unknownRequests: [],
  });

  it("白名单内方法正常分发；白名单外通知静默忽略并计数", () => {
    const seen = collect();
    const router = createFrameRouter({
      onServerRequest: (frame) => seen.requests.push(frame),
      onNotification: (frame) => seen.notifications.push(frame),
      onResponse: (id, payload) => {
        seen.responses.push({ id, payload });
        return true;
      },
      serverRequestMethods: new Set(["item/commandExecution/requestApproval"]),
      notificationMethods: new Set(["turn/started"]),
    });
    router.feedLine('{"id":"srv-1","method":"item/commandExecution/requestApproval"}');
    router.feedLine('{"method":"turn/started","emittedAtMs":1}');
    router.feedLine('{"method":"thread/someFutureThing"}'); // 白名单外：容忍忽略
    router.feedLine("{bad json"); // 坏行计数
    router.feedLine('{"id":1,"result":{}}');
    router.feedFrame({ id: 2, error: { code: -1, message: "m" } });

    expect(seen.requests.map((r) => r.method)).toEqual(["item/commandExecution/requestApproval"]);
    expect(seen.notifications.map((n) => n.method)).toEqual(["turn/started"]);
    expect(seen.responses.map((r) => r.id)).toEqual([1, 2]);
    expect(router.counters()).toEqual({
      ...createFrameRouterCounters(),
      invalidLines: 1,
      unknownNotificationMethods: 1,
    });
  });

  it("白名单外服务端请求走 onUnknownServerRequest 兜底并计数（防悬挂应答归 client）", () => {
    const seen = collect();
    const router = createFrameRouter({
      onServerRequest: (frame) => seen.requests.push(frame),
      onNotification: (frame) => seen.notifications.push(frame),
      onResponse: (id, payload) => {
        seen.responses.push({ id, payload });
        return true;
      },
      onUnknownServerRequest: (frame) => seen.unknownRequests.push(frame),
      serverRequestMethods: new Set(["a"]),
    });
    router.feedLine('{"id":5,"method":"b","params":{}}');
    expect(seen.requests).toHaveLength(0);
    expect(seen.unknownRequests.map((r) => r.method)).toEqual(["b"]);
    expect(router.counters().unknownServerRequestMethods).toBe(1);
  });

  it("onResponse 返回 false → orphanResponses 计数（迟到响应不崩）", () => {
    const router = createFrameRouter({
      onServerRequest: () => undefined,
      onNotification: () => undefined,
      onResponse: () => false,
    });
    router.feedLine('{"id":99,"result":null}');
    expect(router.counters().orphanResponses).toBe(1);
  });

  it("白名单缺省（undefined）= 全放行", () => {
    const seen = collect();
    const router = createFrameRouter({
      onServerRequest: (frame) => seen.requests.push(frame),
      onNotification: (frame) => seen.notifications.push(frame),
      onResponse: () => true,
    });
    router.feedLine('{"id":1,"method":"whatever/v1"}');
    router.feedLine('{"method":"whatever/v2"}');
    expect(seen.requests).toHaveLength(1);
    expect(seen.notifications).toHaveLength(1);
    expect(router.counters().unknownServerRequestMethods).toBe(0);
    expect(router.counters().unknownNotificationMethods).toBe(0);
  });
});
