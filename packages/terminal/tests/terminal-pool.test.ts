// terminal-pool：terminalId → 会话 Map（VK PtyService 形状，§7.1）。
// 覆盖 create/write/resize/kill（幂等）/disposeAll/有界历史查询/自然退出后历史保留。
import { describe, expect, it } from "vitest";
import { TerminalExitFrameSchema, TerminalOutputFrameSchema } from "@aether/contracts";
import type { TerminalExitFrame, TerminalOutputFrame } from "@aether/contracts";
import { existsSync } from "node:fs";
import { createTerminalPool, resolveDefaultShell } from "../src/index.js";
import {
  IS_WIN,
  requireShell,
  resolveFastTestShell,
  toBase64,
  waitForText,
} from "./helpers/terminal-utils.js";

const shell = resolveFastTestShell();

function decodeFrames(frames: readonly TerminalOutputFrame[]): string {
  return Buffer.concat(frames.map((f) => Buffer.from(f.data, "base64"))).toString("utf8");
}

describe.skipIf(shell === null)("terminal-pool：PTY 会话池", () => {
  it("create → write → 输出帧（seq 从 1、升级位齐带）→ resize → kill 幂等", async () => {
    const sh = requireShell(shell);
    const pool = createTerminalPool();
    const handle = pool.create({
      terminalId: "tp-1",
      file: sh.file,
      args: sh.args,
      cols: 80,
      rows: 24,
    });
    expect(handle.terminalId).toBe("tp-1");
    expect(handle.pid).toBeGreaterThan(0);
    expect(pool.size).toBe(1);

    const frames: TerminalOutputFrame[] = [];
    const exits: TerminalExitFrame[] = [];
    const offOutput = pool.onOutput((frame) => frames.push(frame));
    const offExit = pool.onExit((frame) => exits.push(frame));

    // 未知终端 write/resize 返回 false（不抛错）
    expect(pool.write("tp-unknown", toBase64("hi"))).toBe(false);
    expect(pool.resize("tp-unknown", 100, 30)).toBe(false);

    expect(pool.write("tp-1", toBase64("echo aether_pool_731\r"))).toBe(true);
    await waitForText(() => decodeFrames(frames), "aether_pool_731", 15_000);

    // 输出帧为合法 wire 帧：升级位 + base64 + 单调 seq 从 1 起
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(TerminalOutputFrameSchema.parse(frame)).toEqual(frame);
    }
    expect(frames[0]?.seq).toBe(1);
    const seqs = frames.map((f) => f.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    // resize 语义 + kill 幂等（未知/已杀 → null）
    expect(pool.resize("tp-1", 100, 30)).toBe(true);
    const proof = await pool.kill("tp-1");
    expect(proof).not.toBeNull();
    expect(await pool.kill("tp-1")).toBeNull();
    expect(pool.size).toBe(0);
    expect(pool.historyFrames("tp-1")).toBeNull();

    // exit 帧已发出且为合法 wire 帧
    expect(exits.length).toBe(1);
    expect(TerminalExitFrameSchema.parse(exits[0])).toEqual(exits[0]);
    expect(exits[0]).toMatchObject({ type: "exit", terminalId: "tp-1" });
    // 显式 kill 的退出码语义（§7.3，normalizeExitCode）：POSIX kill → shell 死于
    // SIGHUP → exitCode 归一为 null（信号死）；win32 走 TerminateProcess，退出码
    // 依 node-pty 实现不定，不做跨平台恒等断言（帧合法性已由上方 schema 覆盖）。
    if (!IS_WIN) {
      expect(exits[0]?.exitCode).toBeNull();
    }
    offOutput();
    offExit();
  }, 40_000);

  it("自然退出（默认 shell）：exit 帧发出、有界历史仍可查，kill 幂等清理", async () => {
    const pool = createTerminalPool();
    const frames: TerminalOutputFrame[] = [];
    const exits: TerminalExitFrame[] = [];
    const offOutput = pool.onOutput((frame) => {
      if (frame.terminalId === "tp-exit") {
        frames.push(frame);
      }
    });
    const offExit = pool.onExit((frame) => exits.push(frame));

    // 不传 file：走 resolveDefaultShell 默认探测
    pool.create({ terminalId: "tp-exit", cols: 80, rows: 24 });
    pool.write("tp-exit", toBase64("echo aether_hist_before_exit\r"));
    await waitForText(() => decodeFrames(frames), "aether_hist_before_exit", 15_000);

    // 让 shell 自然退出 → exit 帧发出，条目保留供 attach 查历史
    pool.write("tp-exit", toBase64("exit\r"));
    await waitForText(() => exits.map((e) => e.terminalId).join(","), "tp-exit", 15_000);
    expect(pool.size).toBe(1);

    const history = pool.historyFrames("tp-exit");
    expect(history).not.toBeNull();
    expect(decodeFrames(history ?? [])).toContain("aether_hist_before_exit");
    expect(history?.[0]?.seq).toBe(1);

    expect(await pool.kill("tp-exit")).not.toBeNull();
    expect(pool.size).toBe(0);
    expect(pool.historyFrames("tp-exit")).toBeNull();
    offOutput();
    offExit();
  }, 40_000);

  it("disposeAll 清空全部会话，之后 kill/查询为空", async () => {
    const sh = requireShell(shell);
    const pool = createTerminalPool();
    pool.create({ terminalId: "tp-a", file: sh.file, args: sh.args, cols: 80, rows: 24 });
    pool.create({ terminalId: "tp-b", file: sh.file, args: sh.args, cols: 80, rows: 24 });
    expect(pool.size).toBe(2);
    await pool.disposeAll();
    expect(pool.size).toBe(0);
    expect(await pool.kill("tp-a")).toBeNull();
    expect(pool.historyFrames("tp-b")).toBeNull();
  }, 40_000);

  it("重复 terminalId 拒绝创建", () => {
    const sh = requireShell(shell);
    const pool = createTerminalPool();
    pool.create({ terminalId: "tp-dup", file: sh.file, args: sh.args, cols: 80, rows: 24 });
    expect(() => pool.create({ terminalId: "tp-dup", cols: 80, rows: 24 })).toThrow(/已存在/);
    void pool.disposeAll();
  });
});

describe("resolveDefaultShell：默认 shell 探测", () => {
  it("返回存在的绝对路径，或 null（PATH 缺失时上层决定跳过）", () => {
    const shellFile = resolveDefaultShell();
    if (shellFile !== null) {
      expect(existsSync(shellFile)).toBe(true);
    }
  });
});
