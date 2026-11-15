// ConPTY 预热（调研 06 §9.1：Windows 首次 PTY 创建有秒级冷启动）。
// daemon 启动时后台调 warmupConpty（接线在 P0-10）；本卡验证 API 语义：
// 完成后置位、二次调用立即返回、非 Windows 为空操作同样置位。
import { describe, expect, it } from "vitest";
import { isConptyWarmed, warmupConpty } from "../src/index.js";

describe("conpty-warmup：ConPTY 预热", () => {
  it("warmupConpty 完成并置位，重复调用立即返回", async () => {
    await warmupConpty();
    expect(isConptyWarmed()).toBe(true);
    // 幂等：已预热后再次调用应立即完成（不再创建哑 PTY）
    const startedAt = Date.now();
    await warmupConpty();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(isConptyWarmed()).toBe(true);
  }, 30_000);
});
