import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";

/** 测试用临时目录 + 连接登记：afterAll 统一先关连接再删目录（Windows 文件锁）。 */
export interface DbTestContext {
  readonly dir: string;
  nextDbPath(): string;
  track(db: DatabaseSync): DatabaseSync;
  dispose(): void;
}

export function createDbTestContext(): DbTestContext {
  const dir = mkdtempSync(join(tmpdir(), "aether-storage-test-"));
  const opened: DatabaseSync[] = [];
  let counter = 0;
  return {
    dir,
    nextDbPath(): string {
      counter += 1;
      return join(dir, `aether-${counter}.db`);
    },
    track(db: DatabaseSync): DatabaseSync {
      opened.push(db);
      return db;
    },
    dispose(): void {
      for (const db of opened) {
        try {
          db.close();
        } catch {
          // 已关闭的连接忽略
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 查 sqlite_master 中全部对象名（表 + 索引）。 */
export function sqliteObjectNames(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master").all();
  return new Set(rows.map((row) => String(row.name ?? "")));
}

/** 直接数表行数（绕过 repo，供底层状态断言）。 */
export function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return Number(row?.n ?? 0);
}

/** 断言为可被 Date 解析的 UTC ISO-8601 字符串。 */
export function expectIsoTimestamp(value: string): void {
  expect(Number.isNaN(Date.parse(value))).toBe(false);
  expect(value.endsWith("Z")).toBe(true);
}

/** 断言非空并收窄类型（避免非空断言 `!`）。 */
export function expectNotNull<T>(value: T | null | undefined): T {
  expect(value).not.toBeNull();
  if (value === null || value === undefined) {
    throw new Error("不可达：上一行断言已失败");
  }
  return value;
}

/** 读取列表首元素（测试便捷用）。 */
export function firstOf<T>(items: readonly T[]): T {
  const head = items.at(0);
  expect(head).not.toBeUndefined();
  if (head === undefined) {
    throw new Error("不可达：列表应为非空");
  }
  return head;
}
