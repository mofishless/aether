import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  TERMINAL_FRAME_MODE,
  TERMINAL_FRAME_VERSION,
  TerminalFrameSchema,
} from "../src/index.js";
import { expectRejected, expectRoundTrip } from "./helpers.js";

// §7.3 四帧 + §7.4 升级位（mode/version，MVP 固定 byte-replay/1）。

const base = {
  terminalId: "t-1",
  mode: TERMINAL_FRAME_MODE.BYTE_REPLAY,
  version: TERMINAL_FRAME_VERSION,
} as const;

describe("TerminalFrameSchema 各帧 round-trip", () => {
  it("output（seq + base64 data）", () => {
    expectRoundTrip(TerminalFrameSchema, { type: "output", ...base, seq: 1, data: "aGVsbG8=" });
  });
  it("input（客户端 → daemon）", () => {
    expectRoundTrip(TerminalFrameSchema, { type: "input", ...base, data: "bHM=" });
  });
  it("resize", () => {
    expectRoundTrip(TerminalFrameSchema, { type: "resize", ...base, cols: 120, rows: 40 });
  });
  it("exit（exitCode 可为 null）", () => {
    expectRoundTrip(TerminalFrameSchema, { type: "exit", ...base, exitCode: 0 });
    expectRoundTrip(TerminalFrameSchema, { type: "exit", ...base, exitCode: null });
  });
});

describe("TerminalFrameSchema 反例", () => {
  it("未知帧类型", () => {
    expectRejected(TerminalFrameSchema, { type: "close", ...base });
  });
  it("data 非 base64", () => {
    expectRejected(TerminalFrameSchema, { type: "output", ...base, seq: 1, data: "不是 base64!" });
    expectRejected(TerminalFrameSchema, { type: "input", ...base, data: 42 });
  });
  it("output 的 seq 非正整数", () => {
    expectRejected(TerminalFrameSchema, { type: "output", ...base, seq: 0, data: "aGVsbG8=" });
    expectRejected(TerminalFrameSchema, { type: "output", ...base, seq: 1.5, data: "aGVsbG8=" });
  });
  it("resize 的 cols/rows 非正整数", () => {
    expectRejected(TerminalFrameSchema, { type: "resize", ...base, cols: 0, rows: 40 });
    expectRejected(TerminalFrameSchema, { type: "resize", ...base, cols: 120, rows: -1 });
  });
  it("缺 mode / version（§7.4：帧从第一天起携带升级位）", () => {
    expectRejected(TerminalFrameSchema, {
      type: "input",
      terminalId: "t-1",
      version: 1,
      data: "bHM=",
    });
    expectRejected(TerminalFrameSchema, {
      type: "input",
      terminalId: "t-1",
      mode: "byte-replay",
      data: "bHM=",
    });
  });
  it("mode 非法值", () => {
    expectRejected(TerminalFrameSchema, {
      type: "input",
      terminalId: "t-1",
      mode: "full-frame",
      version: 1,
      data: "bHM=",
    });
  });
  it("version 非 1（MVP 固定 1）", () => {
    expectRejected(TerminalFrameSchema, {
      type: "input",
      terminalId: "t-1",
      mode: "byte-replay",
      version: 2,
      data: "bHM=",
    });
  });
});

describe("终端常量", () => {
  it("MVP 固定值", () => {
    expect(TERMINAL_FRAME_MODE.BYTE_REPLAY).toBe("byte-replay");
    expect(TERMINAL_FRAME_MODE.SNAPSHOT_DELTA).toBe("snapshot+delta");
    expect(TERMINAL_FRAME_VERSION).toBe(1);
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
