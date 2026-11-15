import { contextBridge, ipcRenderer } from "electron";
import { isTestBridgeEnabled, TEST_BRIDGE_DAEMON_STATUS_CHANNEL } from "../main/test-bridge.js";

// 渲染进程通往主进程的唯一入口（P0-10 起经 contracts 直连 daemon，preload 只保留壳层桥）。
const bridge = {
  platform: process.platform,
  electronVersion: process.versions.electron,
};

contextBridge.exposeInMainWorld("aether", bridge);

// 测试桥（仅测试用途）：E2E 读主进程 daemon supervisor 状态快照。
// 门禁（spec-review #6）：仅 AETHER_TEST_BRIDGE=1 时暴露；生产构建下 aetherTest 不存在，
// 任意渲染内容都拿不到 pid/port/restartCount/lastError。
if (isTestBridgeEnabled()) {
  const testBridge = {
    getDaemonStatus: (): Promise<unknown> => ipcRenderer.invoke(TEST_BRIDGE_DAEMON_STATUS_CHANNEL),
  };

  contextBridge.exposeInMainWorld("aetherTest", testBridge);
}
