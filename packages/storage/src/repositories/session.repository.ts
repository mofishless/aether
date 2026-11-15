import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AgentStatusSchema } from "@aether/contracts";
import type { AgentStatus, Session } from "@aether/contracts";
import { StorageError, toStorageError } from "../errors.js";
import { buildUpdateStatement, readEnum, readNullableString, readString } from "../row-mapping.js";
import { nowIso } from "../time.js";

const TABLE = "session";

export interface SessionCreateInput {
  workspaceId: string;
  agentProfileId: string;
  externalSessionId?: string | null;
  status?: AgentStatus;
  lineageParentId?: string | null;
  checkpointRef?: string | null;
}

/** PATCH 语义：只更新给出的字段；id 不可更新。 */
export type SessionPatch = Partial<Omit<Session, "id">>;

const FIND_BY_ID_SQL = `SELECT * FROM ${TABLE} WHERE id = ?`;
const FIND_ALL_SQL = `SELECT * FROM ${TABLE} ORDER BY rowid`;
const INSERT_SQL = `INSERT INTO ${TABLE} (id, workspace_id, agent_profile_id, external_session_id, status, lineage_parent_id, checkpoint_ref, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const DELETE_SQL = `DELETE FROM ${TABLE} WHERE id = ?`;
const TOUCH_STATUS_SQL = `UPDATE ${TABLE} SET status = ?, last_active_at = ? WHERE id = ?`;

/** 可更新列白名单（字段→列）；列名静态、值一律参数化。 */
const UPDATABLE_COLUMNS: ReadonlyArray<readonly [keyof SessionPatch & string, string]> = [
  ["workspaceId", "workspace_id"],
  ["agentProfileId", "agent_profile_id"],
  ["externalSessionId", "external_session_id"],
  ["status", "status"],
  ["lineageParentId", "lineage_parent_id"],
  ["checkpointRef", "checkpoint_ref"],
  ["createdAt", "created_at"],
  ["lastActiveAt", "last_active_at"],
];

const ROW_CONTEXT = { table: TABLE, operation: "mapRow" } as const;

function mapSessionRow(row: Record<string, unknown>): Session {
  const id = readString(row, "id", ROW_CONTEXT);
  const workspaceId = readString(row, "workspace_id", ROW_CONTEXT);
  const agentProfileId = readString(row, "agent_profile_id", ROW_CONTEXT);
  const externalSessionId = readNullableString(row, "external_session_id", ROW_CONTEXT);
  const status = readEnum(row, "status", AgentStatusSchema.options, ROW_CONTEXT);
  const lineageParentId = readNullableString(row, "lineage_parent_id", ROW_CONTEXT);
  const checkpointRef = readNullableString(row, "checkpoint_ref", ROW_CONTEXT);
  const createdAt = readString(row, "created_at", ROW_CONTEXT);
  const lastActiveAt = readString(row, "last_active_at", ROW_CONTEXT);
  return {
    id,
    workspaceId,
    agentProfileId,
    externalSessionId,
    status,
    lineageParentId,
    checkpointRef,
    createdAt,
    lastActiveAt,
  };
}

export class SessionRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** 更新 status 与 last_active_at（活动心跳写路径）。 */
  touchStatus(id: string, status: AgentStatus): Session | null {
    const lastActiveAt = nowIso();
    try {
      this.db.prepare(TOUCH_STATUS_SQL).run(status, lastActiveAt, id);
      return this.findById(id);
    } catch (error) {
      throw toStorageError(error, {
        operation: "touchStatus",
        table: TABLE,
        entityId: id,
        message: "无法更新会话状态",
      });
    }
  }

  findAll(): Session[] {
    try {
      const rows = this.db.prepare(FIND_ALL_SQL).all();
      return rows.map(mapSessionRow);
    } catch (error) {
      throw toStorageError(error, {
        operation: "findAll",
        table: TABLE,
        message: "无法读取会话列表",
      });
    }
  }

  findById(id: string): Session | null {
    try {
      const row = this.db.prepare(FIND_BY_ID_SQL).get(id);
      if (row === undefined) {
        return null;
      }
      return mapSessionRow(row);
    } catch (error) {
      throw toStorageError(error, {
        operation: "findById",
        table: TABLE,
        entityId: id,
        message: "无法读取会话",
      });
    }
  }

  create(input: SessionCreateInput): Session {
    const id = randomUUID();
    const workspaceId = input.workspaceId;
    const agentProfileId = input.agentProfileId;
    const externalSessionId = input.externalSessionId ?? null;
    const status = input.status ?? "starting";
    const lineageParentId = input.lineageParentId ?? null;
    const checkpointRef = input.checkpointRef ?? null;
    const now = nowIso();
    try {
      this.db
        .prepare(INSERT_SQL)
        .run(
          id,
          workspaceId,
          agentProfileId,
          externalSessionId,
          status,
          lineageParentId,
          checkpointRef,
          now,
          now,
        );
      return this.requireById(id, "create");
    } catch (error) {
      throw toStorageError(error, {
        operation: "create",
        table: TABLE,
        entityId: id,
        message: "无法创建会话",
      });
    }
  }

  update(id: string, patch: SessionPatch): Session | null {
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
        message: "无法更新会话",
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
        message: "无法删除会话",
      });
    }
  }

  private requireById(id: string, operation: string): Session {
    const found = this.findById(id);
    if (found === null) {
      throw new StorageError({
        operation,
        table: TABLE,
        entityId: id,
        message: "会话写入后无法读回",
      });
    }
    return found;
  }
}
