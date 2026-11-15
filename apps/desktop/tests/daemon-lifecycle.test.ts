// P0-03 阶段 2 集成测试：桌面主进程 daemon 启动器/监护全链路（TASK_LIST P0-03 验收）。
// 覆盖：spawn→握手→health；SIGKILL 3 秒内自动重启；--hang-signal 心跳超时判死恢复；
// --hang-silent 启动超时判死恢复；stop() 优雅退出 exit 0。
//
// daemon 入口构建说明：不直接用 apps/daemon/dist/（daemon 自己的测试在并行 fork 中也会
// 重建该目录，tsup --clean 存在写读竞态），而是把同一入口构建到本包 .tmp/daemon-dist/
// 隔离副本，spawn 协议与产物字节完全一致。
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDaemonSupervisor,
  type DaemonSupervisor,
  type DaemonSupervisorStatus,
} from "../src/main/daemon/supervisor.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(thisDir, "..");
const repoRoot = join(desktopDir, "..", "..");
const daemonDistDir = join(desktopDir, ".tmp", "daemon-dist");
const daemonEntryPath = join(daemonDistDir, "index.js");

function buildDaemonInto(distDir: string): void {
  // 相对路径（cwd=repoRoot，pnpm --filter 把 cwd 切到 apps/daemon）避免绝对路径引号问题；
  // Windows 下 pnpm 为 .cmd，需 shell: true（参数均为固定字面量，无注入面）
  const relativeOut = relative(join(repoRoot, "apps", "daemon"), distDir).replace(/\\/g, "/");
  const command = `pnpm --filter @aether/daemon exec tsup src/index.ts --format esm --target node24 --clean --out-dir ${relativeOut}`;
  const result = spawnSync(command, {
    cwd: repoRoot,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message ?? `exit ${result.status}；stderr：${result.stderr ?? ""}`;
    throw new Error(`daemon dist 构建失败（${distDir}）：${detail}`);
  }
  if (!existsSync(join(distDir, "index.js"))) {
    throw new Error(`daemon dist 构建后未找到 index.js（${distDir}）`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询 supervisor 状态直到谓词满足；超时抛错并附最后状态快照 */
async function waitForStatus(
  supervisor: DaemonSupervisor,
  predicate: (status: DaemonSupervisorStatus) => boolean,
  timeoutMs: number,
): Promise<DaemonSupervisorStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = supervisor.getStatus();
    if (predicate(status)) return status;
    if (Date.now() > deadline) {
      throw new Error(
        `waitForStatus 超时 ${timeoutMs}ms；最后状态：${JSON.stringify(supervisor.getStatus())}`,
      );
    }
    await sleep(50);
  }
}

// afterAll 兜底：所有 supervisor 停止，防孤儿 daemon 进程
const supervisors: DaemonSupervisor[] = [];

function track(supervisor: DaemonSupervisor): DaemonSupervisor {
  supervisors.push(supervisor);
  return supervisor;
}

beforeAll(() => {
  rmSync(daemonDistDir, { recursive: true, force: true });
  buildDaemonInto(daemonDistDir);
}, 180_000);

afterAll(async () => {
  await Promise.allSettled(supervisors.map((supervisor) => supervisor.stop()));
  rmSync(daemonDistDir, { recursive: true, force: true });
}, 30_000);

describe("daemon 生命周期监护（launcher 全链路）", () => {
  it("spawn → 握手 → system.health 返回 ok 且状态含 pid/port", async () => {
    const supervisor = track(createDaemonSupervisor({ daemonEntryPath }));

    const status = await supervisor.start();

    expect(status.state).toBe("ready");
    expect(status.pid).not.toBeNull();
    expect(status.pid as number).toBeGreaterThan(0);
    expect(status.port).not.toBeNull();
    expect(status.port as number).toBeGreaterThan(0);
    expect(status.restartCount).toBe(0);

    const health = await supervisor.health();
    expect(health.ok).toBe(true);
  }, 20_000);

  it("SIGKILL daemon → 自动重启，从 kill 到 ready <3000ms（Windows 映射 TerminateProcess）", async () => {
    const supervisor = track(createDaemonSupervisor({ daemonEntryPath }));
    const first = await supervisor.start();
    const firstPid = first.pid as number;

    const killedAt = Date.now();
    process.kill(firstPid, "SIGKILL");

    const recovered = await waitForStatus(
      supervisor,
      (status) => status.state === "ready" && status.pid !== null && status.pid !== firstPid,
      10_000,
    );

    expect(Date.now() - killedAt).toBeLessThan(3000);
    expect(recovered.restartCount).toBe(1);
    // 判死信号：强杀后 socket close 与进程 exit 谁先到不定，两者都算正确检出
    expect(recovered.lastError).toMatch(/退出|连接关闭/);

    const health = await supervisor.health();
    expect(health.ok).toBe(true);
  }, 20_000);

  it("--hang-signal：握手后挂死 → 心跳超时判死 → 自动重启恢复（核心时延显式预算）", async () => {
    const heartbeatIntervalMs = 300;
    const heartbeatTimeoutMs = 600;
    const supervisor = track(
      createDaemonSupervisor({
        daemonEntryPath,
        heartbeatIntervalMs,
        heartbeatTimeoutMs,
        resolveDaemonArgs: (attempt) => (attempt === 0 ? ["--hang-signal"] : []),
      }),
    );
    const startedAt = Date.now();
    const first = await supervisor.start();
    const firstPid = first.pid as number;

    const recovered = await waitForStatus(
      supervisor,
      (status) => status.state === "ready" && status.pid !== null && status.pid !== firstPid,
      10_000,
    );

    // spec-review #4：从 start 到恢复 ready 的端到端时延显式上界（心跳 interval+timeout+3000 余量）。
    // 回归（如误删首发 ping 拉长判死窗口）会击穿此预算，被本用例抓住。
    expect(Date.now() - startedAt).toBeLessThan(heartbeatIntervalMs + heartbeatTimeoutMs + 3000);
    expect(recovered.restartCount).toBe(1);
    expect(recovered.lastError).toContain("心跳");

    const health = await supervisor.health();
    expect(health.ok).toBe(true);
  }, 20_000);

  it("--hang-silent：不出 listening 行 → 启动超时判死 → 自动重启恢复", async () => {
    const supervisor = track(
      createDaemonSupervisor({
        daemonEntryPath,
        listeningTimeoutMs: 1500,
        resolveDaemonArgs: (attempt) => (attempt === 0 ? ["--hang-silent"] : []),
      }),
    );

    const status = await supervisor.start();

    expect(status.state).toBe("ready");
    expect(status.restartCount).toBe(1);
    expect(status.lastError).toContain("listening");

    const health = await supervisor.health();
    expect(health.ok).toBe(true);
  }, 20_000);

  it("stop()：system.shutdown 优雅退出，exit code 0", async () => {
    const supervisor = track(createDaemonSupervisor({ daemonEntryPath }));
    await supervisor.start();

    await supervisor.stop();

    const status = supervisor.getStatus();
    expect(status.state).toBe("stopped");
    expect(status.pid).toBeNull();
    expect(status.lastExit).not.toBeNull();
    expect((status.lastExit as { code: number | null }).code).toBe(0);
  }, 20_000);

  it("重启风暴退避：daemon 持续秒崩时重启速率受控（spec-review #2）", async () => {
    const supervisor = track(
      createDaemonSupervisor({
        daemonEntryPath,
        // 未知 flag → daemon 入口 fail-closed 秒退（exit 1，无 listening 行）→ spawn 判失败
        resolveDaemonArgs: () => ["--exit-instantly"],
      }),
    );
    const startPromise = supervisor.start(); // 永不 ready：保持 pending，仅观测风暴

    await sleep(2000);
    const status = supervisor.getStatus();
    expect(status.state).toBe("reconnecting");
    expect(status.restartCount).toBeGreaterThanOrEqual(2); // 守卫真实在跑（非零星偶发）
    // 退避时间表推导的硬上界：第 k 次失败最早发生于 0+0+100+250+500×(k−4) ms（k≥4），
    // 2000ms 窗口内至多 7 次；无退避时秒崩循环 2 秒可打点十余次。
    expect(status.restartCount).toBeLessThanOrEqual(7);
    expect(status.consecutiveFailures).toBe(status.restartCount); // 从未 ready：两者同步递增

    await supervisor.stop();
    await startPromise; // stop 后 launch 循环收敛返回快照（不 reject）
  }, 20_000);

  it("退避后收敛：前 3 次秒崩 → 恢复正常 daemon 后收敛 ready 且 consecutiveFailures 归零", async () => {
    const observedConsecutiveFailures: number[] = [];
    const supervisor = track(
      createDaemonSupervisor({
        daemonEntryPath,
        resolveDaemonArgs: (attempt) => (attempt < 3 ? ["--exit-instantly"] : []),
        onStateChange: (status) => {
          observedConsecutiveFailures.push(status.consecutiveFailures);
        },
      }),
    );

    const status = await supervisor.start();

    expect(status.state).toBe("ready");
    expect(status.restartCount).toBe(3);
    expect(status.consecutiveFailures).toBe(0);
    // 3 次连续失败逐次计数（1→2→3），ready 时归零：快照字段真实反映退避状态
    expect(Math.max(...observedConsecutiveFailures)).toBe(3);

    const health = await supervisor.health();
    expect(health.ok).toBe(true);
  }, 20_000);

  it("stop() 宽限预算：--hang-signal 挂死下总耗时 < 2×宽限+1500ms（spec-review #3）", async () => {
    const shutdownGraceMs = 800;
    const supervisor = track(
      createDaemonSupervisor({
        daemonEntryPath,
        resolveDaemonArgs: () => ["--hang-signal"], // 每次尝试都挂死：ready 后冻结事件循环
        heartbeatIntervalMs: 60_000, // 压住心跳判死：本用例锁定 stop 预算，不测恢复
        shutdownGraceMs,
      }),
    );
    await supervisor.start(); // 握手完成即 ready，此后 daemon 冻结（RPC 无响应、不自行退出）

    const stoppedAt = Date.now();
    await supervisor.stop();
    const elapsed = Date.now() - stoppedAt;

    expect(supervisor.getStatus().state).toBe("stopped");
    // RPC 宽限确实耗满（挂死 daemon 不回帧），证明走的是竞速路径而非快速失败
    expect(elapsed).toBeGreaterThanOrEqual(shutdownGraceMs);
    // 总预算上界：RPC 竞速 800ms + exit 宽限 800ms + SIGKILL 收尾余量
    //（修复前 ≈ 5s RPC 超时 + 2×2s 宽限 ≈ 9s，阻塞 before-quit）
    expect(elapsed).toBeLessThan(shutdownGraceMs * 2 + 1500);
  }, 20_000);
});
