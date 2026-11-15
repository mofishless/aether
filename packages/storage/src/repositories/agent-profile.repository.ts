import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentProfile } from "@aether/contracts";
import { StorageError, toStorageError } from "../errors.js";
import { buildUpdateStatement, readNullableString, readString } from "../row-mapping.js";
import { nowIso } from "../time.js";

const TABLE = "agent_profile";

export interface AgentProfileCreateInput {
  projectId: string | null; // NULL = 全局可用
  name: string;
  providerConfigId: string;
  model?: string | null;
  persona?: string;
  autonomyJson?: string;
}

/** PATCH 语义：只更新给出的字段；id 不可更新。 */
export type AgentProfilePatch = Partial<Omit<AgentProfile, "id">>;

const FIND_BY_ID_SQL = `SELECT * FROM ${TABLE} WHERE id = ?`;
const FIND_ALL_SQL = `SELECT * FROM ${TABLE} ORDER BY rowid`;
const INSERT_SQL = `INSERT INTO ${TABLE} (id, project_id, name, provider_config_id, model, persona, autonomy_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const DELETE_SQL = `DELETE FROM ${TABLE} WHERE id = ?`;

/** 可更新列白名单（字段→列）；列名静态、值一律参数化。 */
const UPDATABLE_COLUMNS: ReadonlyArray<readonly [keyof AgentProfilePatch & string, string]> = [
  ["projectId", "project_id"],
  ["name", "name"],
  ["providerConfigId", "provider_config_id"],
  ["model", "model"],
  ["persona", "persona"],
  ["autonomyJson", "autonomy_json"],
  ["createdAt", "created_at"],
  ["updatedAt", "updated_at"],
];

const ROW_CONTEXT = { table: TABLE, operation: "mapRow" } as const;

function mapAgentProfileRow(row: Record<string, unknown>): AgentProfile {
  const id = readString(row, "id", ROW_CONTEXT);
  const projectId = readNullableString(row, "project_id", ROW_CONTEXT);
  const name = readString(row, "name", ROW_CONTEXT);
  const providerConfigId = readString(row, "provider_config_id", ROW_CONTEXT);
  const model = readNullableString(row, "model", ROW_CONTEXT);
  const persona = readString(row, "persona", ROW_CONTEXT);
  const autonomyJson = readString(row, "autonomy_json", ROW_CONTEXT);
  const createdAt = readString(row, "created_at", ROW_CONTEXT);
  const updatedAt = readString(row, "updated_at", ROW_CONTEXT);
  return {
    id,
    projectId,
    name,
    providerConfigId,
    model,
    persona,
    autonomyJson,
    createdAt,
    updatedAt,
  };
}

export class AgentProfileRepository {
  constructor(private readonly db: DatabaseSync) {}

  findAll(): AgentProfile[] {
    try {
      const rows = this.db.prepare(FIND_ALL_SQL).all();
      return rows.map(mapAgentProfileRow);
    } catch (error) {
      throw toStorageError(error, {
        operation: "findAll",
        table: TABLE,
        message: "无法读取 agent 配置档列表",
      });
    }
  }

  findById(id: string): AgentProfile | null {
    try {
      const row = this.db.prepare(FIND_BY_ID_SQL).get(id);
      if (row === undefined) {
        return null;
      }
      return mapAgentProfileRow(row);
    } catch (error) {
      throw toStorageError(error, {
        operation: "findById",
        table: TABLE,
        entityId: id,
        message: "无法读取 agent 配置档",
      });
    }
  }

  create(input: AgentProfileCreateInput): AgentProfile {
    const id = randomUUID();
    const projectId = input.projectId;
    const name = input.name;
    const providerConfigId = input.providerConfigId;
    const model = input.model ?? null;
    const persona = input.persona ?? "";
    const autonomyJson = input.autonomyJson ?? "{}";
    const now = nowIso();
    try {
      this.db
        .prepare(INSERT_SQL)
        .run(id, projectId, name, providerConfigId, model, persona, autonomyJson, now, now);
      return this.requireById(id, "create");
    } catch (error) {
      throw toStorageError(error, {
        operation: "create",
        table: TABLE,
        entityId: id,
        message: "无法创建 agent 配置档",
      });
    }
  }

  update(id: string, patch: AgentProfilePatch): AgentProfile | null {
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
        message: "无法更新 agent 配置档",
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
        message: "无法删除 agent 配置档",
      });
    }
  }

  private requireById(id: string, operation: string): AgentProfile {
    const found = this.findById(id);
    if (found === null) {
      throw new StorageError({
        operation,
        table: TABLE,
        entityId: id,
        message: "agent 配置档写入后无法读回",
      });
    }
    return found;
  }
}
