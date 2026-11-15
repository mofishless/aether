import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { WorkspaceStatusSchema } from "@aether/contracts";
import type { Workspace, WorkspaceStatus } from "@aether/contracts";
import { StorageError, toStorageError } from "../errors.js";
import { buildUpdateStatement, readEnum, readNullableString, readString } from "../row-mapping.js";
import { nowIso } from "../time.js";

const TABLE = "workspace";

export interface WorkspaceCreateInput {
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
export type WorkspacePatch = Partial<Omit<Workspace, "id">>;

const FIND_BY_ID_SQL = `SELECT * FROM ${TABLE} WHERE id = ?`;
const FIND_ALL_SQL = `SELECT * FROM ${TABLE} ORDER BY rowid`;
const INSERT_SQL = `INSERT INTO ${TABLE} (id, project_id, task_id, name, branch, worktree_path, storage_key, status, created_at, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const DELETE_SQL = `DELETE FROM ${TABLE} WHERE id = ?`;

/** 可更新列白名单（字段→列）；列名静态、值一律参数化。 */
const UPDATABLE_COLUMNS: ReadonlyArray<readonly [keyof WorkspacePatch & string, string]> = [
  ["projectId", "project_id"],
  ["taskId", "task_id"],
  ["name", "name"],
  ["branch", "branch"],
  ["worktreePath", "worktree_path"],
  ["storageKey", "storage_key"],
  ["status", "status"],
  ["createdAt", "created_at"],
  ["releasedAt", "released_at"],
];

const ROW_CONTEXT = { table: TABLE, operation: "mapRow" } as const;

function mapWorkspaceRow(row: Record<string, unknown>): Workspace {
  const id = readString(row, "id", ROW_CONTEXT);
  const projectId = readString(row, "project_id", ROW_CONTEXT);
  const taskId = readNullableString(row, "task_id", ROW_CONTEXT);
  const name = readString(row, "name", ROW_CONTEXT);
  const branch = readString(row, "branch", ROW_CONTEXT);
  const worktreePath = readString(row, "worktree_path", ROW_CONTEXT);
  const storageKey = readString(row, "storage_key", ROW_CONTEXT);
  const status = readEnum(row, "status", WorkspaceStatusSchema.options, ROW_CONTEXT);
  const createdAt = readString(row, "created_at", ROW_CONTEXT);
  const releasedAt = readNullableString(row, "released_at", ROW_CONTEXT);
  return {
    id,
    projectId,
    taskId,
    name,
    branch,
    worktreePath,
    storageKey,
    status,
    createdAt,
    releasedAt,
  };
}

export class WorkspaceRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 崩溃恢复扫描口径：creating / deleting / orphaned（SYSTEM_DESIGN §4.2）。 */
  findByStatuses(statuses: readonly WorkspaceStatus[]): Workspace[] {
    if (statuses.length === 0) {
      return [];
    }
    // 占位符仅按数量生成（`?` 列表），状态值一律参数化
    const placeholders = statuses.map(() => "?").join(", ");
    const sql = `SELECT * FROM ${TABLE} WHERE status IN (${placeholders}) ORDER BY rowid`;
    try {
      const rows = this.db.prepare(sql).all(...statuses);
      return rows.map(mapWorkspaceRow);
    } catch (error) {
      throw toStorageError(error, {
        operation: "findByStatuses",
        table: TABLE,
        message: "无法按状态读取工作区",
      });
    }
  }

  findAll(): Workspace[] {
    try {
      const rows = this.db.prepare(FIND_ALL_SQL).all();
      return rows.map(mapWorkspaceRow);
    } catch (error) {
      throw toStorageError(error, {
        operation: "findAll",
        table: TABLE,
        message: "无法读取工作区列表",
      });
    }
  }

  findById(id: string): Workspace | null {
    try {
      const row = this.db.prepare(FIND_BY_ID_SQL).get(id);
      if (row === undefined) {
        return null;
      }
      return mapWorkspaceRow(row);
    } catch (error) {
      throw toStorageError(error, {
        operation: "findById",
        table: TABLE,
        entityId: id,
        message: "无法读取工作区",
      });
    }
  }

  create(input: WorkspaceCreateInput): Workspace {
    const id = randomUUID();
    const projectId = input.projectId;
    const taskId = input.taskId ?? null;
    const name = input.name;
    const branch = input.branch;
    const worktreePath = input.worktreePath;
    const storageKey = input.storageKey;
    const status = input.status ?? "reserved";
    const createdAt = nowIso();
    const releasedAt = input.releasedAt ?? null;
    try {
      this.db
        .prepare(INSERT_SQL)
        .run(
          id,
          projectId,
          taskId,
          name,
          branch,
          worktreePath,
          storageKey,
          status,
          createdAt,
          releasedAt,
        );
      return this.requireById(id, "create");
    } catch (error) {
      throw toStorageError(error, {
        operation: "create",
        table: TABLE,
        entityId: id,
        message: "无法创建工作区",
      });
    }
  }

  update(id: string, patch: WorkspacePatch): Workspace | null {
    const built = buildUpdateStatement(TABLE, UPDATABLE_COLUMNS, id, patch, {
      table: TABLE,
      operation: "update",
    });
    try {
      if (built !== null) {
        this.db.prepare(built.sql).run(...built.params);
      }
      return this.findById(id);
    } catch (error) {
      throw toStorageError(error, {
        operation: "update",
        table: TABLE,
        entityId: id,
        message: "无法更新工作区",
      });
    }
  }

  delete(id: string): boolean {
    try {
      const result = this.db.prepare(DELETE_SQL).run(id);
      return result.changes > 0;
    } catch (error) {
      throw toStorageError(error, {
        operation: "delete",
        table: TABLE,
        entityId: id,
        message: "无法删除工作区",
      });
    }
  }

  private requireById(id: string, operation: string): Workspace {
    const found = this.findById(id);
    if (found === null) {
      throw new StorageError({
        operation,
        table: TABLE,
        entityId: id,
        message: "工作区写入后无法读回",
      });
    }
    return found;
  }
}
