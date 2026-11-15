import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { ProcessHandle, SpawnTrackedOptions } from "@aether/process-host";

// ===== SDK spawn 钩子 ↔ process-host 治理桥（P0-07 查证定案）=====
// @anthropic-ai/claude-agent-sdk@0.3.325 的 Options.spawnClaudeCodeProcess：
//   (options: SpawnOptions) => SpawnedProcess——SDK 官方自定义 spawn 钩子
//   （"Use to run Claude Code in VMs, containers, or remote environments"），
//   SpawnOptions 携带 SDK 已解析好的 command/args/cwd/env/signal。
// 本桥把 spawn 路由进 process-host（spawnCommand：Windows .cmd 安全转义、
// windowsHide、POSIX detached 进程组），拿到治理句柄（PID/ExitProof/killTree），
// 再包一层满足 SDK SpawnedProcess 接口（ChildProcess 结构性满足同一形状）。

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;

interface BridgeState {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  lastExit: { code: number | null; signal: NodeJS.Signals | null } | null;
  lastError: Error | null;
}

/**
 * 把 process-host 的 ProcessHandle 适配成 SDK 的 SpawnedProcess。
 * exit/error 事件由 handle.exited 证明 promise 桥接：先注册的监听在 promise
 * settle 时收到；settle 之后注册的监听立即收到缓存载荷（SDK 同步注册先于进程退出，
 * 缓存兜底仅防御性）。
 */
export function wrapProcessHandle(handle: ProcessHandle): SpawnedProcess {
  if (handle.stdin === null || handle.stdout === null) {
    throw new Error("spawn stdio 必须为 pipe（SDK stream-json 传输需要 stdin/stdout 管道）");
  }
  const exitListeners = new Set<ExitListener>();
  const errorListeners = new Set<ErrorListener>();
  const state: BridgeState = {
    exitCode: null,
    signalCode: null,
    killed: false,
    lastExit: null,
    lastError: null,
  };

  const deliverExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    state.exitCode = code;
    state.signalCode = signal;
    state.lastExit = { code, signal };
    // 快照迭代：once/off 回调可能在迭代中改动监听集
    const listeners = [...exitListeners];
    for (const listener of listeners) listener(code, signal);
  };
  const deliverError = (error: Error): void => {
    state.lastError = error;
    const listeners = [...errorListeners];
    for (const listener of listeners) listener(error);
  };

  // spawn 失败防护：handle.exited reject（进程从未创建）由 catch 吸收为 error 事件
  void handle.exited.then(
    (proof) => {
      deliverExit(proof.code, (proof.signal as NodeJS.Signals | null) ?? null);
    },
    (error: unknown) => {
      deliverError(error instanceof Error ? error : new Error(String(error)));
    },
  );

  const subscribe = (
    event: "exit" | "error",
    listener: ExitListener | ErrorListener,
    once: boolean,
  ): void => {
    const listeners = event === "exit" ? exitListeners : errorListeners;
    const bound: ExitListener & ErrorListener = once
      ? (((...args: unknown[]) => {
          listeners.delete(bound);
          (listener as (...a: unknown[]) => void)(...args);
        }) as ExitListener & ErrorListener)
      : (listener as ExitListener & ErrorListener);
    listeners.add(bound);
    // 已 settle 的补发（settle 前注册的监听已由 deliver* 覆盖）
    if (event === "exit" && state.lastExit !== null) {
      (bound as ExitListener)(state.lastExit.code, state.lastExit.signal);
    } else if (event === "error" && state.lastError !== null) {
      (bound as ErrorListener)(state.lastError);
    }
  };

  return {
    stdin: handle.stdin,
    stdout: handle.stdout,
    get killed(): boolean {
      return state.killed;
    },
    get exitCode(): number | null {
      return state.exitCode;
    },
    get signalCode(): NodeJS.Signals | null {
      return state.signalCode;
    },
    kill(_signal: NodeJS.Signals): boolean {
      state.killed = true;
      handle.kill(); // 幂等：已退出为无害 no-op（process-host 保证）
      return true;
    },
    on(event: "exit" | "error", listener: ExitListener | ErrorListener): void {
      subscribe(event, listener, false);
    },
    once(event: "exit" | "error", listener: ExitListener | ErrorListener): void {
      subscribe(event, listener, true);
    },
    off(event: "exit" | "error", listener: ExitListener | ErrorListener): void {
      if (event === "exit") exitListeners.delete(listener as ExitListener);
      else errorListeners.delete(listener as ErrorListener);
    },
  };
}

export interface ProcessHostSpawnDeps {
  /** 注入缝（默认 process-host spawnCommand；测试用 mock） */
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: SpawnTrackedOptions,
  ) => ProcessHandle;
  /** 治理句柄回调：适配器在此捕获 handle（PID/退出证明/killTree 目标） */
  readonly onHandle?: (handle: ProcessHandle) => void;
}

/**
 * 构造 SDK 的 spawnClaudeCodeProcess 钩子：SDK 已解析的 command/args/env 原样
 * 路由进 process-host；POSIX 上 detached（子进程即组长，killTree 整组树杀，
 * TASK_LIST P0-06 验收口径）；SpawnOptions.signal abort 时兜底 handle.kill
 * （SDK 保证该 signal 在 stdin-EOF + ~2s 优雅窗口之后才触发）。
 */
export function createProcessHostSpawn(
  deps: ProcessHostSpawnDeps,
): (options: SpawnOptions) => SpawnedProcess {
  return (options: SpawnOptions): SpawnedProcess => {
    const handle = deps.spawn(options.command, options.args, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: options.env,
      detached: process.platform !== "win32",
    });
    if (handle.stdin === null || handle.stdout === null) {
      throw new Error("spawn stdio 必须为 pipe（SDK stream-json 传输需要 stdin/stdout 管道）");
    }
    deps.onHandle?.(handle);
    options.signal.addEventListener(
      "abort",
      () => {
        handle.kill();
      },
      { once: true },
    );
    return wrapProcessHandle(handle);
  };
}
