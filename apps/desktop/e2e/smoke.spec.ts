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

test("空 Electron 应用可启动并创建窗口", async () => {
  const app: ElectronApplication = await _electron.launch(launchOptions);
  const window: Page = await app.firstWindow();

  await expect(window).toHaveTitle("Aether");
  await expect(window.locator("#app")).toContainText("Aether");

  await app.close();
});
