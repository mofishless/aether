import { describe, expect, it } from "vitest";
import { reconnectDelayMs } from "../../src/renderer/src/rpc/backoff.js";

// 重连退避时序（任务卡 P0-10：指数退避 100→500ms 封顶，supervisor 先例）
describe("reconnectDelayMs", () => {
  it("默认参数：100→200→400，第 4 次起封顶 500", () => {
    expect(reconnectDelayMs(1)).toBe(100);
    expect(reconnectDelayMs(2)).toBe(200);
    expect(reconnectDelayMs(3)).toBe(400);
    expect(reconnectDelayMs(4)).toBe(500);
    expect(reconnectDelayMs(8)).toBe(500);
    expect(reconnectDelayMs(100)).toBe(500);
  });

  it("基数与封顶可注入（时序单测可加速）", () => {
    expect(reconnectDelayMs(1, 50, 300)).toBe(50);
    expect(reconnectDelayMs(2, 50, 300)).toBe(100);
    expect(reconnectDelayMs(9, 10, 40)).toBe(40);
  });

  it("非正失败次数按首次失败处理（防御：不产生 0 或 NaN 延迟）", () => {
    expect(reconnectDelayMs(0)).toBe(100);
    expect(reconnectDelayMs(-3, 10, 100)).toBe(10);
  });
});
