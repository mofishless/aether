import { expect } from "vitest";
import type { z } from "zod";

/**
 * round-trip 断言：合法样例 → parse → JSON 序列化 → 再 parse，结果与第一次 parse 等值。
 * （P0-02 任务卡：对象 → parse → serialize → parse 等值）
 */
export function expectRoundTrip<T>(schema: z.ZodType<T>, sample: T): void {
  const first = schema.parse(sample);
  const throughWire: unknown = JSON.parse(JSON.stringify(first));
  const second = schema.parse(throughWire);
  expect(second).toEqual(first);
}

/**
 * 反例断言：safeParse 成功 false 且携带至少一条 issue。
 * 失败时抛出带上下文的错误（含被误收的输入），便于定位是哪条用例的红。
 */
export function expectRejected(schema: z.ZodType<unknown>, input: unknown): void {
  const result = schema.safeParse(input);
  if (result.success) {
    throw new Error(
      `Expected schema to reject input, but parse succeeded. Input: ${JSON.stringify(input)}`,
    );
  }
  expect(result.error.issues.length).toBeGreaterThan(0);
}
