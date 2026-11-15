/** worktree 生命周期统一错误：携带 operation/workspaceId 上下文，cause 保留底层错误供调试。
 *  风格对齐 storage 的 StorageError（P0-05 任务卡：错误集中 WorktreeError）。 */
export interface WorktreeErrorInit {
  /** 失败步骤：validate / resolve-path / reserve / provision.precheck / worktree.add / worktree.remove / worktree.branch-delete / worktree.prune / release / recover */
  operation: string;
  workspaceId?: string | undefined;
  message: string;
  cause?: unknown;
}

export class WorktreeError extends Error {
  readonly operation: string;
  readonly workspaceId: string | undefined;

  constructor(init: WorktreeErrorInit) {
    super(init.message, { cause: init.cause });
    this.name = "WorktreeError";
    this.operation = init.operation;
    this.workspaceId = init.workspaceId;
  }
}

export interface WorktreeErrorContext {
  operation: string;
  workspaceId?: string;
  message: string;
}

/** 把底层异常包装为带上下文的 WorktreeError；已是 WorktreeError 则原样透传（避免双层包装）。 */
export function toWorktreeError(error: unknown, context: WorktreeErrorContext): WorktreeError {
  if (error instanceof WorktreeError) {
    return error;
  }
  return new WorktreeError({ ...context, cause: error });
}

/** 安全提取 unknown 错误的 message（供 warning 文案与恢复报告 detail）。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
