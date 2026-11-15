import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ProviderConfigKindSchema } from "@aether/contracts";
import type { ProviderConfig, ProviderConfigKind } from "@aether/contracts";
import { StorageError, toStorageError } from "../errors.js";
import { buildUpdateStatement, readEnum, readString } from "../row-mapping.js";
import { nowIso } from "../time.js";

const TABLE = "provider_config";

export interface ProviderConfigCreateInput {
  kind: ProviderConfigKind;
  displayName: string;
  configJson?: string;
}

/** PATCH 语义：只更新给出的字段；id 不可更新。 */
export type ProviderConfigPatch = Partial<Omit<ProviderConfig, "id">>;

const FIND_BY_ID_SQL = `SELECT * FROM ${TABLE} WHERE id = ?`;
const FIND_ALL_SQL = `SELECT * FROM ${TABLE} ORDER BY rowid`;
const INSERT_SQL = `INSERT INTO ${TABLE} (id, kind, display_name, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`;
const DELETE_SQL = `DELETE FROM ${TABLE} WHERE id = ?`;

/** 可更新列白名单（字段→列）；列名静态、值一律参数化。 */
const UPDATABLE_COLUMNS: ReadonlyArray<readonly [keyof ProviderConfigPatch & string, string]> = [
  ["kind", "kind"],
  ["displayName", "display_name"],
  ["configJson", "config_json"],
  ["createdAt", "created_at"],
  ["updatedAt", "updated_at"],
];

const ROW_CONTEXT = { table: TABLE, operation: "mapRow" } as const;

function mapProviderConfigRow(row: Record<string, unknown>): ProviderConfig {
  const id = readString(row, "id", ROW_CONTEXT);
  const kind = readEnum(row, "kind", ProviderConfigKindSchema.options, ROW_CONTEXT);
  const displayName = readString(row, "display_name", ROW_CONTEXT);
  const configJson = readString(row, "config_json", ROW_CONTEXT);
  const createdAt = readString(row, "created_at", ROW_CONTEXT);
  const updatedAt = readString(row, "updated_at", ROW_CONTEXT);
  return { id, kind, displayName, configJson, createdAt, updatedAt };
}

export class ProviderConfigRepository {
  constructor(private readonly db: DatabaseSync) {}

  findAll(): ProviderConfig[] {
    try {
      const rows = this.db.prepare(FIND_ALL_SQL).all();
      return rows.map(mapProviderConfigRow);
    } catch (error) {
      throw toStorageError(error, {
        operation: "findAll",
        table: TABLE,
        message: "无法读取 provider 配置列表",
      });
    }
  }

  findById(id: string): ProviderConfig | null {
    try {
      const row = this.db.prepare(FIND_BY_ID_SQL).get(id);
      if (row === undefined) {
        return null;
      }
      return mapProviderConfigRow(row);
    } catch (error) {
      throw toStorageError(error, {
        operation: "findById",
        table: TABLE,
        entityId: id,
        message: "无法读取 provider 配置",
      });
    }
  }

  create(input: ProviderConfigCreateInput): ProviderConfig {
    const id = randomUUID();
    const kind = input.kind;
    const displayName = input.displayName;
    const configJson = input.configJson ?? "{}";
    const now = nowIso();
    try {
      this.db.prepare(INSERT_SQL).run(id, kind, displayName, configJson, now, now);
      return this.requireById(id, "create");
    } catch (error) {
      throw toStorageError(error, {
        operation: "create",
        table: TABLE,
        entityId: id,
        message: "无法创建 provider 配置",
      });
    }
  }

  update(id: string, patch: ProviderConfigPatch): ProviderConfig | null {
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
        message: "无法更新 provider 配置",
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
        message: "无法删除 provider 配置",
      });
    }
  }

  private requireById(id: string, operation: string): ProviderConfig {
    const found = this.findById(id);
    if (found === null) {
      throw new StorageError({
        operation,
        table: TABLE,
        entityId: id,
        message: "provider 配置写入后无法读回",
      });
    }
    return found;
  }
}
