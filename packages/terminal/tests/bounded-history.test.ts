// bounded-history：按字节的环形缓冲（§7.2 有界历史），保留 (seq, base64) 帧边界语义。
// 容量注入缝用小常量，验证确定性淘汰行为。
import { describe, expect, it } from "vitest";
import {
  TERMINAL_HISTORY_CAPACITY_BYTES,
  createBoundedHistory,
  type HistoryChunk,
} from "../src/index.js";

function chunk(seq: number, text: string): HistoryChunk {
  return { seq, data: Buffer.from(text, "utf8").toString("base64") };
}

describe("bounded-history：按字节环形淘汰", () => {
  it("默认容量常量为 256KiB", () => {
    expect(TERMINAL_HISTORY_CAPACITY_BYTES).toBe(256 * 1024);
  });

  it("容量内全部保留：帧边界、顺序与字节计数正确", () => {
    const history = createBoundedHistory(1024);
    history.push(chunk(1, "aaaa"));
    history.push(chunk(2, "bbbb"));
    history.push(chunk(3, "cccc"));
    expect(history.historyFrames()).toEqual([chunk(1, "aaaa"), chunk(2, "bbbb"), chunk(3, "cccc")]);
    expect(history.bytes).toBe(12);
    expect(history.truncated).toBe(false);
    expect(history.droppedFrames).toBe(0);
  });

  it("超容量丢最旧并标记截断", () => {
    const history = createBoundedHistory(10);
    history.push(chunk(1, "aaaa")); // 4 字节
    history.push(chunk(2, "bbbb")); // 4 字节，累计 8 ≤ 10
    history.push(chunk(3, "cccc")); // 4 字节，累计 12 > 10 → 丢 seq1
    const frames = history.historyFrames();
    expect(frames.map((f) => f.seq)).toEqual([2, 3]);
    expect(history.bytes).toBe(8);
    expect(history.truncated).toBe(true);
    expect(history.droppedFrames).toBe(1);
  });

  it("持续写入只保留最新的容量内前缀", () => {
    const history = createBoundedHistory(8);
    for (let seq = 1; seq <= 6; seq += 1) {
      history.push(chunk(seq, "abcd")); // 每帧 4 字节 → 容量 8 恰留 2 帧
    }
    expect(history.historyFrames().map((f) => f.seq)).toEqual([5, 6]);
    expect(history.droppedFrames).toBe(4);
  });

  it("单个 chunk 超容量：仅保留该 chunk（丢掉全部更旧帧）", () => {
    const history = createBoundedHistory(8);
    history.push(chunk(1, "ab")); // 2 字节
    history.push(chunk(2, "x".repeat(20))); // 20 字节 > 容量
    const frames = history.historyFrames();
    expect(frames.map((f) => f.seq)).toEqual([2]);
    expect(frames[0]?.data).toBe(chunk(2, "x".repeat(20)).data);
    expect(history.truncated).toBe(true);
  });

  it("historyFrames 返回快照：入参对象与已取得数组不受后续写入影响", () => {
    const history = createBoundedHistory(1024);
    const input = chunk(1, "aaaa");
    history.push(input);
    const snapshot = history.historyFrames();
    history.push(chunk(2, "bbbb"));
    expect(snapshot).toEqual([chunk(1, "aaaa")]);
    input.seq = 999; // 改动调用方对象不影响内部状态
    expect(history.historyFrames()[0]?.seq).toBe(1);
  });

  it("容量必须为正整数", () => {
    expect(() => createBoundedHistory(0)).toThrow(/正整数/);
    expect(() => createBoundedHistory(-1)).toThrow(/正整数/);
    expect(() => createBoundedHistory(1.5)).toThrow(/正整数/);
  });
});
