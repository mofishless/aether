import { resolve } from "node:path";

// 按路径全局锁（VK 做法，调研 05.C）：同 projectRoot 的 worktree 操作互斥串行，跨项目并行。
// 实现为 per-key Promise 链；链尾永不 reject（避免 unhandled rejection），且 settle 后自清理防 Map 泄漏。

const queues = new Map<string, Promise<unknown>>();

/** 跨来源路径比较归一化：resolve 后 Windows（大小写不敏感文件系统）再小写。
 *  锁键与崩溃恢复的目录认领（claimedPaths 比较）共用同一规则，避免两处规则漂移。 */
export function normalizePathForCompare(path: string): string {
  const resolved = resolve(path);
  // Windows 路径大小写不敏感：归一化为小写保证同一路径只有一个键
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function lockKey(projectRoot: string): string {
  return normalizePathForCompare(projectRoot);
}

/** 在 projectRoot 的全局锁内执行 task：同项目排队串行，跨项目并行；task 的失败原样向调用方传播。 */
export function withProjectLock<T>(projectRoot: string, task: () => Promise<T>): Promise<T> {
  const key = lockKey(projectRoot);
  const previous = queues.get(key) ?? Promise.resolve();
  // 前序成败都不影响本任务入队执行
  const run = previous.then(task, task);
  // 链尾吞掉 rejection：等待者只关心自己的 run
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) {
      queues.delete(key);
    }
  });
  return run;
}
