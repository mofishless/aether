import { describe, expect, it } from "vitest";

// P0-01 恒真用例：验证测试基线链路（vitest + TS 转译 + 根配置发现）本身可用。
describe("工程基线", () => {
  it("vitest 链路可用（恒真）", () => {
    expect(1 + 1).toBe(2);
  });
});
