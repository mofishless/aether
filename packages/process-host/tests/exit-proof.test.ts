// ExitProof（PID 级退出证明）行为：
// 正常退出 / 流管道默认 / 不可变记录 / spawn 失败（从未创建进程）时 exited reject。
import { describe, expect, it } from "vitest";
import { spawnTracked } from "../src/index.js";
import { collectText } from "./helpers/process.js";

describe("ExitProof：正常退出", () => {
  it("短命进程：code 正确、signal null、killedByUs=false、pid 一致、exitedAt 为 ISO 时间", async () => {
    const startedAt = new Date();
    const handle = spawnTracked(process.execPath, ["-e", "process.exit(7)"]);
    const proof = await handle.exited;
    expect(handle.pid).not.toBeNull();
    expect(proof.pid).toBe(handle.pid);
    expect(proof.code).toBe(7);
    expect(proof.signal).toBeNull();
    expect(proof.killedByUs).toBe(false);
    const exitedAt = new Date(proof.exitedAt);
    expect(Number.isNaN(exitedAt.getTime())).toBe(false);
    expect(exitedAt.getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
  }, 20_000);

  it("证明为不可变记录（Object.freeze）", async () => {
    const handle = spawnTracked(process.execPath, ["-e", "process.exit(0)"]);
    const proof = await handle.exited;
    expect(Object.isFrozen(proof)).toBe(true);
  }, 20_000);

  it("stdio 默认 pipe：stdout/stderr 可读且内容正确", async () => {
    const handle = spawnTracked(process.execPath, [
      "-e",
      'console.log("aether-stdout"); console.error("aether-stderr");',
    ]);
    const stdoutPromise = collectText(handle.stdout ?? fail("stdout 应默认可读"));
    const stderrPromise = collectText(handle.stderr ?? fail("stderr 应默认可读"));
    const proof = await handle.exited;
    expect(proof.code).toBe(0);
    expect(await stdoutPromise).toContain("aether-stdout");
    expect(await stderrPromise).toContain("aether-stderr");
  }, 20_000);
});

describe("ExitProof：spawn 失败（进程从未创建）", () => {
  it("不存在的主命令：exited reject、handle.pid=null", async () => {
    const handle = spawnTracked("aether-definitely-missing-bin-xyz", ["--flag"]);
    expect(handle.pid).toBeNull();
    await expect(handle.exited).rejects.toBeInstanceOf(Error);
  }, 20_000);
});

// 断言辅助：供 null 收窄后的失败分支（vitest 未导出 fail，本地实现）
function fail(message: string): never {
  throw new Error(message);
}
