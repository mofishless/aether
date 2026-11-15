import type { Workspace, WorkspaceStatus } from "@aether/contracts";

// 依赖倒置端口（SYSTEM_DESIGN §2：core 只依赖 contracts，不 import storage）。
// 形状与 storage 的 WorkspaceRepository 公共方法面一一对应（同步方法、同参数语义），
// 因此 WorkspaceRepository 结构性满足本接口，daemon 可直接传入而无需适配器。

/** 与 storage WorkspaceCreateInput 结构一致；id/createdAt 由 store 生成。 */
export interface WorkspaceStoreCreateInput {
  projectId: string;
  name: string;
  branch: string;
  worktreePath: string;
  storageKey: string;
  taskId?: string | null;
  status?: WorkspaceStatus;
  releasedAt?: string | null;
}

/** PATCH 语义：只更新给出的字段；id 不可更新。 */
export type WorkspaceStorePatch = Partial<Omit<Workspace, "id">>;

/** workspace 行存取端口（崩溃恢复也经由此口扫描）。 */
export interface WorkspaceStore {
  /** 唯一约束：name / worktreePath 撞车时抛错（持久预留先行的并发碰撞安全，调研 05.D.3）。 */
  create(input: WorkspaceStoreCreateInput): Workspace;
  /** 行不存在返回 null。 */
  update(id: string, patch: WorkspaceStorePatch): Workspace | null;
  findById(id: string): Workspace | null;
  /** 崩溃恢复扫描口径：creating / deleting / orphaned（SYSTEM_DESIGN §4.2）；传全部七值即全表。
   *  状态口径注：archived 属 P1+ 归档生命周期（见 TASK_LIST P0-05 之后阶段）——P0-05 无进入路径
   *  （创建/释放/恢复均不写 archived），也不在恢复扫描口径内；仅为七值枚举完整性而在。 */
  findByStatuses(statuses: readonly WorkspaceStatus[]): Workspace[];
  /** 行存在返回 true；不存在返回 false（幂等删除）。 */
  delete(id: string): boolean;
}
