// @aether/process-host —— 子进程宿主与治理（SYSTEM_DESIGN §2/§3，P0-06）：
// 统一 tracked spawn / 进程组树杀（POSIX kill(-pgid) · Windows taskkill /T /F）/
// PID 级退出证明 / Windows 隐藏控制台窗口与 .cmd/.bat 安全引号（调研 05.A @orca/process-host
// 思路 + 蓝图 §2/§9.1）。execution_process 表的运行时对应物；adapters 复用本包原语。
// 依赖方向：不依赖任何 workspace 包（contracts 按需、P0 无需）；零原生模块。
export type { ExitProof, KillTreeResult, ProcessHandle, SpawnTrackedOptions } from "./types.js";
export { buildExitProof } from "./exit-proof.js";
export type { ExitProofInput } from "./exit-proof.js";
export { resolveSpawnOptions } from "./spawn-options.js";
export type { ResolvedSpawnOptions } from "./spawn-options.js";
export { spawnTracked } from "./spawn-tracked.js";
export { spawnCommand } from "./spawn-command.js";
export { killTree } from "./kill-tree.js";
export { isCmdScriptPath, quoteWindowsArg, quoteWindowsCommand } from "./windows-quote.js";
