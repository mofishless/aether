// 主动 kill 单进程：ExitProof.killedByUs=true + 平台差异字段（win32 TerminateProcess→code 1/signal null；POSIX SIGKILL→signal/code null）。
// kill() 幂等与已退出 no-op（对齐 apps/desktop spawn.ts 的无害 no-op 语义）。
import { afterAll, describe, expect, it } from "vitest";
import { spawnTracked } from "../src/index.js";
import { isPidAlive } from "./helpers/process.js";

const IS_WIN = process.platform === "win32";
const KEEP_ALIVE = "setInterval(() => {}, 1000);";

// 兜底清理：防孤儿（纪律要求）
const leftoverPids = new Set<number>();

afterAll(async () => {
  for (const pid of leftoverPids) {
    if (!isPidAlive(pid)) continue;
    try {
      if (IS_WIN) {
        const { spawn } = await import("node:child_process");
        await new Promise<void>((resolve) => {
          const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
          killer.on("close", () => resolve());
          killer.on("error", () => resolve());
        });
      } else {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // 已消失
          }
        }
      }
    } catch {
      // 兜底绝不抛
    }
  }
}, 20_000);

describe("handle.kill()：单进程主动杀", () => {
  it("长驻进程 kill 后：killedByUs=true 且平台字段正确，PID 消失", async () => {
    const handle = spawnTracked(process.execPath, ["-e", KEEP_ALIVE]);
    const pid = handle.pid;
    expect(pid).not.toBeNull();
    if (pid !== null) leftoverPids.add(pid);
    handle.kill();
    const proof = await handle.exited;
    expect(proof.pid).toBe(pid);
    expect(proof.killedByUs).toBe(true);
    // handle.kill → SIGKILL：POSIX 真信号；Windows node 24 模拟信号（exit(null, 'SIGKILL')，实验验证）
    expect(proof.code).toBeNull();
    expect(proof.signal).toBe("SIGKILL");
    if (pid !== null) {
      expect(isPidAlive(pid)).toBe(false);
    }
    leftoverPids.delete(pid ?? -1);
  }, 20_000);

  it("kill() 幂等：重复调用与退出后调用均 no-op 不抛", async () => {
    const handle = spawnTracked(process.execPath, ["-e", "process.exit(3)"]);
    const proof = await handle.exited;
    expect(proof.code).toBe(3);
    expect(() => {
      handle.kill();
      handle.kill();
    }).not.toThrow();
  }, 20_000);

  it("自然退出后 ExitProof.killedByUs=false（外部退出与被杀区分）", async () => {
    const handle = spawnTracked(process.execPath, ["-e", "process.exit(0)"]);
    const proof = await handle.exited;
    expect(proof.killedByUs).toBe(false);
  }, 20_000);
});
