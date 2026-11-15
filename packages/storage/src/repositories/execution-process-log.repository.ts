import type { DatabaseSync } from "node:sqlite";
import type { ExecutionProcessLog } from "@aether/contracts";
import { StorageError, toStorageError } from "../errors.js";
import {
  buildUpdateStatement,
  readNullableString,
  readNumber,
  readString,
} from "../row-mapping.js";
import { nowIso } from "../time.js";

const TABLE = "execution_process_log";

export interface ExecutionProcessLogCreateInput {
  processId: string;
  seq: number;
  rawJson: string;
  normalizedJson?: string | null;
}

/** PATCH 语义：只更新给出的字段；id（rowid）不可更新。 */
export type ExecutionProcessLogPatch = Partial<Omit<ExecutionProcessLog, "id">>;

const FIND_BY_ID_SQL = `SELECT * FROM ${TABLE} WHERE id = ?`;
const FIND_ALL_SQL = `SELECT * FROM ${TABLE} ORDER BY rowid`;
const INSERT_SQL = `INSERT INTO ${TABLE} (process_id, seq, raw_json, normalized_json, created_at) VALUES (?, ?, ?, ?, ?)`;
const DELETE_SQL = `DELETE FROM ${TABLE} WHERE id = ?`;

/** 可更新列白名单（字段→列）；列名静态、值一律参数化。 */
const UPDATABLE_COLUMNS: ReadonlyArray<readonly [keyof ExecutionProcessLogPatch & string, string]> =
  [
    ["processId", "process_id"],
    ["seq", "seq"],
    ["rawJson", "raw_json"],
    ["normalizedJson", "normalized_json"],
    ["createdAt", "created_at"],
  ];

const ROW_CONTEXT = { table: TABLE, operation: "mapRow" } as const;

function mapLogRow(row: Record<string, unknown>): ExecutionProcessLog {
  const id = readNumber(row, "id", ROW_CONTEXT);
  const processId = readString(row, "process_id", ROW_CONTEXT);
  const seq = readNumber(row, "seq", ROW_CONTEXT);
  const rawJson = readString(row, "raw_json", ROW_CONTEXT);
  const normalizedJson = readNullableString(row, "normalized_json", ROW_CONTEXT);
  const createdAt = readString(row, "created_at", ROW_CONTEXT);
  return { id, processId, seq, rawJson, normalizedJson, createdAt };
}

export class ExecutionProcessLogRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * §4.4 批量写路径：daemon 内存缓冲定时/定量 flush 落库。
   * 单事务批量 INSERT；任一行失败（如外键非法）整批回滚。
   * @returns 实际写入行数
   */
  appendBatch(rows: readonly ExecutionProcessLogCreateInput[]): number {
    if (rows.length === 0) {
      return 0;
    }
    const createdAt = nowIso();
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const insert = this.db.prepare(INSERT_SQL);
      for (const row of rows) {
        const processId = row.processId;
        const seq = row.seq;
        const rawJson = row.rawJson;
        const normalizedJson = row.normalizedJson ?? null;
        insert.run(processId, seq, rawJson, normalizedJson, createdAt);
      }
      this.db.exec("COMMIT");
      return rows.length;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 回滚本身失败（连接异常等极端场景）时保留原始错误
      }
      throw new StorageError({
        operation: "appendBatch",
        table: TABLE,
        message: "日志批量写入失败，已整批回滚",
        detail: { rowCount: rows.length, cause: error },
      });
    }
  }

  findAll(): ExecutionProcessLog[] {
    try {
      const rows = this.db.prepare(FIND_ALL_SQL).all();
      return rows.map(mapLogRow);
    } catch (error) {
      throw toStorageError(error, {
        operation: "findAll",
        table: TABLE,
        message: "无法读取进程日志",
      });
    }
  }

  findById(id: number): ExecutionProcessLog | null {
    try {
      const row = this.db.prepare(FIND_BY_ID_SQL).get(id);
      if (row === undefined) {
        return null;
      }
      return mapLogRow(row);
    } catch (error) {
      throw toStorageError(error, {
        operation: "findById",
        table: TABLE,
        entityId: id,
        message: "无法读取进程日志",
      });
    }
  }

  /** 单行写入（rowid 主键由库分配；id 业务上不可指定）。 */
  create(input: ExecutionProcessLogCreateInput): ExecutionProcessLog {
    const processId = input.processId;
    const seq = input.seq;
    const rawJson = input.rawJson;
    const normalizedJson = input.normalizedJson ?? null;
    const createdAt = nowIso();
    try {
      const result = this.db
        .prepare(INSERT_SQL)
        .run(processId, seq, rawJson, normalizedJson, createdAt);
      const id = Number(result.lastInsertRowid);
      return this.requireById(id, "create");
    } catch (error) {
      throw toStorageError(error, {
        operation: "create",
        table: TABLE,
        message: "无法写入进程日志",
      });
    }
  }

  update(id: number, patch: ExecutionProcessLogPatch): ExecutionProcessLog | null {
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
        message: "无法更新进程日志",
      });
    }
  }

  delete(id: number): boolean {
    try {
      const result = this.db.prepare(DELETE_SQL).run(id);
      return result.changes > 0;
    } catch (error) {
      throw toStorageError(error, {
        operation: "delete",
        table: TABLE,
        entityId: id,
        message: "无法删除进程日志",
      });
    }
  }

  private requireById(id: number, operation: string): ExecutionProcessLog {
    const found = this.findById(id);
    if (found === null) {
      throw new StorageError({
        operation,
        table: TABLE,
        entityId: id,
        message: "进程日志写入后无法读回",
      });
    }
    return found;
  }
}
