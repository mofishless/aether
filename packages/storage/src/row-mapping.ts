import type { SQLInputValue } from "node:sqlite";
import { StorageError } from "./errors.js";

/** 行读取上下文（错误信息用）。 */
export interface RowContext {
  table: string;
  operation: string;
}

/** SQLite 结果行（node:sqlite 返回 Record<string, SQLOutputValue>，此处放宽为 unknown 收窄）。 */
export type SqlRow = Record<string, unknown>;

function rowError(context: RowContext, column: string, reason: string): StorageError {
  return new StorageError({
    operation: context.operation,
    table: context.table,
    message: `读取 ${context.table} 表数据失败（列 ${column} ${reason}）`,
    detail: { column, reason },
  });
}

export function readString(row: SqlRow, column: string, context: RowContext): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw rowError(context, column, "应为字符串");
  }
  return value;
}

export function readNullableString(
  row: SqlRow,
  column: string,
  context: RowContext,
): string | null {
  const value = row[column];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw rowError(context, column, "应为字符串或 NULL");
  }
  return value;
}

export function readNumber(row: SqlRow, column: string, context: RowContext): number {
  const value = row[column];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw rowError(context, column, "应为数值");
}

export function readNullableNumber(
  row: SqlRow,
  column: string,
  context: RowContext,
): number | null {
  const value = row[column];
  if (value === null || value === undefined) {
    return null;
  }
  return readNumber(row, column, context);
}

/** 读取受限枚举列（CHECK 约束对应）；枚举值数组来自 @aether/contracts 的 zod schema.options。 */
export function readEnum<T extends string>(
  row: SqlRow,
  column: string,
  allowed: readonly T[],
  context: RowContext,
): T {
  const value = readString(row, column, context);
  const matched = allowed.find((candidate) => candidate === value);
  if (matched === undefined) {
    throw rowError(context, column, `枚举值非法：${value}`);
  }
  return matched;
}

/** 把待写入值收窄为 node:sqlite 可参数化类型（外部输入运行时校验，拒绝对象/undefined 等）。 */
export function toSqlValue(value: unknown, column: string, context: RowContext): SQLInputValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  throw new StorageError({
    operation: context.operation,
    table: context.table,
    message: `写入 ${context.table} 表失败（列 ${column} 的值类型不受支持）`,
    detail: { column, valueType: typeof value },
  });
}

export interface BuiltStatement {
  sql: string;
  params: SQLInputValue[];
}

/**
 * 组装 PATCH 语义的 UPDATE：只 SET patch 给出的列。
 * 安全红线：列名仅来自各 repo 的静态白名单常量（非用户输入）；值一律 `?` 参数化。
 * 返回 null 表示 patch 未包含任何可更新列（调用方直接回查即可）。
 */
export function buildUpdateStatement<P extends Record<string, unknown>>(
  table: string,
  columns: ReadonlyArray<readonly [keyof P & string, string]>,
  entityId: string | number,
  patch: P,
  context: RowContext,
): BuiltStatement | null {
  const assignments: string[] = [];
  const params: SQLInputValue[] = [];
  for (const [field, column] of columns) {
    const value = patch[field];
    if (value === undefined) {
      continue;
    }
    // 列名来自静态白名单；值经 toSqlValue 校验后参数化
    assignments.push(`${column} = ?`);
    params.push(toSqlValue(value, column, context));
  }
  if (assignments.length === 0) {
    return null;
  }
  params.push(entityId);
  return { sql: `UPDATE ${table} SET ${assignments.join(", ")} WHERE id = ?`, params };
}
