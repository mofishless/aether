import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { TaskStatusSchema } from "@aether/contracts";
import type { Task } from "@aether/contracts";
import { StorageError, toStorageError } from "../errors.js";
import {
  buildUpdateStatement,
  readEnum,
  readNullableString,
  readNumber,
  readString,
} from "../row-mapping.js";
import { nowIso } from "../time.js";

const TABLE = "task";

export interface TaskCreateInput {
  projectId: string;
  title: string;
  description?: string;
  status?: Task["status"];
  parentTaskId?: string | null;
  assigneeAgentProfileId?: string | null;
  position?: number;
}

/** PATCH 语义：只更新给出的字段；id 不可更新。 */
export type TaskPatch = Partial<Omit<Task, "id">>;

const FIND_BY_ID_SQL = `SELECT * FROM ${TABLE} WHERE id = ?`;
const FIND_ALL_SQL = `SELECT * FROM ${TABLE} ORDER BY rowid`;
const INSERT_SQL = `INSERT INTO ${TABLE} (id, project_id, parent_task_id, title, description, status, assignee_agent_profile_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const DELETE_SQL = `DELETE FROM ${TABLE} WHERE id = ?`;

/** 可更新列白名单（字段→列）；列名静态、值一律参数化。 */
const UPDATABLE_COLUMNS: ReadonlyArray<readonly [keyof TaskPatch & string, string]> = [
  ["projectId", "project_id"],
  ["parentTaskId", "parent_task_id"],
  ["title", "title"],
  ["description", "description"],
  ["status", "status"],
  ["assigneeAgentProfileId", "assignee_agent_profile_id"],
  ["position", "position"],
  ["createdAt", "created_at"],
  ["updatedAt", "updated_at"],
];

const ROW_CONTEXT = { table: TABLE, operation: "mapRow" } as const;

function mapTaskRow(row: Record<string, unknown>): Task {
  const id = readString(row, "id", ROW_CONTEXT);
  const projectId = readString(row, "project_id", ROW_CONTEXT);
  const parentTaskId = readNullableString(row, "parent_task_id", ROW_CONTEXT);
  const title = readString(row, "title", ROW_CONTEXT);
  const description = readString(row, "description", ROW_CONTEXT);
  const status = readEnum(row, "status", TaskStatusSchema.options, ROW_CONTEXT);
  const assigneeAgentProfileId = readNullableString(row, "assignee_agent_profile_id", ROW_CONTEXT);
  const position = readNumber(row, "position", ROW_CONTEXT);
  const createdAt = readString(row, "created_at", ROW_CONTEXT);
  const updatedAt = readString(row, "updated_at", ROW_CONTEXT);
  return {
    id,
    projectId,
    parentTaskId,
    title,
    description,
    status,
    assigneeAgentProfileId,
    position,
    createdAt,
    updatedAt,
  };
}

export class TaskRepository {
  constructor(private readonly db: DatabaseSync) {}

  findAll(): Task[] {
    try {
      const rows = this.db.prepare(FIND_ALL_SQL).all();
      return rows.map(mapTaskRow);
    } catch (error) {
      throw toStorageError(error, {
        operation: "findAll",
        table: TABLE,
        message: "无法读取任务列表",
      });
    }
  }

  findById(id: string): Task | null {
    try {
      const row = this.db.prepare(FIND_BY_ID_SQL).get(id);
      if (row === undefined) {
        return null;
      }
      return mapTaskRow(row);
    } catch (error) {
      throw toStorageError(error, {
        operation: "findById",
        table: TABLE,
        entityId: id,
        message: "无法读取任务",
      });
    }
  }

  create(input: TaskCreateInput): Task {
    const id = randomUUID();
    const projectId = input.projectId;
    const title = input.title;
    const description = input.description ?? "";
    const status = input.status ?? "todo";
    const parentTaskId = input.parentTaskId ?? null;
    const assigneeAgentProfileId = input.assigneeAgentProfileId ?? null;
    const position = input.position ?? 0;
    const now = nowIso();
    try {
      this.db
        .prepare(INSERT_SQL)
        .run(
          id,
          projectId,
          parentTaskId,
          title,
          description,
          status,
          assigneeAgentProfileId,
          position,
          now,
          now,
        );
      return this.requireById(id, "create");
    } catch (error) {
      throw toStorageError(error, {
        operation: "create",
        table: TABLE,
        entityId: id,
        message: "无法创建任务",
      });
    }
  }

  update(id: string, patch: TaskPatch): Task | null {
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
        message: "无法更新任务",
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
        message: "无法删除任务",
      });
    }
  }

  private requireById(id: string, operation: string): Task {
    const found = this.findById(id);
    if (found === null) {
      throw new StorageError({
        operation,
        table: TABLE,
        entityId: id,
        message: "任务写入后无法读回",
      });
    }
    return found;
  }
}
