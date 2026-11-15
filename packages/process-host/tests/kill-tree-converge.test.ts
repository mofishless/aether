// killTree Windows 失败路径收敛回归（P0-06）：全仓并行测试下 bare-pid 树杀已死 PID 时，
// PID 复用可命中他人"正在退出"的进程——taskkill 快照仍见其条目，而 TerminateProcess 对
// 已终止对象恒返 ACCESS_DENIED，于是返回 255"拒绝访问"而非 128"not found"。
// 修复口径：非 0 非 128 时用 tasklist 复核 PID 当下是否仍在系统进程列表——已不在 →
// alreadyGone 收敛；仍在 / 复核工具自身失败 → 照抛（保守）。
// 用 setSpawnForTests 注入缝伪造 taskkill/tasklist，零真实子进程（确定回归，不复现竞态）。
import { afterEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { killTree } from "../src/index.js";
import { setSpawnForTests, type MinimalChild } from "../src/spawn-tracked.js";

const IS_WIN = process.platform === "win32";
const TARGET_PID = 4242;

/** 伪造子进程：stdout 预置文本后结束，exit 事件异步触发（spawnTracked 的监听已同步注册） */
function fakeChild(options: {
  pid: number;
  code: number | null;
  stdoutText?: string;
}): MinimalChild {
  const pid = options.pid;
  const code = options.code;
  const stdoutText = options.stdoutText ?? "";
  const stdout = new PassThrough();
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const child: MinimalChild = {
    pid,
    stdin: null,
    stdout,
    stderr: null,
    exitCode: null,
    signalCode: null,
    on: ((
      event: string,
      listener: (code: number | null, signal: NodeJS.Signals | null) => void,
    ) => {
      if (event === "exit") exitListeners.push(listener);
      return child;
    }) as MinimalChild["on"],
    kill: () => true,
  };
  setImmediate(() => {
    stdout.end(stdoutText);
    for (const listener of exitListeners) listener(code, null);
  });
  return child;
}

/** 注入伪造 spawn：taskkill 返回 255"拒绝访问"，tasklist 按工厂惰性构造（exit 事件须在被 spawn 时才发） */
function injectSpawn(tasklistChild: () => MinimalChild): void {
  setSpawnForTests((command) => {
    if (command.endsWith("taskkill.exe")) {
      return fakeChild({ pid: 9999, code: 255 });
    }
    return tasklistChild();
  });
}

describe("killTree Windows 失败路径收敛（taskkill 255 + tasklist 复核）", () => {
  afterEach(() => {
    setSpawnForTests(undefined);
  });

  it.skipIf(!IS_WIN)("tasklist 无该 PID（本地化 INFO 提示行）：alreadyGone=true 不抛", async () => {
    injectSpawn(() =>
      fakeChild({ pid: 9998, code: 0, stdoutText: "信息: 没有运行的任务匹配指定标准。\r\n" }),
    );
    const result = await killTree(TARGET_PID);
    expect(result.pid).toBe(TARGET_PID);
    expect(result.method).toBe("taskkill");
    expect(result.alreadyGone).toBe(true);
  });

  it.skipIf(!IS_WIN)("tasklist 仍列出该 PID（CSV 第二列匹配）：照抛真失败", async () => {
    injectSpawn(() =>
      fakeChild({
        pid: 9998,
        code: 0,
        stdoutText: '"node.exe","4242","Console","1","47,504 K"\r\n',
      }),
    );
    await expect(killTree(TARGET_PID)).rejects.toThrow(/taskkill \/T \/F 失败/);
  });

  it.skipIf(!IS_WIN)("tasklist 复核自身失败（非 0 退出）：保守照抛", async () => {
    injectSpawn(() => fakeChild({ pid: 9998, code: 1 }));
    await expect(killTree(TARGET_PID)).rejects.toThrow(/taskkill \/T \/F 失败/);
  });
});
