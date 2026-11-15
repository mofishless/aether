// frame-codec：contracts TerminalFrame 四帧的构造与 parse（zod 复用）。
// 构造结果必须是合法 wire 帧（mode=byte-replay / version=1 升级位齐带）。
import { describe, expect, it } from "vitest";
import {
  buildExitFrame,
  buildInputFrame,
  buildOutputFrame,
  buildResizeFrame,
  parseTerminalFrame,
} from "../src/index.js";

describe("frame-codec：终端帧构造与解析", () => {
  it("output 帧 round-trip：构造即合法，JSON 往返可解析回等价帧", () => {
    const data = Buffer.from("hello 终端", "utf8").toString("base64");
    const frame = buildOutputFrame("t1", 3, data);
    expect(frame).toEqual({
      type: "output",
      terminalId: "t1",
      seq: 3,
      data,
      mode: "byte-replay",
      version: 1,
    });
    expect(parseTerminalFrame(JSON.parse(JSON.stringify(frame)))).toEqual(frame);
  });

  it("input / resize / exit 帧 round-trip", () => {
    const input = buildInputFrame("t1", Buffer.from("ls\r").toString("base64"));
    expect(input.type).toBe("input");
    expect(parseTerminalFrame(JSON.parse(JSON.stringify(input)))).toEqual(input);

    const resize = buildResizeFrame("t1", 120, 30);
    expect(resize).toMatchObject({ type: "resize", cols: 120, rows: 30 });
    expect(parseTerminalFrame(JSON.parse(JSON.stringify(resize)))).toEqual(resize);

    const exitZero = buildExitFrame("t1", 0);
    expect(exitZero.exitCode).toBe(0);
    expect(parseTerminalFrame(JSON.parse(JSON.stringify(exitZero)))).toEqual(exitZero);

    const exitSignal = buildExitFrame("t1", null);
    expect(exitSignal.exitCode).toBeNull();
    expect(parseTerminalFrame(JSON.parse(JSON.stringify(exitSignal)))).toEqual(exitSignal);
  });

  it("构造器自带校验：非法入参直接抛错", () => {
    expect(() => buildOutputFrame("", 1, "aGk=")).toThrow();
    expect(() => buildOutputFrame("t1", 0, "aGk=")).toThrow();
    expect(() => buildOutputFrame("t1", 1.5, "aGk=")).toThrow();
    expect(() => buildInputFrame("t1", "不是base64!!")).toThrow();
    expect(() => buildResizeFrame("t1", 0, 24)).toThrow();
    expect(() => buildResizeFrame("t1", 80, -1)).toThrow();
    expect(() => buildExitFrame("t1", "0" as unknown as number)).toThrow();
  });

  it("parseTerminalFrame 拒绝非法帧", () => {
    const badFrames: unknown[] = [
      null,
      "not-a-frame",
      { type: "mystery", terminalId: "t1" },
      { type: "output", terminalId: "", mode: "byte-replay", version: 1, seq: 1, data: "aGk=" },
      { type: "output", terminalId: "t1", mode: "byte-replay", version: 2, seq: 1, data: "aGk=" },
      { type: "output", terminalId: "t1", mode: "byte-replay", version: 1, seq: 0, data: "aGk=" },
      { type: "output", terminalId: "t1", mode: "byte-replay", version: 1, seq: 1, data: "!!!" },
      { type: "resize", terminalId: "t1", mode: "byte-replay", version: 1, cols: 0, rows: 24 },
      { type: "exit", terminalId: "t1", mode: "byte-replay", version: 1 },
    ];
    for (const bad of badFrames) {
      expect(() => parseTerminalFrame(bad)).toThrow(/终端帧解析失败/);
    }
  });
});
