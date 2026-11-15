import type { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import {
  BASE_MIGRATIONS,
  closeDatabase,
  openDatabase,
  openStorage,
  runMigrations,
} from "../src/index.js";
import type { Migration } from "../src/index.js";
import { countRows, createDbTestContext, sqliteObjectNames } from "./helpers.js";

const P0_TABLES = [
  "project",
  "task",
  "workspace",
  "provider_config",
  "agent_profile",
  "session",
  "execution_process",
  "execution_process_log",
] as const;

const P0_INDEXES = [
  "idx_task_project_status",
  "idx_workspace_project",
  "idx_session_workspace",
  "idx_process_session",
  "idx_logs_process_seq",
] as const;

/** 测试注入的哨兵迁移：证明 v1 → v2 逐级升级。 */
const SENTINEL_V2: Migration = {
  version: 2,
  name: "test_sentinel_v2",
  up: (db: DatabaseSync): void => {
    db.exec("CREATE TABLE migration_sentinel_v2 (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
    db.prepare("INSERT INTO migration_sentinel_v2 (note) VALUES (?)").run("v2 applied");
  },
};

/** 测试注入的失败迁移：证明 up 中途抛错时整单事务回滚。 */
const FAILING_V3: Migration = {
  version: 3,
  name: "test_failing_v3",
  up: (db: DatabaseSync): void => {
    db.exec("CREATE TABLE migration_failing_v3 (id INTEGER PRIMARY KEY)");
    db.prepare("INSERT INTO migration_failing_v3 (id) VALUES (?)").run(1);
    throw new Error("migration v3 boom");
  },
};

describe("迁移链", () => {
  const ctx = createDbTestContext();
  afterAll(() => ctx.dispose());

  it("全新文件库 openStorage 建齐 P0 全部 8 表与索引", () => {
    const db = ctx.track(openStorage(ctx.nextDbPath()));
    const objects = sqliteObjectNames(db);
    for (const table of [...P0_TABLES, "schema_migrations"]) {
      expect(objects.has(table), `缺少表 ${table}`).toBe(true);
    }
    for (const index of P0_INDEXES) {
      expect(objects.has(index), `缺少索引 ${index}`).toBe(true);
    }
  });

  it("P2 表（mailbox/layout_snapshot/session_snapshot）本期不建", () => {
    const db = ctx.track(openStorage(":memory:"));
    const objects = sqliteObjectNames(db);
    expect(objects.has("mailbox")).toBe(false);
    expect(objects.has("layout_snapshot")).toBe(false);
    expect(objects.has("session_snapshot")).toBe(false);
  });

  it("重复 runMigrations 幂等：不报错、版本行数不变、返回 0", () => {
    const db = ctx.track(openStorage(":memory:"));
    expect(runMigrations(db)).toBe(0);
    expect(runMigrations(db)).toBe(0);
    expect(countRows(db, "schema_migrations")).toBe(1);
  });

  it("注入 v2 哨兵迁移：v1→v2 逐级升级且 v1 数据不丢", () => {
    const db = ctx.track(openStorage(ctx.nextDbPath())); // v1 已应用 + 种子已插入
    const withV2: readonly Migration[] = [...BASE_MIGRATIONS, SENTINEL_V2];
    expect(runMigrations(db, withV2)).toBe(1);
    expect(sqliteObjectNames(db).has("migration_sentinel_v2")).toBe(true);
    expect(countRows(db, "migration_sentinel_v2")).toBe(1);
    expect(countRows(db, "schema_migrations")).toBe(2);
    expect(countRows(db, "provider_config")).toBe(1); // v1 数据仍在
    expect(runMigrations(db, withV2)).toBe(0); // 再跑幂等
    expect(countRows(db, "schema_migrations")).toBe(2);
  });

  it("失败的迁移整体回滚：哨兵表未建、版本未登记", () => {
    const db = ctx.track(openStorage(":memory:"));
    const withV3: readonly Migration[] = [...BASE_MIGRATIONS, FAILING_V3];
    expect(() => runMigrations(db, withV3)).toThrow();
    expect(sqliteObjectNames(db).has("migration_failing_v3")).toBe(false);
    expect(countRows(db, "schema_migrations")).toBe(1); // 仅 v1
  });

  it("openStorage 同一文件库二次引导幂等（版本与种子均不重复）", () => {
    const path = ctx.nextDbPath();
    const first = ctx.track(openStorage(path));
    closeDatabase(first);
    const second = ctx.track(openStorage(path));
    expect(countRows(second, "schema_migrations")).toBe(1);
    expect(countRows(second, "provider_config")).toBe(1);
    expect(countRows(second, "agent_profile")).toBe(1);
  });

  it("openDatabase(':memory:') + runMigrations 亦可建表", () => {
    const db = ctx.track(openDatabase(":memory:"));
    expect(sqliteObjectNames(db).has("project")).toBe(false);
    expect(runMigrations(db)).toBe(1);
    expect(sqliteObjectNames(db).has("project")).toBe(true);
  });
});
