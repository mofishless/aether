// killTree 平台矩阵测试（P0-12）：覆写 process.platform 双向驱动"另一侧"分支。
// 背景：killTree 的平台分派由模块加载时的 IS_WINDOWS 常量决定，本机只能跑到本侧
// 分支（win32 跑不到 POSIX killTreePosix，POSIX 跑不到 taskkill 路径）——历史三次
// 断言翻车均在平台差异。本文件用 vi.resetModules + Object.defineProperty 覆写
// platform 后动态 import，拿到"对侧"的 killTree 实例（常量按覆写值重算）；
// 进程击杀一律 vi.spyOn(process, "kill") 或 setSpawnForTests 注入伪造，零真实子进程。
// 双平台语义（两 OS 各自跑全部用例 → kill-tree.ts 覆盖率两平台一致，P0-12 门禁
// 在 CI 双矩阵生效的前提）：
// - 本文件在 win32 上：跑出 POSIX 分支全矩阵 + Windows 分支注入矩阵；
// - 本文件在 POSIX 上：同两组用例（覆写 win32 后走注入的伪造 taskkill/tasklist，
//   不触真实系统命令）——语义等价，仅"真 taskkill"端到端仍由 kill-tree.test.ts
//   在各平台 CI 上原生覆盖。
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MinimalChild } from "../src/spawn-tracked.js";
import type { ProcessHandle } from "../src/types.js";

const REAL_PLATFORM = process.platform;

/** 一个"平台沙箱"：覆写 platform 后动态 import 得到的模块实例（IS_WINDOWS 已按覆写值定死） */
interface PlatformSandbox {
  readonly killTree: (typeof import("../src/kill-tree.js"))["killTree"];
  readonly setSpawnForTests: (typeof import("../src/spawn-tracked.js"))["setSpawnForTests"];
}

/** 覆写 platform → 重置模块注册表 → 动态 import（模块加载后立即还原 platform） */
async function importKillTreeAs(platform: string): Promise<PlatformSandbox> {
  vi.resetModules();
  Object.defineProperty(process, "platform", { value: platform });
  try {
    const [killTreeModule, spawnTrackedModule] = await Promise.all([
      import("../src/kill-tree.js"),
      import("../src/spawn-tracked.js"),
    ]);
    return {
      killTree: killTreeModule.killTree,
      setSpawnForTests: spawnTrackedModule.setSpawnForTests,
    };
  } finally {
    Object.defineProperty(process, "platform", { value: REAL_PLATFORM });
  }
}

/** 句柄桩：killTree 只读 pid/pgid（其余字段不触达），stub 已按此最小化 */
function stubHandle(pid: number | null, pgid: number | null): ProcessHandle {
  return { pid, pgid } as unknown as ProcessHandle;
}

/** 伪造 errno 型错误（ESRCH=无此进程；EPERM=不可杀） */
function errnoError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * 伪造子进程（依赖注入缝喂给 spawnTracked）：exit 事件与 error 事件二选一触发，
 * stdout/stderr 为 PassThrough 可预置文本（覆盖真实数据监听分支）。
 * exit 事件须在 spawn 返回后异步发（spawnTracked 的监听是同步注册的）。
 */
function fakeChild(options: {
  pid?: number;
  code?: number | null;
  error?: Error;
  stdoutText?: string;
  stderrText?: string;
  stdoutNull?: boolean;
}): MinimalChild {
  const pid = options.pid;
  const code = options.code ?? null;
  const stdoutText = options.stdoutText ?? "";
  const stderrText = options.stderrText ?? "";
  const error = options.error;
  const stdout = options.stdoutNull === true ? null : new PassThrough();
  const stderr = new PassThrough();
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  const child: MinimalChild = {
    pid,
    stdin: null,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    on: ((
      event: string,
      listener:
        | ((code: number | null, signal: NodeJS.Signals | null) => void)
        | ((error: Error) => void),
    ) => {
      if (event === "exit") {
        exitListeners.push(
          listener as (code: number | null, signal: NodeJS.Signals | null) => void,
        );
      }
      if (event === "error") {
        errorListeners.push(listener as (error: Error) => void);
      }
      return child;
    }) as MinimalChild["on"],
    kill: () => true,
  };
  setImmediate(() => {
    if (stdout !== null) stdout.end(stdoutText);
    stderr.end(stderrText);
    if (error !== undefined) {
      for (const listener of errorListeners) listener(error);
      return;
    }
    for (const listener of exitListeners) listener(code, null);
  });
  return child;
}

