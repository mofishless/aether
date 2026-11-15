// 生产 IPC 通道（P0-10）：主进程 → preload → 渲染 的 daemon endpoint 查询。
// 纯常量模块（零依赖、禁 import electron）：主进程与 preload 共用同一通道名，
// 纯函数模块可被 vitest 直测。渲染端每次（重）连前重新查询——supervisor 重启后
// port/token 均换新，渲染端不得缓存。
export const DAEMON_ENDPOINT_CHANNEL = "aether:daemon-endpoint";

/** daemon 连接端点（经 contextBridge 结构化克隆传递） */
export interface DaemonEndpointInfo {
  readonly port: number;
  readonly token: string;
}
