// @aether/process-host 公共类型（SYSTEM_DESIGN §2/§3：子进程宿主与治理，
// execution_process 的运行时对应物；adapters/claude、codex、custom 复用本包原语）。
import type { Readable, Writable } from "node:stream";
import type { StdioOptions } from "node:child_process";

/**
 * PID 级退出证明（调研 05.A：spawn 即"拥有子进程"）。
 * 正常退出与被杀都产出；调用方 `await handle.exited` 取得。
 * 不可变记录：字段一经产出不再变化（Object.freeze）。
 */
export interface ExitProof {
  /** 退出的进程 PID（与 handle.pid 一致） */
  readonly pid: number;
  /** 退出码；被信号杀死时为 null */
  readonly code: number | null;
  /**
   * 致死信号名（如 "SIGKILL"）；正常退出为 null。
   * 平台 × 路径矩阵（实测核定，Windows 11 / node 24）：
   * - POSIX kill()/killTree() → signal "SIGKILL"、code null
   * - Windows kill()（node 模拟信号）→ signal "SIGKILL"、code null
   * - Windows killTree()（taskkill / TerminateProcess）→ code 1、signal null
   * - 外部原因死亡 → code 有值、signal null（Windows 下 signal 恒 null）
   */
  readonly signal: string | null;
  /**
   * 是否由本宿主主动杀掉（kill()/killTree()），与外部死亡区分。
   * best-effort/advisory：标记先于击杀命令发出——自然退出恰在标记之后、命令成功
   * 之前的极窄窗口内会误标 true。权威判定以 killTree() 返回的 KillTreeResult.alreadyGone
   * 为准（P0-07 适配器落库时两相核对）。
   */
  readonly killedByUs: boolean;
  /** 退出时刻（UTC ISO-8601） */
  readonly exitedAt: string;
}

/** spawnTracked 选项（默认值见 resolveSpawnOptions） */
export interface SpawnTrackedOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** 默认 "pipe"（stdin/stdout/stderr 全管道） */
  readonly stdio?: StdioOptions;
  /**
   * POSIX 进程组模式：子进程成为组长（pgid=pid），后代默认同组，killTree 可整组树杀。
   * Windows 上仅透传 node 的 detached 语义（不影响树杀——树杀走 taskkill /T）。
   */
  readonly detached?: boolean;
  /** 默认 true：隐藏子进程控制台窗口（Windows，调研 06 §9.1） */
  readonly windowsHide?: boolean;
  /**
   * 内部：spawnCommand 包装 cmd.exe /d /s /c 时置 true（自行完成引号转义后需原样传参，
   * 见 windows-quote.ts）。业务调用方不要传。
   */
  readonly windowsVerbatimArguments?: boolean;
}

/** 被治理子进程的句柄 */
export interface ProcessHandle {
  /** 进程 PID；spawn 失败（进程从未创建，exited 将 reject）时为 null */
  readonly pid: number | null;
  /**
   * 进程组 ID：POSIX detached 模式下等于 pid（子进程即组长）；其余（非 detached / Windows）为 null。
   * killTree 优先用它做整组树杀。
   */
  readonly pgid: number | null;
  /** 退出证明：正常退出 / 被杀 resolve；spawn 失败（如 ENOENT）reject */
  readonly exited: Promise<ExitProof>;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  /** 单进程强杀（非树杀）：幂等，已退出为无害 no-op；置 killedByUs=true */
  kill(): void;
}

/** 树杀结果（观测用：方法分支与"目标本就不存在"的收敛） */
export interface KillTreeResult {
  readonly pid: number | null;
  /** Windows = "taskkill"（/T /F 递归强杀）；POSIX = "process-group"（kill(-pgid, SIGKILL)） */
  readonly method: "process-group" | "taskkill";
  /** 目标进程（树）在动手前已不存在：语义上等价于已杀完 */
  readonly alreadyGone: boolean;
}
