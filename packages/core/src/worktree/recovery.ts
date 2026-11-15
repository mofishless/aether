import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { WorkspaceStatusSchema } from "@aether/contracts";
import type { Workspace, WorkspaceStatus } from "@aether/contracts";
import { errorMessage } from "../errors.js";
import type { WorkspaceStore } from "../ports/workspace-store.port.js";
import { tryGit } from "./git.js";
import { normalizePathForCompare } from "./lock.js";
import { primaryWorktreesBase } from "./paths.js";
import type { PackageManager } from "./package-manager.js";
import { finishProvision } from "./post-create.js";
import { removeBranch, removeWorktree } from "./removal.js";

/** 崩溃恢复扫描口径：任务卡要求 creating/deleting/orphaned（SYSTEM_DESIGN §4.2）；
 *  reserved 是"已写库行未动 Git"的崩溃前态（预留与动 Git 之间崩溃），一并扫描（测试 4A 口径）。
 *  archived 不扫：属 P1+ 归档生命周期，P0-05 无进入路径（见 workspace-store.port.ts 状态口径注）。 */
export const RECOVERY_SCAN_STATUSES: readonly WorkspaceStatus[] = [
  "reserved",
  "creating",
  "deleting",
  "orphaned",
];

const ALL_STATUSES: readonly WorkspaceStatus[] = WorkspaceStatusSchema.options;

export type RecoveryAction =
  | "deleted-stale-row" // reserved/creating 未动 Git（或半成品目录已清）→ 清行（选清理，定案见下）
  | "completed-deletion" // deleting/orphaned → 补完全部删除步骤
  | "resumed-ready" // creating + 磁盘 worktree 完整 → 补走后续步骤收敛 ready
  | "removed-orphan-dir" // 磁盘目录无行认领（或行已被行扫描清掉）→ 清目录
  | "marked-failed"; // 恢复单项失败 → 行标 failed（目录清理失败时仅记录），继续其余项

export interface RecoveryEntry {
  /** 行 id；removed-orphan-dir 时为目录名。 */
  workspaceId: string;
  action: RecoveryAction;
  detail?: string | undefined;
  packageManager?: PackageManager | null | undefined;
}

export interface RecoverProjectDeps {
  store: WorkspaceStore;
  projectRoot: string;
  projectId: string;
  fallbackDir: string;
  onWarning?: (message: string) => void;
}

/** 单目录状态：missing=无目录；worktree=完整 linked worktree（有 .git 指针）；dir-without-git=半成品/残留目录。 */
type DirState = "missing" | "worktree" | "dir-without-git";

function inspectDir(worktreePath: string): DirState {
  if (!existsSync(worktreePath)) {
    return "missing";
  }
  // linked worktree 标记：.git 文件（gitdir 指针）
  return existsSync(join(worktreePath, ".git")) ? "worktree" : "dir-without-git";
}

/** 崩溃恢复主流程（启动时 + 可周期调用；调用方须持 projectRoot 路径锁）：
 *  阶段 1 行驱动：reserved/creating/deleting/orphaned 逐行核对磁盘后收敛；
 *  阶段 1.5 ready 对账：ready 行目录已缺失（被外部删除）→ 视为孤儿先标 orphaned 再补完删除（封对账洞）；
 *  阶段 2 目录驱动：主基座与回退基座里无行认领的目录视为孤儿清理（任务卡：目录存在但无行/行 reserved → 选清理）。
 *  半成品（creating + 目录不完整）定案：选清理不补建——重建成本低于冒险续用半成品 worktree。 */
export async function recoverProjectOrphans(
  deps: RecoverProjectDeps,
): Promise<readonly RecoveryEntry[]> {
  const store = deps.store;
  const projectId = deps.projectId;
  const entries: RecoveryEntry[] = [];

  // 阶段 1：行驱动恢复（只处理本项目的行；磁盘核对决定收敛方向）
  const staleRows = store
    .findByStatuses(RECOVERY_SCAN_STATUSES)
    .filter((row) => row.projectId === projectId);
  for (const row of staleRows) {
    entries.push(await recoverRow(deps, row));
  }

  // 阶段 1.5：ready 对账——目录已缺失的 ready 行视为孤儿（外部删除的 ready 视为孤儿），
  // 先标 orphaned 落痕（orphaned 状态的生产写入入口）再补完删除；目录健在的 ready 行不是恢复对象。
  const readyRows = store.findByStatuses(["ready"]).filter((row) => row.projectId === projectId);
  for (const row of readyRows) {
    if (inspectDir(row.worktreePath) === "missing") {
      entries.push(await recoverRow(deps, row));
    }
  }

  // 阶段 2：目录驱动清理（行扫描可能刚删了行，此处以"幸存行"认领为准）。
  // 大小写归一比较（win32 不敏感 FS）：库行 worktreePath 与磁盘目录名大小写可能不一致，
  // 裸字符串比较会把健康 worktree 误判为无主孤儿目录直接删除（丢数据）。
  const claimedPaths = new Set(
    store.findByStatuses(ALL_STATUSES).map((row) => normalizePathForCompare(row.worktreePath)),
  );
  for (const base of scanBases(deps)) {
    for (const entry of collectDirectoryEntries(base)) {
      const dirPath = resolve(join(base, entry));
      if (claimedPaths.has(normalizePathForCompare(dirPath))) {
        continue;
      }
      entries.push(removeOrphanDir(deps, entry, dirPath));
    }
  }
  // 统一清一次 git 元数据（幂等、廉价；目录被直删后 worktree 管理数据残留由此收敛）
  await tryGit(["worktree", "prune"], {
    cwd: deps.projectRoot,
    operation: "worktree.prune",
  });

  return [...entries];
}

