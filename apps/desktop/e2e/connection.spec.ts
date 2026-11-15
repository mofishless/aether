import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";

// P0-10 渲染骨架冒烟（任务卡 TDD 顺序第一项）：渲染层经类型化通道（preload 注入 endpoint）
// 直连 daemon WS → 已连接可见 → kill daemon → 断线可见 → supervisor 重启后自动恢复已连接。
// 需先 pnpm build（daemon dist + desktop out），CI 已按序执行。
const appDir = path.resolve(__dirname, "..");
type ElectronLaunchOptions = Parameters<typeof _electron.launch>[0];

// kill daemon 需要 supervisor 状态桥（pid），故启用测试桥；Linux CI 沿用 smoke 的 sandbox 处置。
const launchOptions: ElectronLaunchOptions = {
  args: [appDir],
  env: { ...process.env, AETHER_TEST_BRIDGE: "1" },
  ...(process.env.CI && process.platform === "linux" ? { chromiumSandbox: false } : {}),
};

/** 主进程 daemon supervisor 的状态快照形状（经 aetherTest 测试桥） */
interface DaemonStatusBridge {
  state: string;
  pid: number | null;
  port: number | null;
  restartCount: number;
  lastError: string | null;
}

async function getDaemonStatus(window: Page): Promise<DaemonStatusBridge> {
  return window.evaluate(() => {
    const bridge = (
      window as unknown as {
        aetherTest: { getDaemonStatus(): Promise<DaemonStatusBridge> };
      }
    ).aetherTest;
    return bridge.getDaemonStatus();
  });
}

async function pollDaemonStatus(
  window: Page,
  predicate: (status: DaemonStatusBridge) => boolean,
  timeoutMs: number,
): Promise<DaemonStatusBridge> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await getDaemonStatus(window);
    if (predicate(status)) return status;
    if (Date.now() > deadline) {
      throw new Error(`pollDaemonStatus 超时 ${timeoutMs}ms；最后状态：${JSON.stringify(status)}`);
    }
    await window.waitForTimeout(100);
  }
}

test("渲染层连接 daemon 并在 daemon 崩溃后自动恢复", async () => {
  // CI 慢机预算：daemon spawn + 重启恢复全链路（配置默认 60s 不够宽裕）
  test.setTimeout(120_000);
  const app: ElectronApplication = await _electron.launch(launchOptions);
  const window: Page = await app.firstWindow();
  let recoveredPid: number | null = null;

  try {
    const badge = window.locator('[data-testid="connection-badge"]');
    // ① 启动 → 连接 daemon → 已连接（CI 慢机预算给足：daemon spawn + 握手 + 渲染重试）
    await expect(badge).toHaveText("已连接", { timeout: 30_000 });
    // 版本徽标证明 system.version 类型化 RPC 往返成功
    await expect(window.locator('[data-testid="daemon-version"]')).toHaveText(
      /daemon v\d+\.\d+\.\d+/,
    );

    // ② kill daemon（真进程，非 mock）→ 断线状态必经（WS close → disconnected 进入迁移历史）
    const first = await pollDaemonStatus(
      window,
      (status) => status.state === "ready" && status.pid !== null,
      15_000,
    );
    const firstPid = first.pid as number;
    process.kill(firstPid, "SIGKILL");

    await expect(window.locator('[data-testid="state-history"]')).toContainText("已断开", {
      timeout: 20_000,
    });

    // ③ supervisor 自动重启（<3s 验收）→ 渲染端退避重连（≤500ms 节奏）→ 再次已连接
    await expect(badge).toHaveText("已连接", { timeout: 30_000 });
    const recovered = await pollDaemonStatus(
      window,
      (status) => status.state === "ready" && status.pid !== null && status.pid !== firstPid,
      15_000,
    );
    recoveredPid = recovered.pid;
    expect(recovered.restartCount).toBeGreaterThanOrEqual(1);
  } finally {
    await app.close().catch(() => undefined);
    // 兜底防孤儿：before-quit 优雅停失败时强杀恢复后的 daemon
    if (recoveredPid !== null) {
      try {
        process.kill(recoveredPid, "SIGKILL");
      } catch {
        // 已随 app 退出：预期路径
      }
    }
  }
});
