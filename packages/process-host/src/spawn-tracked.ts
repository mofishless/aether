// spawnTracked：node:child_process.spawn 的治理包装（本包核心原语，adapters 复用）。
// - windowsHide 默认 true / stdio 默认 pipe（spawn-options.ts 单一来源）
// - POSIX detached 模式：子进程即进程组长（pgid=pid），供 killTree 整组树杀
// - PID 级退出证明：正常退出与被杀都 resolve ExitProof；spawn 失败（进程从未创建）reject
// 参考：apps/desktop/src/main/daemon/spawn.ts（P0-03 单进程 spawn 的 exit/error 双收敛与无害 no-op kill 语义）。
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { StdioOptions } from "node:child_process";
import { buildExitProof } from "./exit-proof.js";
import { markKilledByUs, wasKilledByUs } from "./kill-marker.js";
import { resolveSpawnOptions } from "./spawn-options.js";
import type { ExitProof, ProcessHandle, SpawnTrackedOptions } from "./types.js";

/** node 子进程的最小结构形状（依赖注入缝；ChildProcess 结构性满足） */
export interface MinimalChild {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): MinimalChild;
  on(event: "error", listener: (error: Error) => void): MinimalChild;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** 底层 spawn 入参（resolveSpawnOptions 的产出形状） */
export interface RawSpawnOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdio: StdioOptions;
  readonly detached: boolean;
  readonly windowsHide: boolean;
  readonly windowsVerbatimArguments?: boolean;
}

export type RawSpawnFn = (
  command: string,
  args: readonly string[],
  options: RawSpawnOptions,
) => MinimalChild;

const nodeSpawn: RawSpawnFn = (command, args, options) => spawn(command, args, options);

let rawSpawn: RawSpawnFn = nodeSpawn;

/** 测试缝：注入替代 spawn 实现（捕获选项做透传断言）；传 undefined 还原 */
export function setSpawnForTests(impl: RawSpawnFn | undefined): void {
  rawSpawn = impl ?? nodeSpawn;
}

/**
 * spawn 并返回治理句柄。同步返回（同 node spawn）；退出证明经 handle.exited 异步取得。
 * 注意：Windows 上 .cmd/.bat 不能直接 spawn（CVE-2024-27980 后 node 直接拒绝）——
 * 业务侧请用 spawnCommand（会做 cmd.exe 包装与参数转义）。
 */
export function spawnTracked(
  command: string,
  args: readonly string[] = [],
  options: SpawnTrackedOptions = {},
): ProcessHandle {
  const resolved = resolveSpawnOptions(options);
  const child = rawSpawn(command, args, resolved);
  const pid = child.pid ?? null;
  const pgid = resolved.detached && pid !== null && process.platform !== "win32" ? pid : null;

  const handle: ProcessHandle = Object.freeze({
    pid,
    pgid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited: new Promise<ExitProof>((resolve, reject) => {
      let settled = false;
      child.on("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        resolve(
          buildExitProof({
            pid: pid ?? -1,
            code,
            signal,
            killedByUs: wasKilledByUs(handle),
          }),
        );
      });
      // spawn 失败（ENOENT 等）：进程从未创建，无证明可产——exited reject
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    }),
    kill: (): void => {
      if (pid === null) return; // 从未创建
      if (child.exitCode !== null || child.signalCode !== null) return; // 已退出：无害 no-op
      markKilledByUs(handle);
      try {
        child.kill("SIGKILL"); // Windows: node 24 模拟信号（exit(null,'SIGKILL')，实验验证）；POSIX: 真信号
      } catch {
        // 竞态：exit 事件未及到达但进程已死
      }
    },
  });

  // 防 unhandled rejection：调用方不 await exited 时进程不崩；await 方仍拿到原始 reject
  void handle.exited.catch(() => undefined);
  return handle;
}
