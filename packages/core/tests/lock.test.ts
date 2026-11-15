import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withProjectLock } from "../src/index.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("按路径全局锁（同项目串行 / 跨项目并行）", () => {
  it("同 projectRoot 的操作严格按提交顺序串行", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aether-lock-"));
    const order: string[] = [];
    const first = withProjectLock(dir, async () => {
      order.push("a-start");
      await delay(30);
      order.push("a-end");
    });
    const second = withProjectLock(dir, async () => {
      order.push("b-start");
      await delay(1);
      order.push("b-end");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("跨 projectRoot 并行：一个项目的长操作不阻塞另一个项目", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "aether-lock-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "aether-lock-b-"));
    let releaseA: (() => void) | undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    if (releaseA === undefined) {
      throw new Error("不可达：Promise executor 同步执行");
    }
    const pendingA = withProjectLock(dirA, () => gateA);
    await delay(20);
    // A 仍持锁时，B 必须能立刻完成（并行证明）
    const resultB = await withProjectLock(dirB, async () => "b-done");
    expect(resultB).toBe("b-done");
    releaseA();
    await expect(pendingA).resolves.toBeUndefined();
  });

  it("前序失败不阻塞后续（锁队列续行）且失败原样向调用方传播", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aether-lock-fail-"));
    const failure = withProjectLock(dir, async () => {
      throw new Error("boom");
    });
    const follower = withProjectLock(dir, async () => "survived");
    await expect(failure).rejects.toThrow("boom");
    await expect(follower).resolves.toBe("survived");
  });
});
