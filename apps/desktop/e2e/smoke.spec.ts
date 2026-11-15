import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";

// P0-01 Electron 启动冒烟：空应用可启动、创建窗口、渲染入口页。
// 需先 pnpm build（out/main/index.js 由 electron-vite 产出），CI 中已按序执行。
const appDir = path.resolve(__dirname, "..");
type ElectronLaunchOptions = Parameters<typeof _electron.launch>[0];

// GitHub Linux runner + xvfb 环境：用户命名空间受限，Chromium sandbox 会导致启动失败。
// 仅 CI + Linux 关闭 sandbox；本地 Windows/macOS 保持默认 sandbox。
const launchOptions: ElectronLaunchOptions = {
  args: [appDir],
  ...(process.env.CI && process.platform === "linux" ? { chromiumSandbox: false } : {}),
};

// 测试桥门禁（spec-review #6）：仅 AETHER_TEST_BRIDGE=1 时 preload 暴露 aetherTest。
// 需要桥的用例用这份 options；上面的 launchOptions 保持生产默认形态（桥不存在）。
const testBridgeLaunchOptions: ElectronLaunchOptions = {
  ...launchOptions,
  env: { ...process.env, AETHER_TEST_BRIDGE: "1" },
};

test("空 Electron 应用可启动并创建窗口", async () => {
  const app: ElectronApplication = await _electron.launch(launchOptions);
  const window: Page = await app.firstWindow();

  await expect(window).toHaveTitle("Aether");
  // P0-10 起 #app 由 React 骨架挂载：连接徽标可见即渲染管线活着（数据通道细节由 connection.spec 验证）
  await expect(window.locator("#app")).toBeVisible();
  await expect(window.locator('[data-testid="connection-badge"]')).toBeVisible();
  // 生产默认（未设 AETHER_TEST_BRIDGE）：测试桥不注册，渲染进程摸不到 aetherTest
  const testBridgeExposed = await window.evaluate(() => "aetherTest" in window);
  expect(testBridgeExposed).toBe(false);

  await app.close();
});

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

test("daemon 状态桥可查且崩溃自动重启（P0-03 验收：3 秒内恢复）", async () => {
  const app: ElectronApplication = await _electron.launch(testBridgeLaunchOptions);
  const window: Page = await app.firstWindow();

  try {
    const first = await pollDaemonStatus(window, (status) => status.state === "ready", 15_000);
    expect(typeof first.pid).toBe("number");
    expect(first.pid as number).toBeGreaterThan(0);
    const firstPid = first.pid as number;

    const killedAt = Date.now();
    process.kill(firstPid, "SIGKILL"); // Playwright 跑在 node：Windows 映射 TerminateProcess

    const recovered = await pollDaemonStatus(
      window,
      (status) => status.state === "ready" && status.pid !== null && status.pid !== firstPid,
      10_000,
    );
    expect(Date.now() - killedAt).toBeLessThan(3000);
    expect(recovered.restartCount).toBeGreaterThanOrEqual(1);

    await app.close();
    // 兜底防孤儿：before-quit 优雅停失败时强杀恢复后的 daemon
    if (recovered.pid !== null) {
      try {
        process.kill(recovered.pid, "SIGKILL");
      } catch {
        // 已随 app 退出：预期路径
      }
    }
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
});
