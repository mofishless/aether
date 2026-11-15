// 重连退避（P0-10）：指数退避 100ms 起、500ms 封顶（supervisor 有界退避先例，spec-review 防重启风暴）。
// 纯函数：consecutiveFailures 为连续失败次数（成功连接后归零）。

export const DEFAULT_BACKOFF_BASE_MS = 100;
export const DEFAULT_BACKOFF_CAP_MS = 500;

/** 第 consecutiveFailures 次连续失败后的等待时长：base·2^(n-1)，封顶 cap */
export function reconnectDelayMs(
  consecutiveFailures: number,
  baseMs: number = DEFAULT_BACKOFF_BASE_MS,
  capMs: number = DEFAULT_BACKOFF_CAP_MS,
): number {
  // 防御：非正/非整数入参按首次失败处理，绝不返回 0 或 NaN（0 会造成高频重连风暴）
  const normalized = Math.max(1, Math.floor(consecutiveFailures));
  return Math.min(baseMs * 2 ** (normalized - 1), capMs);
}
