import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { ProcessHandle, ExitProof } from "@aether/process-host";
import { createProcessHostSpawn, wrapProcessHandle } from "../src/spawn-bridge.js";

// wrapProcessHandle：把 process-host 的 ProcessHandle 适配成 SDK 的 SpawnedProcess
// （@anthropic-ai/claude-agent-sdk@0.3.325 sdk.d.ts SpawnedProcess 接口；
//   官方语义：ChildProcess 结构性满足——本桥让 ProcessHandle 也满足同一形状）。

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeHandleInput {
  readonly pid?: number | null;
  readonly pgid?: number | null;
  readonly exitProof?: Promise<ExitProof>;
  readonly exitError?: Promise<never>;
}

function fakeHandle(
  input: FakeHandleInput = {},
): ProcessHandle & { killSpy: ReturnType<typeof vi.fn> } {
  const killSpy = vi.fn();
  const handle: ProcessHandle & { killSpy: ReturnType<typeof vi.fn> } = {
    pid: input.pid ?? 1234,
    pgid: input.pgid ?? null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exited: input.exitProof ?? input.exitError ?? new Promise<ExitProof>(() => undefined), // 默认挂起（进程未退出）
    kill: killSpy,
    killSpy,
  };
  return handle;
}

const PROOF = (over: Partial<ExitProof> = {}): ExitProof =>
  Object.freeze({
    pid: 1234,
    code: 0,
    signal: null,
    killedByUs: false,
    exitedAt: "2026-01-01T00:00:00Z",
    ...over,
  });

describe("wrapProcessHandle：exit 事件桥接", () => {
  it("exited resolve → on('exit') 收到 (code, signal)，exitCode 更新", async () => {
    const d = deferred<ExitProof>();
    const handle = fakeHandle({ exitProof: d.promise });
    const wrapped = wrapProcessHandle(handle);
    const onExit = vi.fn();
    wrapped.on("exit", onExit);
    d.resolve(PROOF({ code: 1, signal: "SIGKILL" }));
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(1, "SIGKILL"));
    expect(wrapped.exitCode).toBe(1);
  });

  it("晚注册的 exit 监听（进程已退出后 on）也会收到缓存载荷", async () => {
    const d = deferred<ExitProof>();
    const handle = fakeHandle({ exitProof: d.promise });
    const wrapped = wrapProcessHandle(handle);
    d.resolve(PROOF({ code: 0 }));
    await d.promise;
    const late = vi.fn();
    wrapped.on("exit", late);
    expect(late).toHaveBeenCalledWith(0, null);
  });

  it("exited reject（spawn 失败）→ on('error') 收到错误", async () => {
    const d = deferred<ExitProof>();
    const handle = fakeHandle({ exitProof: d.promise });
    const wrapped = wrapProcessHandle(handle);
    const onError = vi.fn();
    wrapped.on("error", onError);
    const err = new Error("ENOENT");
    d.reject(err);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(err));
  });

  it("once 只触发一次；off 移除监听", async () => {
    const d = deferred<ExitProof>();
    const handle = fakeHandle({ exitProof: d.promise });
    const wrapped = wrapProcessHandle(handle);
    const onceFn = vi.fn();
    const offFn = vi.fn();
    wrapped.once("exit", onceFn);
    wrapped.on("exit", offFn);
    wrapped.off("exit", offFn);
    d.resolve(PROOF({ code: 0 }));
    await d.promise;
    expect(onceFn).toHaveBeenCalledTimes(1);
    expect(offFn).not.toHaveBeenCalled();
  });
});

describe("wrapProcessHandle：kill 与只读状态", () => {
  it("kill(signal) 委托给 handle.kill（幂等由 process-host 保证）", () => {
    const handle = fakeHandle();
    const wrapped = wrapProcessHandle(handle);
    expect(wrapped.kill("SIGTERM")).toBe(true);
    expect(handle.killSpy).toHaveBeenCalledTimes(1);
  });

  it("stdin/stdout 透传；exitCode 初始为 null；killed 跟随 kill", () => {
    const handle = fakeHandle();
    const wrapped = wrapProcessHandle(handle);
    expect(wrapped.stdin).toBe(handle.stdin);
    expect(wrapped.stdout).toBe(handle.stdout);
    expect(wrapped.exitCode).toBeNull();
    expect(wrapped.killed).toBe(false);
    wrapped.kill("SIGKILL");
    expect(wrapped.killed).toBe(true);
  });
});

describe("createProcessHostSpawn：SDK spawnClaudeCodeProcess 钩子工厂", () => {
  function abortable(): { signal: AbortSignal; abort: AbortController } {
    const abort = new AbortController();
    return { signal: abort.signal, abort };
  }

  it("把 SpawnOptions 路由进注入的 spawn（command/args/cwd/env 原样、POSIX detached）", () => {
    const spawn = vi.fn().mockImplementation(() => fakeHandle());
    const onHandle = vi.fn();
    const spawnHook = createProcessHostSpawn({ spawn, onHandle });
    const { signal } = abortable();
    spawnHook({
      command: "node",
      args: ["cli.js", "-p", "hi"],
      cwd: "/wt",
      env: { PATH: "/bin" },
      signal,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(command).toBe("node");
    expect(args).toEqual(["cli.js", "-p", "hi"]);
    expect(options.cwd).toBe("/wt");
    expect(options.env).toEqual({ PATH: "/bin" });
    expect(options.detached).toBe(process.platform !== "win32");
    expect(onHandle).toHaveBeenCalledTimes(1);
  });

  it("返回值满足 SpawnedProcess 形状；handle 经 onHandle 回调交给治理方", () => {
    const handle = fakeHandle();
    const spawnHook = createProcessHostSpawn({ spawn: () => handle, onHandle: () => undefined });
    const wrapped = spawnHook({
      command: "node",
      args: [],
      env: {},
      signal: abortable().signal,
    });
    expect(typeof wrapped.on).toBe("function");
    expect(typeof wrapped.kill).toBe("function");
  });

  it("SpawnOptions.signal abort（SDK 优雅关闭窗口后）→ handle.kill 兜底", async () => {
    const handle = fakeHandle();
    const spawnHook = createProcessHostSpawn({ spawn: () => handle, onHandle: () => undefined });
    const { signal, abort } = abortable();
    spawnHook({ command: "node", args: [], env: {}, signal });
    expect(handle.killSpy).not.toHaveBeenCalled();
    abort.abort();
    expect(handle.killSpy).toHaveBeenCalledTimes(1);
  });

  it("stdio 非 pipe（stdin/stdout 为 null）时抛出（SDK 传输需要管道）", () => {
    const bare = fakeHandle();
    const handle = { ...bare, stdin: null, stdout: null } as unknown as ProcessHandle;
    const spawnHook = createProcessHostSpawn({ spawn: () => handle, onHandle: () => undefined });
    expect(() =>
      spawnHook({ command: "node", args: [], env: {}, signal: abortable().signal }),
    ).toThrow(/stdio|pipe/i);
  });
});