describe("killTree 平台矩阵（覆写 platform 驱动对侧分支，零真实子进程）", () => {
  afterAll(() => {
    // 卫生：丢弃被覆写求值的模块注册表，platform 在 importKillTreeAs 内已还原
    vi.resetModules();
  });

  describe("POSIX 分支（IS_WINDOWS=false 视角：killTreePosix 全矩阵）", () => {
    let killTree: PlatformSandbox["killTree"];

    beforeAll(async () => {
      ({ killTree } = await importKillTreeAs("linux"));
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("detached 句柄（pgid=pid）：kill(-pgid, SIGKILL) 成功 → alreadyGone=false", async () => {
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const result = await killTree(stubHandle(4242, 4242));
      expect(result).toEqual({ pid: 4242, method: "process-group", alreadyGone: false });
      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
    });

    it("组杀抛非 ESRCH（EPERM）：原样重抛不收敛", async () => {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw errnoError("操作不允许", "EPERM");
      });
      await expect(killTree(stubHandle(4242, 4242))).rejects.toThrow("操作不允许");
    });

    it("组杀 ESRCH 且已知 pgid：alreadyGone=true，绝不回退单杀（防 PID 复用误杀）", async () => {
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw errnoError("无此进程组", "ESRCH");
      });
      const result = await killTree(stubHandle(4242, 4242));
      expect(result).toEqual({ pid: 4242, method: "process-group", alreadyGone: true });
      // 关键断言：只尝试过组杀，没有第二次对裸 pid 的单杀
      expect(killSpy).toHaveBeenCalledTimes(1);
    });

    it("裸 pid（数字入参）：-pid ESRCH → 回退单杀 pid 成功 → alreadyGone=false", async () => {
      const killSpy = vi
        .spyOn(process, "kill")
        .mockImplementationOnce(() => {
          throw errnoError("无此进程组", "ESRCH");
        })
        // 基线实现：后续调用（回退单杀）一律成功——不落回真 process.kill（win32 上
        // 对虚构 pid 会真抛 ESRCH，把 alreadyGone 误收敛成 true）
        .mockImplementation(() => true);
      const result = await killTree(4243);
      expect(result).toEqual({ pid: 4243, method: "process-group", alreadyGone: false });
      expect(killSpy).toHaveBeenCalledTimes(2);
      expect(killSpy).toHaveBeenNthCalledWith(1, -4243, "SIGKILL");
      expect(killSpy).toHaveBeenNthCalledWith(2, 4243, "SIGKILL");
    });

    it("裸 pid：-pid 与 pid 均 ESRCH → alreadyGone=true（幂等收尾）", async () => {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw errnoError("无此进程", "ESRCH");
      });
      const result = await killTree(4244);
      expect(result).toEqual({ pid: 4244, method: "process-group", alreadyGone: true });
    });

    it("裸 pid：回退单杀抛非 ESRCH（EPERM）：原样重抛", async () => {
      vi.spyOn(process, "kill")
        .mockImplementationOnce(() => {
          throw errnoError("无此进程组", "ESRCH");
        })
        .mockImplementationOnce(() => {
          throw errnoError("不可杀", "EPERM");
        });
      await expect(killTree(4245)).rejects.toThrow("不可杀");
    });

    it("spawn 失败句柄（pid=null，如 ENOENT）：无可杀者 → alreadyGone=true 不抛", async () => {
      const result = await killTree(stubHandle(null, null));
      expect(result).toEqual({ pid: null, method: "process-group", alreadyGone: true });
    });
  });

  describe("Windows 分支（IS_WINDOWS=true 视角：taskkill/tasklist 注入矩阵）", () => {
    let killTree: PlatformSandbox["killTree"];
    let setSpawnForTests: PlatformSandbox["setSpawnForTests"];
    const TARGET_PID = 5252;

    /** 注入伪造 spawn：taskkill 按退出码，tasklist 按工厂惰性构造（exit/error 二选一） */
    function injectSpawn(
      taskkillCode: number,
      tasklistChild: () => MinimalChild,
      taskkillStderr = "",
    ): void {
      setSpawnForTests((command) => {
        if (command.endsWith("taskkill.exe")) {
          return fakeChild({ pid: 9997, code: taskkillCode, stderrText: taskkillStderr });
        }
        return tasklistChild();
      });
    }

    beforeAll(async () => {
      ({ killTree, setSpawnForTests } = await importKillTreeAs("win32"));
    });

    afterEach(() => {
      setSpawnForTests(undefined);
      vi.restoreAllMocks();
    });

    it("taskkill 退出码 0：击杀成功 → alreadyGone=false", async () => {
      injectSpawn(0, () => fakeChild({ pid: 9998, code: 0 }));
      const result = await killTree(TARGET_PID);
      expect(result).toEqual({ pid: TARGET_PID, method: "taskkill", alreadyGone: false });
    });

    it("taskkill 退出码 128（目标不存在）：alreadyGone=true 不抛", async () => {
      injectSpawn(128, () => fakeChild({ pid: 9998, code: 0 }));
      const result = await killTree(TARGET_PID);
      expect(result).toEqual({ pid: TARGET_PID, method: "taskkill", alreadyGone: true });
    });

    it("taskkill 255 + tasklist 仍列出该 PID（CSV 第二列匹配）：照抛真失败（stderr 尾部进消息）", async () => {
      injectSpawn(
        255,
        () =>
          fakeChild({
            pid: 9998,
            code: 0,
            stdoutText: '"node.exe","5252","Console","1","47,504 K"\r\n',
          }),
        "错误: 拒绝访问。\r\n",
      );
      await expect(killTree(TARGET_PID)).rejects.toThrow(
        /taskkill \/T \/F 失败（pid=5252，code=255）：错误: 拒绝访问/,
      );
    });

    it("taskkill 255 + tasklist 无匹配（本地化 INFO 行）：alreadyGone=true 收敛", async () => {
      injectSpawn(255, () =>
        fakeChild({ pid: 9998, code: 0, stdoutText: "信息: 没有运行的任务匹配指定标准。\r\n" }),
      );
      const result = await killTree(TARGET_PID);
      expect(result).toEqual({ pid: TARGET_PID, method: "taskkill", alreadyGone: true });
    });

    it("taskkill 255 + tasklist 自身非 0 退出：无法判定 → 保守照抛", async () => {
      injectSpawn(255, () => fakeChild({ pid: 9998, code: 1 }));
      await expect(killTree(TARGET_PID)).rejects.toThrow(/taskkill \/T \/F 失败/);
    });

    it("taskkill 255 + tasklist 从未创建（error 事件 → exited reject）：保守照抛", async () => {
      injectSpawn(255, () =>
        fakeChild({ pid: 9998, error: errnoError("spawn tasklist ENOENT", "ENOENT") }),
      );
      await expect(killTree(TARGET_PID)).rejects.toThrow(/taskkill \/T \/F 失败/);
    });

    it("taskkill 255 + tasklist 成功但 stdout 为 null（防御路径）：无匹配行 → alreadyGone=true", async () => {
      // stdio 配置异常时 handle.stdout 可为 null：尾部缓冲恒空 → 判"无匹配"收敛
      injectSpawn(255, () => fakeChild({ pid: 9998, code: 0, stdoutNull: true }));
      const result = await killTree(TARGET_PID);
      expect(result).toEqual({ pid: TARGET_PID, method: "taskkill", alreadyGone: true });
    });

    it("spawn 失败句柄（pid=null，error 事件句柄）：无可杀者 → alreadyGone=true 不抛", async () => {
      // 经注入缝构造真 spawnTracked 句柄：rawSpawn 返回只发 error 的子进程（如 ENOENT）
      setSpawnForTests(() => fakeChild({ error: errnoError("spawn ENOENT", "ENOENT") }));
      const { spawnTracked } = await import("../src/spawn-tracked.js");
      const handle = spawnTracked("not-exist-command.exe", []);
      expect(handle.pid).toBeNull();
      const result = await killTree(handle);
      expect(result).toEqual({ pid: null, method: "taskkill", alreadyGone: true });
    });
  });
});
