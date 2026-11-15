import { DatabaseSync } from "node:sqlite";
import { StorageError } from "./errors.js";
import { runMigrations } from "./migrations/runner.js";
import { seedDefaults } from "./seed.js";

/** 连接后固定执行的 PRAGMA 三连（SYSTEM_DESIGN §4.1）。 */
const CONNECTION_PRAGMAS =
  "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;";

/** 打开连接并固定执行 PRAGMA 三连；支持 ':memory:'。 */
export function openDatabase(path: string): DatabaseSync {
  try {
    const db = new DatabaseSync(path);
    db.exec(CONNECTION_PRAGMAS);
    return db;
  } catch (error) {
    throw new StorageError({
      operation: "open",
      table: "database",
      message: `无法打开数据库（${path}）`,
      detail: error,
    });
  }
}

/** 引导入口：openDatabase + runMigrations + seedDefaults。 */
export function openStorage(path: string): DatabaseSync {
  const db = openDatabase(path);
  runMigrations(db);
  seedDefaults(db);
  return db;
}

export function closeDatabase(db: DatabaseSync): void {
  try {
    db.close();
  } catch (error) {
    throw new StorageError({
      operation: "close",
      table: "database",
      message: "关闭数据库失败",
      detail: error,
    });
  }
}
