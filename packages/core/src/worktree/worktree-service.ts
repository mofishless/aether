import type { Workspace } from "@aether/contracts";
import { toWorktreeError, WorktreeError } from "../errors.js";
import { nowIso } from "../util/time.js";
import type { WorkspaceStore } from "../ports/workspace-store.port.js";
import { runGit, tryGit } from "./git.js";
import { withProjectLock } from "./lock.js";
import { branchNameFor, resolveWorktreeLocation, WORKSPACE_NAME_PATTERN } from "./paths.js";
import { finishProvision } from "./post-create.js";
import type { PackageManager } from "./package-manager.js";
import { recoverProjectOrphans, type RecoveryEntry } from "./recovery.js";
import { removeBranch, removeWorktree, tryReclaimResidualBranch } from "./removal.js";

/** worktree 生命周期服务（SYSTEM_DESIGN §1.2：core 编排 worktree 生命周期；纯 TS，无 Electron/无 UI）。 */
export interface WorktreeLifecycleOptions {
  store: WorkspaceStore;
  /** 不可写主基座时的回退基座（daemon 注入 userData 目录，测试注入 tmp）。 */
  fallbackDir: string;
  /** 非致命问题（如 .env 拷贝失败）的通知口；缺省丢弃。 */
  onWarning?: (message: string) => void;
}

export interface CreateWorkspaceInput {
  projectId: string;
  /** 唯一名；同时用作分支名与目录名（slug 校验见 WORKSPACE_NAME_PATTERN）。 */
  name: string;
  taskId?: string | null;
}

export interface CreateWorkspaceResult {
  workspace: Workspace;
  packageManager: PackageManager | null;
  usedFallback: boolean;
  warnings: readonly string[];
}

export class WorktreeLifecycleService {
  constructor(private readonly options: WorktreeLifecycleOptions) {}

  /** 持久预留先行（调研 05.D.3）：锁内先写 reserved 行（唯一 name 撞车即失败）再动 Git——
   *  预留与动 Git 同锁串行，周期 recoverOrphans（同锁）不会再击碎"已落库未进锁"的在途预留。 */
  async createForTask(
    projectRoot: string,
    input: CreateWorkspaceInput,
  ): Promise<CreateWorkspaceResult> {
    const name = requireValidName(input.name);
    const projectId = input.projectId;
    if (projectId.length === 0) {
      throw new WorktreeError({ operation: "validate", message: "projectId 不能为空" });
    }
    const taskId = input.taskId ?? null;

    // ①② 预留与动 Git 全程在路径锁内（持久预留先行语义不变：仍先库行后 Git；
    // 同名并发从 UNIQUE 竞争变为锁内串行碰撞，唯一约束仍兜底）
    return withProjectLock(projectRoot, async () => {
      // 路径/分支必须在预留前确定（它们是预留行的插入列）
      let location;
      try {
        location = resolveWorktreeLocation(projectRoot, name, this.options.fallbackDir);
      } catch (error) {
        throw toWorktreeError(error, {
          operation: "resolve-path",
          message: `worktree 目录不可用且回退失败（name=${name}）`,
        });
      }

      const branch = branchNameFor(name);
      let reserved: Workspace;
      try {
        reserved = this.options.store.create({
          projectId,
          taskId,
          name,
          branch,
          worktreePath: location.worktreePath,
          storageKey: name,
          status: "reserved",
        });
      } catch (error) {
        throw toWorktreeError(error, {
          operation: "reserve",
          message: `工作区预留失败（name=${name}）：可能已被占用`,
        });
      }

      return this.provision(projectRoot, reserved, location.usedFallback);
    });
  }

  /** 释放：锁内 deleting → git worktree remove --force + 分支 -D → 删行；git 已不存在则幂等继续。
   *  决策：分支随 worktree 一并删除（-D）——worktree 生命周期归属 workspace（见任务 deviations）。 */
  async release(workspaceId: string, projectRoot: string): Promise<void> {
    await withProjectLock(projectRoot, async () => {
      const store = this.options.store;
      const row = store.findById(workspaceId);
      if (row === null) {
        return; // 幂等：行已删（二次 release 不炸）
      }
      store.update(workspaceId, { status: "deleting", releasedAt: nowIso() });
      await removeWorktree(projectRoot, row.worktreePath, workspaceId);
      const branchRemoved = await removeBranch(projectRoot, row.branch, workspaceId);
      if (!branchRemoved) {
        this.emitWarning(`分支删除未成功（branch=${row.branch}，workspace=${workspaceId}）`);
      }
      store.delete(workspaceId);
    });
  }

