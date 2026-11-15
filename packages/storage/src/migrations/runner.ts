import type { DatabaseSync } from "node:sqlite";
import { StorageError } from "../errors.js";
import { nowIso } from "../time.js";
import type { Migration } from "./types.js";
import { V1_MIGRATION } from "./v1.js";

/** 与 §4.2 DDL 的 schema_migrations 一致；runner 自身确保存在（IF NOT EXISTS）。 */
const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

const SELECT_APPLIED_SQL = "SELECT version FROM schema_migrations";
const INSERT_VERSION_SQL =
  "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)";

/** 基础迁移注册表；调用方可注入附加（如测试用）迁移：runMigrations(db, [...BASE_MIGRATIONS, v2])。 */
export const BASE_MIGRATIONS: readonly Migration[] = [V1_MIGRATION];

/**
 * 逐级应用未执行的迁移：建 schema_migrations（若不存在）→ 查已应用版本 →
 * 每个未应用迁移在单事务内执行 up + 写 applied_at。幂等：重复调用零副作用。
 * @returns 本次实际应用的迁移数
 */
export function runMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[] = BASE_MIGRATIONS,
): number {
  const sorted = [...migrations].sort((a, b) => a.version - b.version); // 不可变：复制后排序
  assertUniqueVersions(sorted);
  db.exec(SCHEMA_MIGRATIONS_DDL);
  const applied = readAppliedVersions(db);
  let appliedNow = 0;
  for (const migration of sorted) {
    if (applied.has(migration.version)) {
      continue;
    }
    applyInTransaction(db, migration);
    appliedNow += 1;
  }
  return appliedNow;
}

function assertUniqueVersions(migrations: readonly Migration[]): void {
  const seen = new Set<number>();
  for (const migration of migrations) {
    const version = migration.version;
    if (seen.has(version)) {
      throw new StorageError({
        operation: "migrate",
        table: "schema_migrations",
        entityId: version,
        message: `迁移版本号重复（v${version}），无法确定迁移链`,
      });
    }
    seen.add(version);
  }
}

function readAppliedVersions(db: DatabaseSync): Set<number> {
  const rows = db.prepare(SELECT_APPLIED_SQL).all();
  const versions = new Set<number>();
  for (const row of rows) {
    const version = row.version;
    if (typeof version === "number") {
      versions.add(version);
    } else if (typeof version === "bigint") {
      versions.add(Number(version));
    } else {
      throw new StorageError({
        operation: "migrate",
        table: "schema_migrations",
        message: "已应用版本记录损坏（version 非数值）",
        detail: row,
      });
    }
  }
  return versions;
}

function applyInTransaction(db: DatabaseSync, migration: Migration): void {
  const version = migration.version;
  const name = migration.name;
  try {
    db.exec("BEGIN IMMEDIATE");
    migration.up(db);
    db.prepare(INSERT_VERSION_SQL).run(version, name, nowIso());
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 回滚本身失败（连接异常等极端场景）时保留原始错误
    }
    throw new StorageError({
      operation: "migrate",
      table: "schema_migrations",
      entityId: version,
      message: `数据库迁移失败（v${version} ${name}），已回滚`,
      detail: error,
    });
  }
}
