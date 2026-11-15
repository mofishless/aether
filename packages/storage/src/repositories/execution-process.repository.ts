import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ExecutionProcessStatusSchema, RunReasonSchema } from "@aether/contracts";
import type { ExecutionProcess, ExecutionProcessStatus, RunReason } from "@aether/contracts";
import { StorageError, toStorageError } from "../errors.js";
import {
  buildUpdateStatement,
  readEnum,
  readNullableNumber,
  readNullableString,
  readString,
} from "../row-mapping.js";
import { nowIso } from "../time.js";

const TABLE = "execution_process";

export interface ExecutionProcessCreateInput {
  sessionId: string;
  runReason: RunReason;
  commandJson: string;
  pid?: number | null;
  status?: ExecutionProcessStatus;
  exitCode?: number | null;
  endedAt?: string | null;
}

/** PATCH 语义：只更新给出的字段；id 不可更新。 */
export type ExecutionProcessPatch = Partial<Omit<ExecutionProcess, "id">>;

const FIND_BY_ID_SQL = `SELECT * FROM ${TABLE} WHERE id = ?`;
const FIND_ALL_SQL = `SELECT * FROM ${TABLE} ORDER BY rowid`;
const INSERT_SQL = `INSERT INTO ${TABLE} (id, session_id, run_reason, pid, command_json, status, exit_code, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const DELETE_SQL = `DELETE FROM ${TABLE} WHERE id = ?`;

/** 可更新列白名单（字段→列）；列名静态、值一律参数化。 */
const UPDATABLE_COLUMNS: ReadonlyArray<readonly [keyof ExecutionProcessPatch & string, string]> = [
  ["sessionId", "session_id"],
  ["runReason", "run_reason"],
  ["pid", "pid"],
  ["commandJson", "command_json"],
  ["status", "status"],
  ["exitCode", "exit_code"],
  ["startedAt", "started_at"],
  ["endedAt", "ended_at"],
];

const ROW_CONTEXT = { table: TABLE, operation: "mapRow" } as const;

function mapExecutionProcessRow(row: Record<string, unknown>): ExecutionProcess {
  const id = readString(row, "id", ROW_CONTEXT);
  const sessionId = readString(row, "session_id", ROW_CONTEXT);
  const runReason = readEnum(row, "run_reason", RunReasonSchema.options, ROW_CONTEXT);
  const pid = readNullableNumber(row, "pid", ROW_CONTEXT);
  const commandJson = readString(row, "command_json", ROW_CONTEXT);
  const status = readEnum(row, "status", ExecutionProcessStatusSchema.options, ROW_CONTEXT);
  const exitCode = readNullableNumber(row, "exit_code", ROW_CONTEXT);
  const startedAt = readString(row, "started_at", ROW_CONTEXT);
  const endedAt = readNullableString(row, "ended_at", ROW_CONTEXT);
  return {
    id,
    sessionId,
    runReason,
    pid,
    commandJson,
    status,
    exitCode,
    startedAt,
    endedAt,
  };
}

export class ExecutionProcessRepository {
  constructor(private readonly db: DatabaseSync) {}

  findAll(): ExecutionProcess[] {
    try {
      const rows = this.db.prepare(FIND_ALL_SQL).all();
      return rows.map(mapExecutionProcessRow);
    } catch (error) {
      throw toStorageError(error, {
        operation: "findAll",
        table: TABLE,
        message: "无法读取进程列表",
      });
    }
  }

  findById(id: string): ExecutionProcess | null {
    try {
      const row = this.db.prepare(FIND_BY_ID_SQL).get(id);
      if (row === undefined) {
        return null;
      }
      return mapExecutionProcessRow(row);
    } catch (error) {
      throw toStorageError(error, {
        operation: "findById",
        table: TABLE,
        entityId: id,
        message: "无法读取进程",
      });
    }
  }

  create(input: ExecutionProcessCreateInput): ExecutionProcess {
    const id = randomUUID();
    const sessionId = input.sessionId;
    const runReason = input.runReason;
    const pid = input.pid ?? null;
    const commandJson = input.commandJson;
    const status = input.status ?? "running";
    const exitCode = input.exitCode ?? null;
    const startedAt = nowIso();
    const endedAt = input.endedAt ?? null;
    try {
      this.db
        .prepare(INSERT_SQL)
        .run(id, sessionId, runReason, pid, commandJson, status, exitCode, startedAt, endedAt);
      return this.requireById(id, "create");
    } catch (error) {
      throw toStorageError(error, {
        operation: "create",
        table: TABLE,
        entityId: id,
        message: "无法创建进程记录",
      });
    }
  }

  update(id: string, patch: ExecutionProcessPatch): ExecutionProcess | null {
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
        message: "无法更新进程记录",
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
        message: "无法删除进程记录",
      });
    }
  }

  private requireById(id: string, operation: string): ExecutionProcess {
    const found = this.findById(id);
    if (found === null) {
      throw new StorageError({
        operation,
        table: TABLE,
        entityId: id,
        message: "进程记录写入后无法读回",
      });
    }
    return found;
  }
}
