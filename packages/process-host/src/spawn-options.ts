// spawn 选项默认值定案（单一来源）：
// - windowsHide 默认 true（隐藏子进程控制台窗口——Windows 风险清单，调研 06 §9.1；
//   node 原生默认 false，必须显式翻转）
// - stdio 默认 "pipe"（stdin/stdout/stderr 全管道，adapters 需要双向流）
// - detached 默认 false（POSIX 进程组模式按需开启）
import type { StdioOptions } from "node:child_process";
import type { SpawnTrackedOptions } from "./types.js";

export interface ResolvedSpawnOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdio: StdioOptions;
  readonly detached: boolean;
  readonly windowsHide: boolean;
  readonly windowsVerbatimArguments?: boolean;
}

export function resolveSpawnOptions(options: SpawnTrackedOptions = {}): ResolvedSpawnOptions {
  const stdio = options.stdio ?? "pipe";
  const detached = options.detached ?? false;
  const windowsHide = options.windowsHide ?? true;
  // exactOptionalPropertyTypes：undefined 的可选键整键省略，不写入显式 undefined
  return {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.windowsVerbatimArguments !== undefined
      ? { windowsVerbatimArguments: options.windowsVerbatimArguments }
      : {}),
    stdio,
    detached,
    windowsHide,
  };
}
