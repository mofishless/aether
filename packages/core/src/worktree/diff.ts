import type { DiffFile, DiffFileStatus } from "@aether/contracts";
import { WorktreeError } from "../errors.js";
import { runGit } from "./git.js";

// ===== 工作区 diff（SYSTEM_DESIGN §5.2 diff.workspaceDiff 的 core 实现，P0-11）=====
// 口径（任务定案）：git diff <base>...<branch>（三点 = merge-base(base, branch) → branch tip），
// 仅含分支上已提交的改动——工作区未提交改动不在 P0 口径内（P1 审查闭环再议）。
// --no-renames 强制 A/M/D 三态（R/C 类型码会破坏 added/modified/deleted 三值契约）；
// core.quotepath=false 让中文等非 ASCII 路径原样输出（本仓中文语境刚需）。
//
// 两命令一次执行：--name-status 拿文件清单，全文 patch 按 "diff --git " 头切分后
// 按路径对位；不做 N+1 逐文件 exec。

/** name-status 状态码 → 契约三值；--no-renames 下其余码（T/U 等）为防御分支 */
function toFileStatus(code: string, path: string): DiffFileStatus {
  if (code === "A") return "added";
  if (code === "M") return "modified";
  if (code === "D") return "deleted";
  throw new WorktreeError({
    operation: "diff.parse",
    message: `git diff 产生了不支持的文件状态码 '${code}'（path=${path}；--no-renames 下不应出现 R/C）`,
  });
}

/** 去掉 git 对含特殊字符路径的 C 风格引号（"..." 形态；JSON 转义子集足够） */
function unquotePath(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw; // 防御：非法转义序列原样返回（git 不应产出）
    }
  }
  return raw;
}

/** --- a/<path> 或 +++ b/<path> 行捕获（含空格路径；行尾制表符防御性剥除）。
 *  前缀含正则元字符（+++），用字符串前缀扫描而非动态 RegExp。 */
function matchHeaderLine(section: string, prefix: string): string | null {
  for (const line of section.split("\n")) {
    if (line.startsWith(prefix)) {
      return unquotePath(line.slice(prefix.length)).replace(/\t$/, "");
    }
  }
  return null;
}

/**
 * 从单个 patch 小节解析归属路径：
 * 优先 ---/+++（added/modified/deleted 均可靠），二进制文件无此二行——
 * 回退解析 "diff --git a/<x> b/<y>" 头（--no-renames 下 x 与 y 相同，取 y）。
 */
function sectionPath(section: string): string | null {
  const oldPath = matchHeaderLine(section, "--- a/");
  if (oldPath !== null) return oldPath;
  const newPath = matchHeaderLine(section, "+++ b/");
  if (newPath !== null) return newPath;
  const header = /^diff --git a\/(.*) b\/(.*)$/m.exec(section);
  if (header !== null) {
    const left = unquotePath(header[1] ?? "");
    const right = unquotePath(header[2] ?? "");
    return left === right ? right : null; // 双侧不同（理论上仅 rename，已被 --no-renames 排除）
  }
  return null;
}

export interface WorkspaceDiffInput {
  /** git 执行 cwd（workspace.worktreePath；linked worktree 内 ref 全局可见） */
  readonly cwd: string;
  /** 工作区分支（workspace.branch，如 aether/<name>） */
  readonly branch: string;
  /** 基准分支（project.gitDefaultBranch，缺省 main 由调用方解析） */
  readonly baseBranch: string;
  /** 错误上下文用 workspace id（可选） */
  readonly workspaceId?: string;
}

/**
 * 计算工作区分支相对基准分支的文件级 diff（unified patch 文本）。
 * 空差异返回 []；base 分支不存在等 git 失败抛 WorktreeError（中文消息）。
 */
export async function computeWorkspaceDiff(input: WorkspaceDiffInput): Promise<DiffFile[]> {
  const { cwd, branch, baseBranch } = input;
  // exactOptionalPropertyTypes：workspaceId 仅在提供时落入上下文
  const gitContext = {
    cwd,
    operation: "diff",
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
  };
  const range = `${baseBranch}...${branch}`;

  const listing = await runGit(
    ["-c", "core.quotepath=false", "diff", "--name-status", "--no-renames", range],
    gitContext,
  );
  const listingLines = listing.stdout.split("\n").filter((line) => line.length > 0);
  if (listingLines.length === 0) {
    return [];
  }

  // 清单行：<code>\t<path>（首个制表符分隔；路径内制表符只会出现在引号形态，unquotePath 处理）
  const entries = listingLines.map((line) => {
    const tabAt = line.indexOf("\t");
    if (tabAt <= 0) {
      throw new WorktreeError({
        operation: "diff.parse",
        workspaceId: input.workspaceId,
        message: `git diff --name-status 行格式异常：${JSON.stringify(line)}`,
      });
    }
    const code = line.slice(0, tabAt);
    const path = unquotePath(line.slice(tabAt + 1));
    return { status: toFileStatus(code, path), path };
  });

  const patch = await runGit(
    ["-c", "core.quotepath=false", "diff", "--no-color", "--no-renames", range],
    gitContext,
  );
  const sections = patch.stdout
    .split(/(?=^diff --git )/m)
    .map((section) => section.replace(/\n+$/, ""))
    .filter((section) => section.length > 0);
  const sectionsByPath = new Map<string, string>();
  for (const section of sections) {
    const path = sectionPath(section);
    if (path !== null && !sectionsByPath.has(path)) {
      sectionsByPath.set(path, section);
    }
  }

  return entries.map((entry) => ({
    path: entry.path,
    status: entry.status,
    patch: sectionsByPath.get(entry.path) ?? "",
  }));
}
