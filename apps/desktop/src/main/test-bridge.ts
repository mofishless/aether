// 测试桥门禁（P0-03 spec-review #6）：aetherTest 桥仅测试环境注册，生产默认通道不存在。
// 纯模块（零依赖、禁 import electron）：主进程与 preload 共用同一份判定与通道名，
// 纯函数可被 vitest 直测（导入 electron 的 preload/主进程本体无法在 node 下单测）。
export const TEST_BRIDGE_ENV_KEY = "AETHER_TEST_BRIDGE";

/** IPC 通道名（主进程 ipcMain.handle 与 preload invoke 必须一致） */
export const TEST_BRIDGE_DAEMON_STATUS_CHANNEL = "aether:test:daemon-status";

/** 仅 AETHER_TEST_BRIDGE=1 时启用；env 可注入以便纯函数单测（fail-closed：其余取值一律关闭） */
export function isTestBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TEST_BRIDGE_ENV_KEY] === "1";
}
