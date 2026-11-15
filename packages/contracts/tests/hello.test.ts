import { describe, expect, it } from "vitest";
import { ClientHelloSchema, PROTOCOL_VERSION, ServerWelcomeSchema } from "../src/index.js";
import { expectRejected, expectRoundTrip } from "./helpers.js";

describe("ClientHelloSchema round-trip", () => {
  it("token + protocolVersion", () => {
    expectRoundTrip(ClientHelloSchema, {
      type: "hello",
      token: "one-time-token",
      protocolVersion: 1,
    });
  });
});

describe("ClientHelloSchema 反例", () => {
  it("缺 token / 空 token", () => {
    expectRejected(ClientHelloSchema, { type: "hello", protocolVersion: 1 });
    expectRejected(ClientHelloSchema, { type: "hello", token: "", protocolVersion: 1 });
  });
  it("protocolVersion 非正整数", () => {
    expectRejected(ClientHelloSchema, { type: "hello", token: "t", protocolVersion: 0 });
    expectRejected(ClientHelloSchema, { type: "hello", token: "t", protocolVersion: "1" });
  });
  it("判别字段错（server 帧不能当 client hello 收）", () => {
    expectRejected(ClientHelloSchema, { type: "welcome", token: "t", protocolVersion: 1 });
  });
});

describe("ServerWelcomeSchema", () => {
  it("round-trip：protocolVersion + daemonVersion", () => {
    expectRoundTrip(ServerWelcomeSchema, {
      type: "welcome",
      protocolVersion: 1,
      daemonVersion: "0.0.1",
    });
  });
  it("缺 daemonVersion 被拒绝", () => {
    expectRejected(ServerWelcomeSchema, { type: "welcome", protocolVersion: 1 });
  });
  it("未知字段被拒绝（strict）", () => {
    expectRejected(ServerWelcomeSchema, {
      type: "welcome",
      protocolVersion: 1,
      daemonVersion: "0.0.1",
      extra: 1,
    });
  });
});

describe("PROTOCOL_VERSION 常量", () => {
  it("当前协议版本为 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
