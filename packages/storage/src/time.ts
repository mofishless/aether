/** 统一 UTC ISO-8601 时间戳（SYSTEM_DESIGN §4.1：时间一律 UTC ISO-8601 字符串）。 */
export function nowIso(): string {
  return new Date().toISOString();
}
