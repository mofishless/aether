import { execFile } from "node:child_process";
import { WorktreeError, errorMessage } from "../errors.js";

// git 执行薄封装：一律 node:child_process execFile("git", args)（本包零新增运行时依赖）。

export interface GitContext {
  cwd: string;
  operation: string;
  workspaceId?: string;
}

export interface GitResult {
  stdout: string;
  stderr: string;
}

export interface GitAttempt extends GitResult {
  ok: boolean;
}

const MAX_BUFFER_BYTES = 10_000_000;

interface RawOutcome {
  ok: boolean;
  error: unknown;
  stdout: string;
  stderr: string;
}

function execGit(args: readonly string[], cwd: string): Promise<RawOutcome> {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      args,
      { cwd, windowsHide: true, maxBuffer: MAX_BUFFER_BYTES, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolvePromise({
          ok: error === null,
          error,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

/** 执行 git；非零退出抛 WorktreeError（operation/workspaceId 上下文 + cause 保留底层错误）。 */
export async function runGit(args: readonly string[], context: GitContext): Promise<GitResult> {
  const outcome = await execGit(args, context.cwd);
  if (!outcome.ok) {
    throw new WorktreeError({
      operation: context.operation,
      workspaceId: context.workspaceId,
      message: `git ${args[0] ?? ""} 失败（cwd=${context.cwd}）：${errorMessage(outcome.error)}`,
      cause: outcome.error,
    });
  }
  return { stdout: outcome.stdout, stderr: outcome.stderr };
}

/** 容错版：非零退出不抛错，返回 ok=false + stderr 供幂等路径决策（如 worktree 已被手动删除）。 */
export async function tryGit(args: readonly string[], context: GitContext): Promise<GitAttempt> {
  const outcome = await execGit(args, context.cwd);
  return { ok: outcome.ok, stdout: outcome.stdout, stderr: outcome.stderr };
}
