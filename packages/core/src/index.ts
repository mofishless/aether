// @aether/core —— 领域核心（SYSTEM_DESIGN §1.2/§2）：
// 本包当前承载 worktree 生命周期（P0-05）：持久预留先行、按路径全局锁、崩溃恢复。
// 依赖方向：只依赖 @aether/contracts（端口在本包定义，storage 的实现结构性满足）；git 一律 execFile。
export { WorktreeError, errorMessage, toWorktreeError } from "./errors.js";
export type { WorktreeErrorContext, WorktreeErrorInit } from "./errors.js";
export { nowIso } from "./util/time.js";
export type {
  WorkspaceStore,
  WorkspaceStoreCreateInput,
  WorkspaceStorePatch,
} from "./ports/workspace-store.port.js";
export { withProjectLock } from "./worktree/lock.js";
export {
  branchNameFor,
  primaryWorktreesBase,
  resolveWorktreeLocation,
  WORKSPACE_NAME_PATTERN,
  WORKTREES_DIR_NAME,
} from "./worktree/paths.js";
export type { WorktreeLocation } from "./worktree/paths.js";
export { runGit, tryGit } from "./worktree/git.js";
export type { GitAttempt, GitContext, GitResult } from "./worktree/git.js";
export { copyEnvFile } from "./worktree/env-copy.js";
export type { EnvCopyOutcome } from "./worktree/env-copy.js";
export { detectPackageManager } from "./worktree/package-manager.js";
export type { PackageManager } from "./worktree/package-manager.js";
export { RECOVERY_SCAN_STATUSES, recoverProjectOrphans } from "./worktree/recovery.js";
export type { RecoveryAction, RecoveryEntry, RecoverProjectDeps } from "./worktree/recovery.js";
export { WorktreeLifecycleService } from "./worktree/worktree-service.js";
export type {
  CreateWorkspaceInput,
  CreateWorkspaceResult,
  WorktreeLifecycleOptions,
} from "./worktree/worktree-service.js";