async function recoverRow(deps: RecoverProjectDeps, row: Workspace): Promise<RecoveryEntry> {
  const store = deps.store;
  const workspaceId = row.id;
  try {
    const dirState = inspectDir(row.worktreePath);
    switch (row.status) {
      case "reserved": {
        // 预留后未动 Git 即崩溃：无任何 Git 资产，清行即可（目录若矛盾存在，阶段 2 兜底清理）
        store.delete(workspaceId);
        return {
          workspaceId,
          action: "deleted-stale-row",
          detail: dirState === "missing" ? "reserved 未动 Git" : "reserved 且目录已清",
        };
      }
      case "creating": {
        if (dirState === "worktree") {
          // 已动 Git 未回写库：补走后续步骤（.env / 包管理器探测）收敛 ready
          const extras = finishProvision(deps.projectRoot, row.worktreePath);
          for (const warning of extras.warnings) {
            deps.onWarning?.(warning);
          }
          const ready = store.update(workspaceId, { status: "ready" });
          if (ready === null) {
            return { workspaceId, action: "deleted-stale-row", detail: "恢复期间行消失" };
          }
          return { workspaceId, action: "resumed-ready", packageManager: extras.packageManager };
        }
        // 半成品或未动 Git：选清理（见函数注释定案）
        await removeWorktree(deps.projectRoot, row.worktreePath, workspaceId);
        await removeBranch(deps.projectRoot, row.branch, workspaceId);
        store.delete(workspaceId);
        return {
          workspaceId,
          action: "deleted-stale-row",
          detail: dirState === "missing" ? "creating 未动 Git" : "creating 半成品目录已清",
        };
      }
      case "ready": {
        // 外部删除的 ready 视为孤儿（调用方对账循环已确认目录缺失）：
        // 先标 orphaned 落痕（orphaned 状态的生产写入入口），再补完删除
        const marked = store.update(workspaceId, { status: "orphaned" });
        if (marked === null) {
          return { workspaceId, action: "deleted-stale-row", detail: "恢复期间行消失" };
        }
        return completeDeletion(deps, row, "ready 目录已缺失（外部删除）→ 孤儿收敛");
      }
      case "deleting":
      case "orphaned": {
        // 补完删除：目录/分支/行
        return completeDeletion(
          deps,
          row,
          row.status === "orphaned" ? "orphaned 行已清" : undefined,
        );
      }
      default:
        return { workspaceId, action: "marked-failed", detail: `非恢复口径状态：${row.status}` };
    }
  } catch (error) {
    try {
      store.update(workspaceId, { status: "failed" });
    } catch {
      // 标记失败不掩盖原始错误
    }
    return { workspaceId, action: "marked-failed", detail: errorMessage(error) };
  }
}

/** 补完删除（deleting/orphaned/外部删除的 ready 共用）：目录 → 分支 → 行，收敛为 completed-deletion。 */
async function completeDeletion(
  deps: RecoverProjectDeps,
  row: Workspace,
  detail?: string,
): Promise<RecoveryEntry> {
  await removeWorktree(deps.projectRoot, row.worktreePath, row.id);
  await removeBranch(deps.projectRoot, row.branch, row.id);
  deps.store.delete(row.id);
  return { workspaceId: row.id, action: "completed-deletion", detail };
}

function scanBases(deps: RecoverProjectDeps): readonly string[] {
  const bases = [primaryWorktreesBase(deps.projectRoot), resolve(deps.fallbackDir)];
  return [...new Set(bases)];
}

function collectDirectoryEntries(base: string): readonly string[] {
  try {
    if (!statSync(base).isDirectory()) {
      return [];
    }
  } catch {
    return []; // 基座不存在：无孤儿可扫
  }
  try {
    return readdirSync(base).filter((name) => {
      try {
        return statSync(join(base, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function removeOrphanDir(
  deps: RecoverProjectDeps,
  dirName: string,
  dirPath: string,
): RecoveryEntry {
  try {
    rmSync(dirPath, { recursive: true, force: true });
    if (existsSync(dirPath)) {
      return {
        workspaceId: dirName,
        action: "marked-failed",
        detail: `孤儿目录清理后仍存在（可能被占用）：${dirPath}`,
      };
    }
    return { workspaceId: dirName, action: "removed-orphan-dir", detail: dirPath };
  } catch (error) {
    return {
      workspaceId: dirName,
      action: "marked-failed",
      detail: `孤儿目录清理失败：${errorMessage(error)}`,
    };
  }
}
