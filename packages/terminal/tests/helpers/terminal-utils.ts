// 测试辅助：跨平台 shell 探测与 PTY 输出等待。
// PATH 探测失败返回 null 供 describe.skipIf 跳过（不挂测试），与任务卡环境提示一致。
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PtySession } from "../../src/index.js";

export const IS_WIN = process.platform === "win32";

export interface TestShell {
  file: string;
  args: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 快速生命周期测试用 shell：win32 → cmd.exe（COMSPEC）；POSIX → /bin/bash 或 /bin/sh */
export function resolveFastTestShell(): TestShell | null {
  if (IS_WIN) {
    const comspec = process.env.COMSPEC;
    if (comspec !== undefined && existsSync(comspec)) {
      return { file: comspec, args: ["/Q"] };
    }
    return { file: "cmd.exe", args: ["/Q"] };
  }
  if (existsSync("/bin/bash")) {
    return { file: "/bin/bash", args: ["--noprofile", "--norc"] };
  }
  if (existsSync("/bin/sh")) {
    return { file: "/bin/sh", args: [] };
  }
  return null;
}

/** UTF-8 中文冒烟用 shell：win32 → PowerShell（Unicode 输出干净，避开 cmd 代码页）；POSIX → bash/sh */
export function resolveUtf8TestShell(): TestShell | null {
  if (IS_WIN) {
    const windir = process.env.windir ?? "C:\\Windows";
    const powershell = join(windir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsSync(powershell)) {
      return { file: powershell, args: ["-NoLogo", "-NoProfile"] };
    }
    return null;
  }
  return resolveFastTestShell();
}

/** describe.skipIf 内取 shell：理论上不会为 null，兜底清晰报错 */
export function requireShell(shell: TestShell | null): TestShell {
  if (shell === null) {
    throw new Error("测试 shell 不可用（不应到达此处：describe 已 skip）");
  }
  return shell;
}

export function toBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** 订阅会话输出并按 UTF-8 累积解码；seqs 记录每个输出帧的序号 */
export interface OutputProbe {
  text: () => string;
  seqs: () => readonly number[];
  frameCount: () => number;
  stop: () => void;
}

export function probeSession(session: PtySession): OutputProbe {
  const chunks: Buffer[] = [];
  const seqList: number[] = [];
  const stop = session.onOutput((chunk) => {
    chunks.push(Buffer.from(chunk.data, "base64"));
    seqList.push(chunk.seq);
  });
  return {
    text: () => Buffer.concat(chunks).toString("utf8"),
    seqs: () => seqList,
    frameCount: () => chunks.length,
    stop,
  };
}

/** 轮询等待 read() 产出包含 marker 的文本，超时抛中文错误并附尾部已收内容 */
export async function waitForText(
  read: () => string,
  marker: string,
  timeoutMs: number,
  stepMs = 100,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = read();
    if (text.includes(marker)) {
      return text;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `等待终端输出 ${JSON.stringify(marker)} 超时（${timeoutMs}ms），尾部已收内容: ${JSON.stringify(text.slice(-300))}`,
      );
    }
    await sleep(stepMs);
  }
}

/** 轮询确认底层进程已退出（kill(pid,0) 抛 ESRCH 视为退出；EPERM 视为仍存活） */
export async function waitProcessExit(pid: number, timeoutMs: number, stepMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM") {
        return;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`进程 ${pid} 在 ${timeoutMs}ms 内未退出（PTY 资源疑似泄漏）`);
    }
    await sleep(stepMs);
  }
}
