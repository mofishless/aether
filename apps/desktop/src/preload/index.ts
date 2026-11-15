import { contextBridge, ipcRenderer } from "electron";
import { DAEMON_ENDPOINT_CHANNEL, type DaemonEndpointInfo } from "../main/renderer-bridge.js";
import { isTestBridgeEnabled, TEST_BRIDGE_DAEMON_STATUS_CHANNEL } from "../main/test-bridge.js";

// 渲染进程通往主进程的唯一入口（P0-10）：daemon endpoint 查询 + 壳层信息。
// 渲染层拿 daemon 数据一律直连 WS（contracts 契约），不经主进程转发。
const bridge = {
  platform: process.platform,
  electronVersion: process.versions.electron,
  /** 当前 daemon endpoint（非 ready 期 null）；渲染层每次（重）连前重新查询，不缓存 */
  getDaemonEndpoint: (): Promise<DaemonEndpointInfo | null> =>
    ipcRenderer.invoke(DAEMON_ENDPOINT_CHANNEL) as Promise<DaemonEndpointInfo | null>,
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
