// pty-session：真实 PTY 生命周期（验收主路径）。
// create → write("echo marker\r") → 输出回传 → resize（shell 内实测新尺寸）→ dispose →
// 底层进程退出 → 再 dispose 幂等。shell 缺失时整个 describe 跳过（不挂）。
import { describe, expect, it } from "vitest";
import { createPtySession } from "../src/index.js";
import {
  probeSession,
  requireShell,
  resolveFastTestShell,
  toBase64,
  waitForText,
  waitProcessExit,
} from "./helpers/terminal-utils.js";

const shell = resolveFastTestShell();

describe.skipIf(shell === null)("pty-session：真实 PTY 生命周期", () => {
  it("create → 键入 → 输出回传 → resize 重绘生效 → dispose → 进程退出（幂等）", async () => {
    const sh = requireShell(shell);
    const session = createPtySession({
      terminalId: "t-life",
      file: sh.file,
      args: sh.args,
      cols: 80,
      rows: 24,
    });
    expect(session.terminalId).toBe("t-life");
    expect(session.pid).toBeGreaterThan(0);
    expect(session.cols).toBe(80);
    expect(session.rows).toBe(24);

    const probe = probeSession(session);
    session.write(toBase64("echo aether_life_marker\r"));
    await waitForText(probe.text, "aether_life_marker", 15_000);

    // seq 从 1 单调递增
    const seqs = probe.seqs();
    expect(seqs.length).toBeGreaterThan(0);
    expect(seqs[0]).toBe(1);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    // resize 正确重绘（端到端）：不仅断言 bookkeeping，还要 shell 内实测
    // 确认子进程真的看到新尺寸（spec-review：session 自记 cols/rows 证明不了
    // pty.resize 生效）。97/29 为刻意避开通用值（80/120/24/30）的尺寸。
    session.resize(97, 29);
    expect(session.cols).toBe(97);
    expect(session.rows).toBe(29);
    if (process.platform === "win32") {
      // mode con 输出文本随系统语言本地化，但列/行数字恒在
      session.write(toBase64("mode con\r"));
      await waitForText(probe.text, "97", 15_000);
      await waitForText(probe.text, "29", 15_000);
    } else {
      // stty size 输出 "rows cols"（非本地化）
      session.write(toBase64("stty size\r"));
      await waitForText(probe.text, "29 97", 15_000);
    }
    session.write(toBase64("echo aether_post_resize\r"));
    await waitForText(probe.text, "aether_post_resize", 15_000);

    // 边界入参校验（中文错误消息）
    expect(() => session.write("!!!非base64!!!")).toThrow(/base64/);
    expect(() => session.resize(0, 10)).toThrow(/正整数/);
    expect(() => session.resize(80, 1.5)).toThrow(/正整数/);

    const proof = await session.dispose();
    expect(proof).toHaveProperty("exitCode");
    await waitProcessExit(session.pid, 10_000);

    // 幂等：再次 dispose 返回同一退出证明，不再抛错
    const proofAgain = await session.dispose();
    expect(proofAgain).toEqual(proof);
    probe.stop();
  }, 40_000);

  it("创建参数校验：尺寸与 terminalId", () => {
    const sh = requireShell(shell);
    expect(() =>
      createPtySession({ terminalId: "", file: sh.file, args: sh.args, cols: 80, rows: 24 }),
    ).toThrow(/terminalId/);
    expect(() =>
      createPtySession({ terminalId: "t-bad", file: sh.file, args: sh.args, cols: 0, rows: 24 }),
    ).toThrow(/正整数/);
    expect(() =>
      createPtySession({ terminalId: "t-bad", file: sh.file, args: sh.args, cols: 80, rows: -2 }),
    ).toThrow(/正整数/);
  });

  // CI run #10 ubuntu 回归：SIGHUP 后 onExit 迟迟不来 → dispose 1s 升级 SIGKILL。
  // 仅 POSIX（win32 kill 无信号语义）；bash -c 非交互 + trap 忽略 HUP，制造
  // "软信号杀不死"的确定场景，断言升级路径真实收敛（SIGKILL → exitCode null）。
  it.skipIf(process.platform === "win32")(
    "SIGHUP 被忽略的进程：dispose 升级 SIGKILL 仍收敛退出证明",
    async () => {
      const session = createPtySession({
        terminalId: "t-sig-escalation",
        file: "/bin/bash",
        args: ["-c", "trap '' HUP; sleep 10"],
        cols: 80,
        rows: 24,
      });
      const startedAt = Date.now();
      const proof = await session.dispose();
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeLessThan(10_000); // 5s settle 兜底内必收敛
      expect(proof.exitCode).toBeNull(); // SIGKILL 信号死 → null（§7.3）
    },
    20_000,
  );

  // CI run #13 ubuntu 回归：正常退出必须报 exitCode=0——Linux 下进程退出时 PTY
  // master 读端发 EIO error（伴生事件），先于 native onExit 到达；error 监听器
  // 若 settle(null) 会把正常退出误判为异常终止。node -e 双平台退出语义一致。
  it("自然退出的进程：退出证明 exitCode=0（EIO 伴生 error 不得误判异常终止）", async () => {
    const session = createPtySession({
      terminalId: "t-clean-exit",
      file: process.execPath,
      args: ["-e", "console.log('aether-clean-exit')"],
      cols: 80,
      rows: 24,
    });
    const proof = await session.exited;
    expect(proof.exitCode).toBe(0);
    expect(proof.signal).toBeNull();
  });
});
