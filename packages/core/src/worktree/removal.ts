import { rmSync } from "node:fs";
import { tryGit } from "./git.js";

// 容错删除（release 与崩溃恢复共用）：git 元数据/目录已不在（手动删过、或 add 半途崩溃）时幂等续行。

/** 尽力移除 worktree 的磁盘痕迹：先 git worktree remove --force；失败则 prune + 直删残留目录。 */
export async function removeWorktree(
  projectRoot: string,
  worktreePath: string,
  workspaceId: string,
): Promise<void> {
  const context = { cwd: projectRoot, operation: "worktree.remove", workspaceId };
  const removed = await tryGit(["worktree", "remove", "--force", worktreePath], context);
  if (!removed.ok) {
    // git 已不认这个 worktree（目录被手动删 / 元数据失效）→ 幂等：清元数据 + 清残留目录
    await tryGit(["worktree", "prune"], {
      cwd: projectRoot,
      operation: "worktree.prune",
      workspaceId,
    });
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      // 目录已被移除或被占用：无能为力也不致命（行删除照常进行）
    }
  }
}

/** 尽力删除分支（-D）：先探测——分支不存在（从未建/已删）直接视为已删除成功（幂等无噪：
 *  git branch -D 对不存在分支退出码 1，会让未 provision 行的 release 误发"分支删除未成功"警告）；
 *  存在才 -D，真实失败（如被其他 worktree 持有）返回 false 由调用方决定是否警告。 */
export async function removeBranch(
  projectRoot: string,
  branch: string,
  workspaceId: string,
): Promise<boolean> {
  const probe = await tryGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: projectRoot,
    operation: "worktree.branch-probe",
    workspaceId,
  });
  if (!probe.ok) {
    return true; // 分支不存在 = 目标已达成（幂等）
  }
  const outcome = await tryGit(["branch", "-D", branch], {
    cwd: projectRoot,
    operation: "worktree.branch-delete",
    workspaceId,
  });
  return outcome.ok;
}

/** 残留分支回收（场景：历史 release 的 -D 失败遗留分支会让后续同名 worktree add -b 永远失败，
 *  行标 failed 后不在恢复扫描集 → 该 name 永久不可用）：
 *  分支存在且未被任何 worktree 占用时删除并返回 true，调用方可安全重试 add；
 *  分支不存在（add 失败另有原因）或被占用返回 false，由调用方按原失败处理。
 *  占用判定交给 git 自身：-D 对被其他 worktree 持有 / 为当前 checkout 的分支会直接拒绝。 */
export async function tryReclaimResidualBranch(
  projectRoot: string,
  branch: string,
  workspaceId: string,
): Promise<boolean> {
  const probe = await tryGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: projectRoot,
    operation: "worktree.branch-probe",
    workspaceId,
  });
  if (!probe.ok) {
    return false; // 分支不存在：add 失败另有原因，不归残留回收管
  }
  const deleted = await tryGit(["branch", "-D", branch], {
    cwd: projectRoot,
    operation: "worktree.branch-delete",
    workspaceId,
  });
  return deleted.ok;
}
