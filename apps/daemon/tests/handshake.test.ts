// validateHello 纯函数单测：hello 帧校验的完整判定矩阵（SYSTEM_DESIGN §5.1）。
// 合法/缺 token/token 空/未知字段用 ClientHelloSchema 语义直接断言（strict）。
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, ServerWelcomeSchema } from "@aether/contracts";
import { validateHello } from "../src/handshake.js";
import { TEST_TOKEN } from "./helpers.js";

const versions = { protocolVersion: PROTOCOL_VERSION, daemonVersion: "0.0.1" };

describe("validateHello 合法路径", () => {
  it("token 正确 + 版本一致 → welcome", () => {
    const outcome = validateHello(
      JSON.stringify({ type: "hello", token: TEST_TOKEN, protocolVersion: PROTOCOL_VERSION }),
      TEST_TOKEN,
      versions,
    );
    expect(outcome.kind).toBe("welcome");
    if (outcome.kind !== "welcome") return;
    // welcome 必须能被契约 strict schema round-trip
    expect(ServerWelcomeSchema.parse(outcome.welcome)).toEqual({
      type: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      daemonVersion: "0.0.1",
    });
  });
});

describe("validateHello 关闭 4000（malformed hello / 解析失败）", () => {
  it("非 JSON 文本", () => {
    const outcome = validateHello("not json at all", TEST_TOKEN, versions);
    expect(outcome).toMatchObject({ kind: "close", code: 4000 });
  });

  it("缺 token（strict schema 拒绝）", () => {
    const outcome = validateHello(
      JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }),
      TEST_TOKEN,
      versions,
    );
    expect(outcome).toMatchObject({ kind: "close", code: 4000 });
  });

  it("token 为空字符串", () => {
    const outcome = validateHello(
      JSON.stringify({ type: "hello", token: "", protocolVersion: PROTOCOL_VERSION }),
      TEST_TOKEN,
      versions,
    );
    expect(outcome).toMatchObject({ kind: "close", code: 4000 });
  });

  it("未知字段（strict 拒绝）", () => {
    const outcome = validateHello(
      JSON.stringify({
        type: "hello",
        token: TEST_TOKEN,
        protocolVersion: PROTOCOL_VERSION,
        extra: 1,
      }),
      TEST_TOKEN,
      versions,
    );
    expect(outcome).toMatchObject({ kind: "close", code: 4000 });
  });

  it("protocolVersion 非正整数", () => {
    const outcome = validateHello(
      JSON.stringify({ type: "hello", token: TEST_TOKEN, protocolVersion: 0 }),
      TEST_TOKEN,
      versions,
    );
    expect(outcome).toMatchObject({ kind: "close", code: 4000 });
  });
});

describe("validateHello 关闭 4001（token 不符）", () => {
  it("token 不匹配", () => {
    const outcome = validateHello(
      JSON.stringify({ type: "hello", token: "wrong-token", protocolVersion: PROTOCOL_VERSION }),
      TEST_TOKEN,
      versions,
    );
    expect(outcome).toMatchObject({ kind: "close", code: 4001 });
  });

  it("token 校验先于版本校验：token 错 + 版本也错 → 4001", () => {
    const outcome = validateHello(
      JSON.stringify({ type: "hello", token: "wrong-token", protocolVersion: 99 }),
      TEST_TOKEN,
      versions,
    );
    expect(outcome).toMatchObject({ kind: "close", code: 4001 });
  });
});

describe("validateHello 关闭 4002（protocolVersion 失配）", () => {
  it("token 正确但版本不匹配 → 4002（而非笼统 4000）", () => {
    const outcome = validateHello(
      JSON.stringify({ type: "hello", token: TEST_TOKEN, protocolVersion: 2 }),
      TEST_TOKEN,
      versions,
    );
    expect(outcome).toMatchObject({ kind: "close", code: 4002 });
  });
});

describe("validateHello 关闭 4004（hello 前收到其他消息）", () => {
  it("合法 JSON-RPC 请求帧（非 hello）→ 4004", () => {
    const outcome = validateHello(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system.health" }),
      TEST_TOKEN,
      versions,
    );
    expect(outcome).toMatchObject({ kind: "close", code: 4004 });
  });

  it("server welcome 帧回放（非 hello）→ 4004", () => {
    const outcome = validateHello(
      JSON.stringify({ type: "welcome", protocolVersion: 1, daemonVersion: "0.0.1" }),
      TEST_TOKEN,
      versions,
    );
    expect(outcome).toMatchObject({ kind: "close", code: 4004 });
  });

  it("非对象 JSON（数字/数组）→ 4004", () => {
    expect(validateHello("42", TEST_TOKEN, versions)).toMatchObject({ kind: "close", code: 4004 });
  });
});
