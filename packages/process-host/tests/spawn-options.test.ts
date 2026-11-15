// resolveSpawnOptions 默认值断言 + spawn 选项透传（注入缝捕获）：
// 任务卡要求 windowsHide:true 默认（隐藏子进程控制台窗口，调研 06 §9.1）。
import { afterEach, describe, expect, it } from "vitest";
import { resolveSpawnOptions, spawnTracked } from "../src/index.js";
import { setSpawnForTests, type MinimalChild, type RawSpawnOptions } from "../src/spawn-tracked.js";

function fakeChild(): MinimalChild {
  const child: MinimalChild = {
    pid: 4242,
    stdin: null,
    stdout: null,
    stderr: null,
    exitCode: null,
    signalCode: null,
    on: () => child,
    kill: () => true,
  };
  return child;
}

describe("resolveSpawnOptions（默认值与透传）", () => {
  it("默认：windowsHide=true、stdio=pipe、detached=false", () => {
    const resolved = resolveSpawnOptions();
    expect(resolved.windowsHide).toBe(true);
    expect(resolved.stdio).toBe("pipe");
    expect(resolved.detached).toBe(false);
  });

  it("可显式覆盖 windowsHide=false / detached=true / stdio 数组 / cwd / env", () => {
    const resolved = resolveSpawnOptions({
      windowsHide: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: "D:\\tmp",
      env: { AETHER_TEST: "1" },
    });
    expect(resolved.windowsHide).toBe(false);
    expect(resolved.detached).toBe(true);
    expect(resolved.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(resolved.cwd).toBe("D:\\tmp");
    expect(resolved.env).toEqual({ AETHER_TEST: "1" });
  });
});

describe("spawnTracked 选项透传（注入缝捕获 node spawn 调用）", () => {
  afterEach(() => {
    setSpawnForTests(undefined);
  });

  it("windowsHide=true 与 stdio 默认如实传给底层 spawn", () => {
    const calls: Array<{ command: string; args: string[]; options: RawSpawnOptions }> = [];
    setSpawnForTests((command, args, options) => {
      calls.push({ command, args: [...args], options });
      return fakeChild();
    });
    // 故意不传 windowsHide：断言默认值在透传层不丢失（回归缝）
    spawnTracked("probe-bin", ["--flag"]);
    expect(calls.length).toBe(1);
    const first = calls[0];
    if (first === undefined) throw new Error("spawn 未被调用");
    expect(first.command).toBe("probe-bin");
    expect(first.args).toEqual(["--flag"]);
    expect(first.options.windowsHide).toBe(true);
    expect(first.options.stdio).toBe("pipe");
    expect(first.options.detached).toBe(false);
  });
});
