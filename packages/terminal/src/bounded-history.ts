// bounded-history：按字节计数的环形缓冲（§7.2 有界历史，T3 铁律"server 持有 + 有界历史"）。
// 保留帧边界语义：存 (seq, base64 chunk) 序列，超容量丢最旧并标记截断；
// attach 场景 daemon 先发历史再续增量（历史条目本身不合并）。
// 不可变纪律：入参对象不落库（拷贝 seq/data），historyFrames() 返回新数组新对象快照。

/** 历史容量包级默认 256KiB（实现自选值——任务卡未定数字；SYSTEM_DESIGN §7.2 的 5000 行/8MiB 为 daemon 级默认，P0-10 挂接时经 TerminalPoolOptions.historyCapacityBytes 统一调参） */
export const TERMINAL_HISTORY_CAPACITY_BYTES = 256 * 1024;

/** 历史回放单元：序号 + base64 字节流（保留帧边界语义，§7.2） */
export interface HistoryChunk {
  seq: number;
  data: string;
}

/** 内部落库形态：预计算解码字节数，避免每次淘汰重算 */
interface StoredChunk {
  readonly seq: number;
  readonly data: string;
  readonly bytes: number;
}

export interface BoundedHistory {
  /** 容量上限（字节） */
  readonly capacityBytes: number;
  /** 当前保留字节数（解码后） */
  readonly bytes: number;
  /** 是否发生过淘汰（截断标记，§7.2） */
  readonly truncated: boolean;
  /** 累计丢弃的帧数 */
  readonly droppedFrames: number;
  push(chunk: HistoryChunk): void;
  /** 回放序列（新数组快照，保持 seq 升序） */
  historyFrames(): HistoryChunk[];
}

export function createBoundedHistory(
  capacityBytes: number = TERMINAL_HISTORY_CAPACITY_BYTES,
): BoundedHistory {
  if (!Number.isInteger(capacityBytes) || capacityBytes <= 0) {
    throw new Error(`历史容量必须为正整数（字节），收到: ${capacityBytes}`);
  }
  const chunks: StoredChunk[] = [];
  let totalBytes = 0;
  let truncated = false;
  let droppedFrames = 0;

  return {
    get capacityBytes() {
      return capacityBytes;
    },
    get bytes() {
      return totalBytes;
    },
    get truncated() {
      return truncated;
    },
    get droppedFrames() {
      return droppedFrames;
    },
    push(chunk: HistoryChunk): void {
      const bytes = Buffer.from(chunk.data, "base64").length;
      chunks.push({ seq: chunk.seq, data: chunk.data, bytes });
      totalBytes += bytes;
      // 超容量丢最旧；单个 chunk 自身超容量时保留它（至少留住最新一帧，不产生空历史）
      while (chunks.length > 1 && totalBytes > capacityBytes) {
        const oldest = chunks.shift();
        if (oldest === undefined) {
          break;
        }
        totalBytes -= oldest.bytes;
        droppedFrames += 1;
        truncated = true;
      }
    },
    historyFrames(): HistoryChunk[] {
      return chunks.map((chunk) => ({ seq: chunk.seq, data: chunk.data }));
    },
  };
}
