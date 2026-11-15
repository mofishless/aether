import { mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// 分支与路径约定（SYSTEM_DESIGN §4.2 workspace.worktree_path 注释）：
// 主基座 = 项目根同级 .aether-worktrees/（repo 外，不弄脏主 checkout）；
// 该目录不可写/不可创建时回退注入的 fallbackDir/<name>/（daemon 注入 userData，测试注入 tmp）。
// 名字采用预留行的唯一 name 而非 workspaceId：id 由 store 在插入时生成，而 branch/path 是预留行
// 的插入列，必须在 create 之前确定（DDL 注释亦为 .aether-worktrees/<name>/；见任务 deviations）。

export const WORKTREES_DIR_NAME = ".aether-worktrees";

/** workspace 名安全校验：slug 形态（字母数字开头，后续字母数字/./-/_），保证可安全用作分支名与目录名。 */
export const WORKSPACE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 分支命名：aether/<name>。 */
export function branchNameFor(name: string): string {
  return `aether/${name}`;
}

/** 主基座目录（项目根同级 .aether-worktrees/）。 */
export function primaryWorktreesBase(projectRoot: string): string {
  return join(dirname(resolve(projectRoot)), WORKTREES_DIR_NAME);
}

export interface WorktreeLocation {
  worktreePath: string;
  usedFallback: boolean;
}

/** 目录可用 = 可创建（或已存在）且确为目录；失败（权限/被文件占用等）视为不可用。 */
function isUsableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return false;
  }
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** 解析 worktree 落盘位置：优先项目同级 .aether-worktrees/<name>/，不可用时回退 fallbackDir/<name>/。 */
export function resolveWorktreeLocation(
  projectRoot: string,
  name: string,
  fallbackDir: string,
): WorktreeLocation {
  const primaryBase = primaryWorktreesBase(projectRoot);
  if (isUsableDir(primaryBase)) {
    return { worktreePath: resolve(join(primaryBase, name)), usedFallback: false };
  }
  // 回退基座必须可用（否则抛底层 fs 错误，由调用方包装为领域错误）
  mkdirSync(fallbackDir, { recursive: true });
  return { worktreePath: resolve(join(fallbackDir, name)), usedFallback: true };
}
