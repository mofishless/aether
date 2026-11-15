// 测试共享工具：真子进程 PID 探活 / 轮询消失 / stdout 文本收集。
// 验收口径（TASK_LIST P0-06）：轮询间隔 100ms、总预算 5s、ESRCH 判消失。
import type { Readable } from "node:stream";

/** PID 探活：signal 0 探测；ESRCH=已消失；EPERM 等=存在但不可杀（按存活计） */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 轮询等待全部 PID 消失；超预算则抛出存活清单（孤儿断言失败主体） */
export async function waitForPidsGone(
  pids: readonly number[],
  options: { intervalMs?: number; budgetMs?: number } = {},
): Promise<void> {
  const { intervalMs = 100, budgetMs = 5000 } = options;
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const survivors = pids.filter((pid) => isPidAlive(pid));
    if (survivors.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`PID 仍存活（孤儿）：${survivors.join(", ")}`);
    }
    await delay(intervalMs);
  }
}

/** 收集流到结束的全部文本（utf8） */
export function collectText(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      text += chunk;
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(text));
  });
}
