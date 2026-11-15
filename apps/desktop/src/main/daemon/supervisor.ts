// daemon 启动器 · 监护组合层：spawn → listening → connect → 握手 → ready。
// daemon 退出 / 心跳超时 / 连接断开 → 自动重启：首次失败零延迟（任务卡 3 秒验收预算含 spawn+握手余量），
// 连续失败第 2 次起有界退避 100→250→500ms 封顶、成功 ready 后复位（spec-review #2 防重启风暴）。
// stop()：system.shutdown RPC（与宽限竞速，spec-review #3）→ 等 exit（2s 宽限）→ 超时 SIGKILL。
// 纯 TS（禁 import electron）；主进程零领域逻辑（SYSTEM_DESIGN §1.2）——本文件只有进程与连接治理。
import { existsSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { WebSocket } from "ws";
import { connectDaemonClient, type DaemonClient } from "./client.js";
import { startHeartbeat, type HeartbeatHandle } from "./heartbeat.js";
import { generateDaemonToken, spawnDaemon, type DaemonSpawnHandle } from "./spawn.js";

const DEFAULT_SHUTDOWN_GRACE_MS = 2000;

// 连续失败重启退避时间表（spec-review #2）：首次失败 0ms（保 3 秒验收），
// 第 2/3 次失败 100/250ms，之后封顶 500ms——秒崩 daemon 不再无限高频 spawn。
const RESTART_BACKOFF_SECOND_FAILURE_MS = 100;
const RESTART_BACKOFF_THIRD_FAILURE_MS = 250;
const RESTART_BACKOFF_CAP_MS = 500;

export type DaemonSupervisorState = "idle" | "starting" | "ready" | "reconnecting" | "stopped";

export interface DaemonExitSnapshot {
  readonly code: number | null;
  readonly signal: string | null;
}

/** 不可变状态快照（onStateChange 回调与测试桥共用） */
export interface DaemonSupervisorStatus {
  readonly state: DaemonSupervisorState;
  readonly pid: number | null;
  readonly port: number | null;
  readonly restartCount: number;
  /** 当前连续失败次数（ready 后归零）；驱动退避节奏，测试桥可观测（spec-review #2） */
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
  readonly lastExit: DaemonExitSnapshot | null;
}

export interface DaemonSupervisorOptions {
  readonly daemonEntryPath: string;
  /** 状态变更回调（不可变快照） */
  readonly onStateChange?: (status: DaemonSupervisorStatus) => void;
  /** 心跳 ping 间隔 ms（缺省 heartbeat.ts 默认 5s） */
  readonly heartbeatIntervalMs?: number;
  /** 心跳判死阈值 ms（缺省 2×间隔） */
  readonly heartbeatTimeoutMs?: number;
  /** listening 行等待超时 ms（缺省 spawn.ts 默认 10s） */
  readonly listeningTimeoutMs?: number;
  /** RPC 单请求超时 ms（缺省 client.ts 默认 5s） */
  readonly requestTimeoutMs?: number;
  /** 每次 spawn 的 argv，attempt 从 0 递增（故障注入测试用；缺省恒空数组） */
  readonly resolveDaemonArgs?: (attempt: number) => readonly string[];
  /** 每次 spawn 追加注入的 daemon env（P0-11：launcher 注入 AETHER_DAEMON_DB_PATH） */
  readonly extraSpawnEnv?: Readonly<Record<string, string>>;
  /** stop() 优雅退出宽限 ms，默认 2000 */
  readonly shutdownGraceMs?: number;
}

export interface DaemonSupervisor {
  /** resolve 于首次 ready（启动失败自动重试期间保持 pending）；入口缺失等致命错误 reject */
  start(): Promise<DaemonSupervisorStatus>;
  /** 优雅停止并 resolve；幂等（重复调用复用同一 promise） */
  stop(): Promise<void>;
  getStatus(): DaemonSupervisorStatus;
  /** 当前连接端点（供渲染层经 preload 直连 daemon）；非 ready 期返回 null */
  getEndpoint(): { readonly port: number; readonly token: string } | null;
  /** system.health RPC（监护自检，非领域逻辑） */
  health(): Promise<{ readonly ok: boolean }>;
}

interface Attempt {
  readonly spawn: DaemonSpawnHandle;
  readonly client: DaemonClient;
  readonly heartbeat: HeartbeatHandle;
}

interface StatusPatch {
  readonly state?: DaemonSupervisorState;
  readonly pid?: number | null;
  readonly port?: number | null;
  readonly restartCount?: number;
  readonly consecutiveFailures?: number;
  readonly lastError?: string | null;
  readonly lastExit?: DaemonExitSnapshot | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 退避查表：首次失败零延迟（3 秒验收），第 2/3 次 100/250ms，之后封顶 */
function backoffDelayFor(consecutiveFailures: number): number {
  if (consecutiveFailures <= 1) return 0;
  if (consecutiveFailures === 2) return RESTART_BACKOFF_SECOND_FAILURE_MS;
  if (consecutiveFailures === 3) return RESTART_BACKOFF_THIRD_FAILURE_MS;
  return RESTART_BACKOFF_CAP_MS;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function createDaemonSupervisor(options: DaemonSupervisorOptions): DaemonSupervisor {
  const {
    daemonEntryPath,
    onStateChange,
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    listeningTimeoutMs,
    requestTimeoutMs,
    resolveDaemonArgs,
    extraSpawnEnv,
    shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
  } = options;

  // 固有的可变运行时状态（同 daemon 服务器层做法：最小局部可变量 + 不可变快照外发）
  let pid: number | null = null;
  let port: number | null = null;
  let activeToken: string | null = null; // 当前 attempt 的握手 token（getEndpoint 供渲染层直连）
  let restartCount = 0;
  let consecutiveFailures = 0;
  let lastError: string | null = null;
  let lastExit: DaemonExitSnapshot | null = null;
  let state: DaemonSupervisorState = "idle";
  let current: Attempt | null = null;
  let strayChild: ChildProcess | null = null; // listening 等待中的子进程（stop 时立杀防孤儿）
  let generation = 0; // 递增代次：旧 attempt 的迟到回调一律判失效
  let attemptNumber = -1; // 用户面 attempt 计数（首次 spawn = 0；与内部 generation 解耦）
  let stopping = false;
  let cycleActive = false; // 启动/重启循环进行中（scheduleRestart 单飞闸）
  let startPromise: Promise<DaemonSupervisorStatus> | null = null;
  let stopPromise: Promise<void> | null = null;

  function snapshot(): DaemonSupervisorStatus {
    return Object.freeze({
      state,
      pid,
      port,
      restartCount,
      consecutiveFailures,
      lastError,
      lastExit: lastExit === null ? null : Object.freeze({ ...lastExit }),
    });
  }

  function setStatus(patch: StatusPatch): DaemonSupervisorStatus {
    if (patch.state !== undefined) state = patch.state;
    if (patch.pid !== undefined) pid = patch.pid;
    if (patch.port !== undefined) port = patch.port;
    if (patch.restartCount !== undefined) restartCount = patch.restartCount;
    if (patch.consecutiveFailures !== undefined) consecutiveFailures = patch.consecutiveFailures;
    if (patch.lastError !== undefined) lastError = patch.lastError;
    if (patch.lastExit !== undefined) lastExit = patch.lastExit;
    const status = snapshot();
    onStateChange?.(status);
    return status;
  }

  function cleanupAttempt(attempt: Attempt): void {
    attempt.heartbeat.stop();
    attempt.client.close();
    attempt.spawn.kill();
  }

  /** 运行失败（exit/心跳超时/连接断开）→ 自动重启（有界退避，见文件头）。单飞：循环进行中直接忽略。 */
  function scheduleRestart(reason: string): void {
    if (stopping || cycleActive) return;
    cycleActive = true;
    generation += 1;
    restartCount += 1;
    consecutiveFailures += 1;
    const attempt = current;
    current = null;
    strayChild = null;
    if (attempt !== null) cleanupAttempt(attempt);
    const waitMs = backoffDelayFor(consecutiveFailures);
    setStatus({
      state: "reconnecting",
      pid: null,
      port: null,
      lastError: reason,
      consecutiveFailures,
    });
    activeToken = null;
    // 退避窗口内 cycleActive 保持置位（迟到 scheduleRestart 判单飞忽略）；
    // stop() 落在窗口内时由 launch 的 stopping 检查收尾，不产生额外 spawn。
    void (waitMs > 0 ? delay(waitMs) : Promise.resolve()).then(() => {
      void launch();
    });
  }

  async function runAttempt(gen: number): Promise<Attempt | null> {
    const stale = (): boolean => gen !== generation || stopping;
    attemptNumber += 1;
    const token = generateDaemonToken();
    const args = resolveDaemonArgs !== undefined ? resolveDaemonArgs(attemptNumber) : [];

    const spawned = await spawnDaemon({
      daemonEntryPath,
      token,
      args,
      ...(extraSpawnEnv !== undefined ? { extraEnv: extraSpawnEnv } : {}),
      ...(listeningTimeoutMs !== undefined ? { listeningTimeoutMs } : {}),
      onSpawned: (child) => {
        strayChild = child;
      },
    });
    if (stale()) {
      spawned.kill();
      return null;
    }

    void spawned.exited.then((exitInfo) => {
      lastExit = { code: exitInfo.code, signal: exitInfo.signal };
      if (!stale()) {
        const reason =
          exitInfo.error !== null
            ? `daemon 进程错误：${exitInfo.error}`
            : `daemon 退出（code=${exitInfo.code} signal=${exitInfo.signal}）`;
        scheduleRestart(reason);
      }
    });

    let client: DaemonClient;
    try {
      client = await connectDaemonClient({
        port: spawned.port,
        token,
        ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
      });
    } catch (error) {
      spawned.kill();
      throw error;
    }
    if (stale()) {
      client.close();
      spawned.kill();
      return null;
    }
    activeToken = token;

    client.socket.on("close", () => {
      if (!stale()) scheduleRestart("daemon 连接关闭");
    });

    const heartbeat = startHeartbeat({
      socket: client.socket,
      ...(heartbeatIntervalMs !== undefined ? { intervalMs: heartbeatIntervalMs } : {}),
      ...(heartbeatTimeoutMs !== undefined ? { timeoutMs: heartbeatTimeoutMs } : {}),
      onTimeout: () => {
        if (!stale()) scheduleRestart("心跳超时（无 pong 判死）");
      },
    });

    return { spawn: spawned, client, heartbeat };
  }

  /** 启动/重启循环：直到 ready 或 stop；失败按退避表重试（首次失败零延迟，见文件头） */
  async function launch(): Promise<DaemonSupervisorStatus> {
    cycleActive = true;
    try {
      while (!stopping) {
        generation += 1;
        const gen = generation;
        try {
          const attempt = await runAttempt(gen);
          if (attempt === null) return snapshot(); // stop/换代竞态：收尾交给 stop()
          current = attempt;
          strayChild = null;
          consecutiveFailures = 0;
          // lastError 保留最近一次失败原因（恢复后仍可诊断），不被 ready 清除
          return setStatus({
            state: "ready",
            pid: attempt.spawn.child.pid ?? null,
            port: attempt.spawn.port,
            consecutiveFailures: 0,
          });
        } catch (error) {
          if (stopping) return snapshot();
          restartCount += 1;
          consecutiveFailures += 1;
          setStatus({
            state: "reconnecting",
            pid: null,
            port: null,
            lastError: messageOf(error),
            consecutiveFailures,
          });
          const waitMs = backoffDelayFor(consecutiveFailures);
          if (waitMs > 0) await delay(waitMs);
        }
      }
      return snapshot();
    } finally {
      cycleActive = false;
    }
  }

  async function beginStart(): Promise<DaemonSupervisorStatus> {
    if (state === "stopped") {
      throw new Error("supervisor 已停止，不可复用（请重建实例）");
    }
    if (!existsSync(daemonEntryPath)) {
      const message = `daemon 入口不存在：${daemonEntryPath}（先执行 pnpm build）`;
      setStatus({ lastError: message });
      throw new Error(message);
    }
    setStatus({ state: "starting", pid: null, port: null });
    return launch();
  }

  async function performStop(): Promise<void> {
    stopping = true;
    generation += 1;
    const attempt = current;
    current = null;

    if (attempt !== null) {
      attempt.heartbeat.stop();
      if (attempt.client.socket.readyState === WebSocket.OPEN) {
        // 优雅路径：daemon 回 Success 帧后才退出（关闭竞态由 catch 吸收）。
        // RPC 与宽限竞速（spec-review #3）：挂死 daemon 既不回帧也不退出时，
        // 不再叠加 RPC 自身的 5s 超时——总预算收敛到 ~2×宽限，before-quit 不被拖住。
        await Promise.race([
          attempt.client.request("system.shutdown").catch(() => undefined),
          delay(shutdownGraceMs),
        ]);
      }
      const graceful = await raceExit(attempt.spawn.exited, shutdownGraceMs);
      if (graceful !== null) {
        lastExit = { code: graceful.code, signal: graceful.signal };
      } else {
        attempt.spawn.kill();
        const killed = await raceExit(attempt.spawn.exited, shutdownGraceMs);
        if (killed !== null) {
          lastExit = { code: killed.code, signal: killed.signal };
        }
      }
      attempt.client.close();
    }

    // listening 等待中的子进程：立即强杀（spawn.ts 自身超时也会兜底杀）
    const stray = strayChild;
    strayChild = null;
    if (stray !== null && stray.pid !== undefined && stray.exitCode === null) {
      try {
        stray.kill("SIGKILL");
      } catch {
        // 已退出的竞态：无需处理
      }
    }

    activeToken = null;
    setStatus({ state: "stopped", pid: null, port: null });
  }

  function start(): Promise<DaemonSupervisorStatus> {
    startPromise ??= beginStart();
    return startPromise;
  }

  function stop(): Promise<void> {
    stopPromise ??= performStop();
    return stopPromise;
  }

  async function health(): Promise<{ readonly ok: boolean }> {
    const attempt = current;
    if (attempt === null) {
      throw new Error(`daemon 未就绪（state=${state}），无法执行 system.health`);
    }
    return attempt.client.request<{ ok: boolean }>("system.health");
  }

  /** 当前连接端点（渲染层经 preload 直连用）；非 ready 期 port/token 未齐 → null */
  function getEndpoint(): { readonly port: number; readonly token: string } | null {
    if (port === null || activeToken === null) return null;
    return { port, token: activeToken };
  }

  return { start, stop, getStatus: snapshot, getEndpoint, health };
}

/** 等 exit 与超时竞速；超时先到返回 null */
function raceExit(
  exited: Promise<{ readonly code: number | null; readonly signal: string | null }>,
  timeoutMs: number,
): Promise<{ readonly code: number | null; readonly signal: string | null } | null> {
  return Promise.race([
    exited.then((info) => ({ info })),
    delay(timeoutMs).then(() => ({ info: null })),
  ]).then((outcome) => outcome.info);
}
