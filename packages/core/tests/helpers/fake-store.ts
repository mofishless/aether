import { randomUUID } from "node:crypto";
import type { Workspace, WorkspaceStatus } from "@aether/contracts";
import type {
  WorkspaceStore,
  WorkspaceStoreCreateInput,
  WorkspaceStorePatch,
} from "../../src/ports/workspace-store.port.js";

/** 内存版 WorkspaceStore（Map 版）：模拟 workspace 表的 UNIQUE(name) / UNIQUE(worktree_path)，
 *  并记录 create/update 调用史供状态机断言（reserved→creating→ready）。 */
export class InMemoryWorkspaceStore implements WorkspaceStore {
  private readonly rows = new Map<string, Workspace>();
  private readonly createHistory: Workspace[] = [];
  private readonly updateHistory: { id: string; patch: WorkspaceStorePatch }[] = [];

  create(input: WorkspaceStoreCreateInput): Workspace {
    const name = input.name;
    const worktreePath = input.worktreePath;
    for (const row of this.rows.values()) {
      if (row.name === name) {
        throw new Error(`UNIQUE constraint failed: workspace.name(${name})`);
      }
      if (row.worktreePath === worktreePath) {
        throw new Error(`UNIQUE constraint failed: workspace.worktree_path(${worktreePath})`);
      }
    }
    const row: Workspace = {
      id: randomUUID(),
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      name,
      branch: input.branch,
      worktreePath,
      storageKey: input.storageKey,
      status: input.status ?? "reserved",
      createdAt: new Date().toISOString(),
      releasedAt: input.releasedAt ?? null,
    };
    this.rows.set(row.id, row);
    this.createHistory.push(row);
    return { ...row };
  }

  update(id: string, patch: WorkspaceStorePatch): Workspace | null {
    const current = this.rows.get(id);
    if (current === undefined) {
      return null;
    }
    const next: Workspace = { ...current, ...patch, id };
    this.rows.set(id, next);
    this.updateHistory.push({ id, patch });
    return { ...next };
  }

  findById(id: string): Workspace | null {
    const row = this.rows.get(id);
    return row === undefined ? null : { ...row };
  }

  findByStatuses(statuses: readonly WorkspaceStatus[]): Workspace[] {
    return [...this.rows.values()]
      .filter((row) => statuses.includes(row.status))
      .map((row) => ({ ...row }));
  }

  delete(id: string): boolean {
    return this.rows.delete(id);
  }

  /** create 调用史（含初始 status），测试断言 reserved 落库。 */
  get createLog(): readonly Workspace[] {
    return [...this.createHistory];
  }

  /** update 调用史，测试断言状态机迁移序列。 */
  get updateLog(): readonly { id: string; patch: WorkspaceStorePatch }[] {
    return [...this.updateHistory];
  }

  /** 全表快照（测试断言用）。 */
  snapshot(): readonly Workspace[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }
}
