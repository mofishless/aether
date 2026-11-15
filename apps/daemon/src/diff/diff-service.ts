// diff 服务（P0-11 驾驶舱，§5.2 diff 组）：workspace 行 → worktreePath+branch，
// project 行 → gitDefaultBranch（空缺省 main），core computeWorkspaceDiff 执行比对。
// 未提交改动不在 P0 口径（三点 diff 只看分支已提交内容，任务卡定案）。
import type { DiffResult } from "@aether/contracts";
import type { computeWorkspaceDiff } from "@aether/core";
import type { ProjectRepository, WorkspaceRepository } from "@aether/storage";
import { internalError, invalidParamsError } from "../service-error.js";

export interface DiffServiceDeps {
  readonly workspaces: WorkspaceRepository;
  readonly projects: ProjectRepository;
  /** 比对实现注入缝（默认 core computeWorkspaceDiff；测试可换假件） */
  readonly computeDiff: typeof computeWorkspaceDiff;
}

const DEFAULT_BASE_BRANCH = "main";

export class DiffService {
  constructor(private readonly deps: DiffServiceDeps) {}

  async workspaceDiff(workspaceId: string): Promise<DiffResult> {
    const workspace = this.deps.workspaces.findById(workspaceId);
    if (workspace === null) {
      throw invalidParamsError(`未知工作区：workspaceId=${workspaceId}`);
    }
    const project = this.deps.projects.findById(workspace.projectId);
    if (project === null) {
      throw internalError(`项目行缺失：projectId=${workspace.projectId}`);
    }
    const baseBranch =
      project.gitDefaultBranch.trim().length > 0 ? project.gitDefaultBranch : DEFAULT_BASE_BRANCH;
    try {
      const files = await this.deps.computeDiff({
        cwd: workspace.worktreePath,
        branch: workspace.branch,
        baseBranch,
        workspaceId: workspace.id,
      });
      return { workspaceId: workspace.id, baseBranch, files };
    } catch (cause) {
      // base 分支不存在 / worktree 目录缺失等 git 失败：统一 internal（数据状态问题）
      throw internalError("工作区 diff 计算失败", cause);
    }
  }
}
