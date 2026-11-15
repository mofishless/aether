import { describe, expect, it } from "vitest";
import { isTestBridgeEnabled } from "../src/main/test-bridge.js";

// P0-03 spec-review #6：测试桥门禁纯函数——生产默认（未设 env）绝不注册 aetherTest，
// 仅 AETHER_TEST_BRIDGE=1 精确启用（fail-closed：其余取值一律关闭）。
describe("测试桥门禁 isTestBridgeEnabled", () => {
  it("AETHER_TEST_BRIDGE=1 → 启用", () => {
    expect(isTestBridgeEnabled({ AETHER_TEST_BRIDGE: "1" })).toBe(true);
  });

  it("未设置 → 不启用（生产默认）", () => {
    expect(isTestBridgeEnabled({})).toBe(false);
  });

  it('非 "1" 取值（0/true/yes）→ 不启用（fail-closed）', () => {
    expect(isTestBridgeEnabled({ AETHER_TEST_BRIDGE: "0" })).toBe(false);
    expect(isTestBridgeEnabled({ AETHER_TEST_BRIDGE: "true" })).toBe(false);
    expect(isTestBridgeEnabled({ AETHER_TEST_BRIDGE: "yes" })).toBe(false);
  });
});
