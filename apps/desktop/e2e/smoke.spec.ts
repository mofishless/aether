import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";

// P0-01 Electron 启动冒烟：空应用可启动、创建窗口、渲染入口页。
// 需先 pnpm build（out/main/index.js 由 electron-vite 产出），CI 中已按序执行。
const appDir = path.resolve(__dirname, "..");

test("空 Electron 应用可启动并创建窗口", async () => {
  const app: ElectronApplication = await _electron.launch({ args: [appDir] });
  const window: Page = await app.firstWindow();

  await expect(window).toHaveTitle("Aether");
  await expect(window.locator("#app")).toContainText("Aether");

  await app.close();
});
