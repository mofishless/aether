import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Project } from "@aether/contracts";
import { StorageError, toStorageError } from "../errors.js";
import { buildUpdateStatement, readNullableString, readString } from "../row-mapping.js";
import { nowIso } from "../time.js";

const TABLE = "project";

export interface ProjectCreateInput {
  name: string;
  rootPath: string;
  gitDefaultBranch?: string;
  settingsJson?: string;
  archivedAt?: string | null;
}

/** PATCH 语义：只更新给出的字段；id 不可更新。 */
export type ProjectPatch = Partial<Omit<Project, "id">>;

const FIND_BY_ID_SQL = `SELECT * FROM ${TABLE} WHERE id = ?`;
const FIND_ALL_SQL = `SELECT * FROM ${TABLE} ORDER BY rowid`;
const INSERT_SQL = `INSERT INTO ${TABLE} (id, name, root_path, git_default_branch, settings_json, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;
const DELETE_SQL = `DELETE FROM ${TABLE} WHERE id = ?`;

/** 可更新列白名单（字段→列）；列名静态、值一律参数化。 */
const UPDATABLE_COLUMNS: ReadonlyArray<readonly [keyof ProjectPatch & string, string]> = [
  ["name", "name"],
  ["rootPath", "root_path"],
  ["gitDefaultBranch", "git_default_branch"],
  ["settingsJson", "settings_json"],
  ["createdAt", "created_at"],
  ["archivedAt", "archived_at"],
];

const ROW_CONTEXT = { table: TABLE, operation: "mapRow" } as const;

function mapProjectRow(row: Record<string, unknown>): Project {
  const id = readString(row, "id", ROW_CONTEXT);
  const name = readString(row, "name", ROW_CONTEXT);
  const rootPath = readString(row, "root_path", ROW_CONTEXT);
  const gitDefaultBranch = readString(row, "git_default_branch", ROW_CONTEXT);
  const settingsJson = readString(row, "settings_json", ROW_CONTEXT);
  const createdAt = readString(row, "created_at", ROW_CONTEXT);
  const archivedAt = readNullableString(row, "archived_at", ROW_CONTEXT);
  return { id, name, rootPath, gitDefaultBranch, settingsJson, createdAt, archivedAt };
}

export class ProjectRepository {
  constructor(private readonly db: DatabaseSync) {}

  findAll(): Project[] {
    try {
      const rows = this.db.prepare(FIND_ALL_SQL).all();
      return rows.map(mapProjectRow);
    } catch (error) {
      throw toStorageError(error, {
        operation: "findAll",
        table: TABLE,
        message: "无法读取项目列表",
      });
    }
  }

  findById(id: string): Project | null {
    try {
      const row = this.db.prepare(FIND_BY_ID_SQL).get(id);
      if (row === undefined) {
        return null;
      }
      return mapProjectRow(row);
    } catch (error) {
      throw toStorageError(error, {
        operation: "findById",
        table: TABLE,
        entityId: id,
        message: "无法读取项目",
      });
    }
  }

  create(input: ProjectCreateInput): Project {
    const id = randomUUID();
    const name = input.name;
    const rootPath = input.rootPath;
    const gitDefaultBranch = input.gitDefaultBranch ?? "main";
    const settingsJson = input.settingsJson ?? "{}";
    const archivedAt = input.archivedAt ?? null;
    const createdAt = nowIso();
    try {
      this.db
        .prepare(INSERT_SQL)
        .run(id, name, rootPath, gitDefaultBranch, settingsJson, createdAt, archivedAt);
      return this.requireById(id, "create");
    } catch (error) {
      throw toStorageError(error, {
        operation: "create",
        table: TABLE,
        entityId: id,
        message: "无法创建项目",
      });
    }
  }

  update(id: string, patch: ProjectPatch): Project | null {
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
        message: "无法更新项目",
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
        message: "无法删除项目",
      });
    }
  }

  private requireById(id: string, operation: string): Project {
    const found = this.findById(id);
    if (found === null) {
      throw new StorageError({
        operation,
        table: TABLE,
        entityId: id,
        message: "项目写入后无法读回",
      });
    }
    return found;
  }
}