  /** 崩溃恢复（启动时 + 可周期调用）：行扫描（reserved/creating/deleting/orphaned）
   *  + ready 对账（目录缺失的 ready 视为孤儿收敛）+ 孤儿目录扫描。
   *  持锁执行：与 createForTask/release 在同一路径锁下互斥。 */
  async recoverOrphans(projectRoot: string, projectId: string): Promise<readonly RecoveryEntry[]> {
    return withProjectLock(projectRoot, () =>
      recoverProjectOrphans({
        store: this.options.store,
        projectRoot,
        projectId,
        fallbackDir: this.options.fallbackDir,
        onWarning: (message) => this.emitWarning(message),
      }),
    );
  }

  private async provision(
    projectRoot: string,
    reserved: Workspace,
    usedFallback: boolean,
  ): Promise<CreateWorkspaceResult> {
    const store = this.options.store;
    const workspaceId = reserved.id;
    const branch = reserved.branch;
    const worktreePath = reserved.worktreePath;

    const movedToCreating = store.update(workspaceId, { status: "creating" });
    if (movedToCreating === null) {
      // 预留行消失：预留已入锁后正常时序不可达（恢复与创建同锁互斥）；防御外部删行/换库
      throw new WorktreeError({
        operation: "provision",
        workspaceId,
        message: "预留行已消失（可能被外部删除）",
      });
    }

    try {
      // 前置检查：必须是 git 仓库；脏度不阻拦（不弄脏也不依赖主 checkout 状态）
      await runGit(["rev-parse", "--is-inside-work-tree"], {
        cwd: projectRoot,
        operation: "precheck",
        workspaceId,
      });
      // worktree add（含 -b 建分支）；失败时先回收残留分支再重试一次（见 addWorktreeWithReclaim 注释）
      await addWorktreeWithReclaim(projectRoot, workspaceId, branch, worktreePath);
      // ③④ 非致命收尾（.env 拷贝失败只 warning；包管理器只探测）
      const extras = finishProvision(projectRoot, worktreePath);
      for (const warning of extras.warnings) {
        this.emitWarning(warning);
      }
      // ⑤ ready
      const ready = store.update(workspaceId, { status: "ready" });
      if (ready === null) {
        throw new WorktreeError({
          operation: "provision",
          workspaceId,
          message: "工作区就绪回写失败：行已消失",
        });
      }
      return {
        workspace: ready,
        packageManager: extras.packageManager,
        usedFallback,
        warnings: extras.warnings,
      };
    } catch (error) {
      // 失败路径：行标 failed（尽力而为），错误集中 WorktreeError 抛出
      try {
        store.update(workspaceId, { status: "failed" });
      } catch {
        // 标记失败不掩盖原始错误
      }
      throw toWorktreeError(error, {
        operation: "provision",
        workspaceId,
        message: `工作区创建失败（name=${reserved.name}）`,
      });
    }
  }

  private emitWarning(message: string): void {
    this.options.onWarning?.(message);
  }
}

/** worktree add -b：失败时先回收"存在且未被占用"的残留分支（历史 release 的 -D 失败遗留，
 *  否则同名 add -b 永远失败 → 该 name 永久不可用）再重试一次；回收不了则抛出首次失败的
 *  领域错误（行标 failed 由 provision 的 catch 处理）。 */
async function addWorktreeWithReclaim(
  projectRoot: string,
  workspaceId: string,
  branch: string,
  worktreePath: string,
): Promise<void> {
  const context = { cwd: projectRoot, operation: "worktree.add", workspaceId };
  const addArgs: readonly string[] = ["worktree", "add", "-b", branch, worktreePath];
  const firstAttempt = await tryGit(addArgs, context);
  if (firstAttempt.ok) {
    return;
  }
  const reclaimed = await tryReclaimResidualBranch(projectRoot, branch, workspaceId);
  if (reclaimed) {
    // 残留分支已清：重试一次（仍失败则抛领域错误走 failed 标记）
    await runGit(addArgs, context);
    return;
  }
  throw new WorktreeError({
    operation: "worktree.add",
    workspaceId,
    message: `git worktree add 失败（cwd=${projectRoot}）：${firstAttempt.stderr.trim()}`,
  });
}

function requireValidName(name: string): string {
  const trimmed = name.trim();
  if (!WORKSPACE_NAME_PATTERN.test(trimmed)) {
    throw new WorktreeError({
      operation: "validate",
      message: `非法 workspace 名（${JSON.stringify(name)}）：须为字母数字开头，仅含字母数字/./-/_ 的 slug`,
    });
  }
  return trimmed;
}
