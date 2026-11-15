import type {
  ExecutionLogAppendInput,
  ExecutionLogStore,
} from "../ports/execution-log-store.port.js";

// ===== 执行日志 sink（SYSTEM_DESIGN §4.4 写路径定案）=====
// 进程原始输出 append 同步入队即返回（状态机事件泵在热路径上，绝不阻塞）；
// 定时（默认 200ms）/ 定量（默认 500 行）触发后台 flush，单事务批量 appendBatch；
// flush 失败整批经 onError 上报后清队（不无限重试、不静默丢）；背压超限拒绝新行。
//
// 定案注释（背压策略）：超限（单 process 默认 10k 行 / 总量默认 50k 行）时
// 「拒绝新行」而非「丢弃最旧」——丢弃最旧会在已入队 seq 上挖洞，破坏
// 「seq 连续无丢失」的重放口径；被拒行不占 seq、经 onError 上报由宿主记账。
//
// 不在本卡（§4.4 留接口）：单行 1MiB 截断（sidecar 溢出文件）与按量/按天
// 保留策略 —— TODO(P0-10+)：append 处加截断钩子、dispose 后接清理任务。
// 已知边界：seq 为 sink 内存计数、进程生命周期内单调；daemon 崩溃重启后对
// 同一 processId 续灌会重发 seq（索引非唯一，不炸库）——TODO(P0-10 daemon
// 挂接)：以 flushNow 落库后的最大 seq 续号或按 rowid 兜底排序。
//
// 内部队列是本类存在的目的（缓冲），内部容器允许就地变更；对外可见的行
// 对象一律只读，flush 批次为防篡改副本。

/** 默认定时 flush 间隔（§4.4 定案 200ms） */
export const DEFAULT_FLUSH_INTERVAL_MS = 200;
/** 默认定量 flush 阈值（§4.4 定案 500 行） */
export const DEFAULT_FLUSH_THRESHOLD = 500;
/** 单进程背压上限（定案：超限拒绝新行） */
export const DEFAULT_MAX_QUEUED_PER_PROCESS = 10_000;
/** 总量背压上限（定案：超限拒绝新行） */
export const DEFAULT_MAX_QUEUED_TOTAL = 50_000;

/** 定时器句柄：node 实现（NodeJS.Timeout）结构性携带 unref；测试假定时器返回空对象即可 */
export interface TimerHandle {
  unref?: () => void;
}

/** 定时器注入缝（确定性测试用；压测必须用真实定时器——任务纪律） */
export interface TimerHooks {
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** 默认真实定时器；unref 避免后台 flush 定时器吊住进程退出 */
const defaultTimers: TimerHooks = {
  setInterval(fn, ms) {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]),
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

/** sink 异常事件（注入回调消费；不静默丢） */
export type ExecutionLogSinkError =
  | {
      readonly kind: "flush_failed";
      /** 整批被丢弃的行数（已清队，不重试） */
      readonly droppedRows: number;
      readonly cause: unknown;
    }
  | {
      readonly kind: "queue_overflow";
      readonly processId: string;
      readonly rawLine: string;
      readonly limit: number;
      readonly scope: "process" | "total";
    }
  | {
      readonly kind: "sink_disposed";
      readonly processId: string;
      readonly rawLine: string;
    };

export interface ExecutionLogSinkOptions {
  readonly store: ExecutionLogStore;
  /** 定时 flush 间隔；默认 200ms */
  readonly flushIntervalMs?: number;
  /** 定量 flush 阈值；默认 500 行 */
  readonly flushThreshold?: number;
  /** 单进程待 flush 行数上限；默认 10_000 */
  readonly maxQueuedPerProcess?: number;
  /** 全部进程待 flush 行数总量上限；默认 50_000 */
  readonly maxQueuedTotal?: number;
  /** 异常事件回调（flush 失败 / 背压拒绝 / dispose 后入队）；回调抛错不中断管线 */
  readonly onError?: (error: ExecutionLogSinkError) => void;
  /** 定时器注入缝；默认真实 node 定时器（unref） */
  readonly timers?: TimerHooks;
}

/** 待 flush 行（进程内 seq 已分配；对外只读） */
interface PendingRow {
  readonly processId: string;
  readonly seq: number;
  readonly rawJson: string;
}

export class ExecutionLogSink {
  private readonly store: ExecutionLogStore;
  private readonly flushIntervalMs: number;
  private readonly flushThreshold: number;
  private readonly maxQueuedPerProcess: number;
  private readonly maxQueuedTotal: number;
  private readonly onError: (error: ExecutionLogSinkError) => void;
  private readonly timers: TimerHooks;

  private pending: PendingRow[] = [];
  private readonly pendingPerProcess = new Map<string, number>();
  private readonly seqCounters = new Map<string, number>();
  private intervalHandle: TimerHandle | null = null;
  private flushTimerHandle: TimerHandle | null = null;
  private flushScheduled = false;
  private disposed = false;

  constructor(options: ExecutionLogSinkOptions) {
    this.store = options.store;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.flushThreshold = options.flushThreshold ?? DEFAULT_FLUSH_THRESHOLD;
    this.maxQueuedPerProcess = options.maxQueuedPerProcess ?? DEFAULT_MAX_QUEUED_PER_PROCESS;
    this.maxQueuedTotal = options.maxQueuedTotal ?? DEFAULT_MAX_QUEUED_TOTAL;
    this.onError = options.onError ?? (() => undefined);
    this.timers = options.timers ?? defaultTimers;
  }

  /** 当前待 flush 总行数（观测/测试用） */
  pendingCount(): number {
    return this.pending.length;
  }

  /**
   * 原始行入队：同步、纯内存、即返（热路径承诺——绝不触库、绝不定时器阻塞）。
   * 非法入参抛 TypeError（程序员错误 fail fast）；背压/dispose 经 onError 上报。
   */
  append(processId: string, rawLine: string): void {
    if (typeof processId !== "string" || processId.length === 0) {
      throw new TypeError("append: processId 必须为非空字符串");
    }
    if (typeof rawLine !== "string") {
      throw new TypeError("append: rawLine 必须为字符串（JSONL 原样行）");
    }
    if (this.disposed) {
      this.report({ kind: "sink_disposed", processId, rawLine });
      return;
    }
    const perProcess = this.pendingPerProcess.get(processId) ?? 0;
    if (perProcess >= this.maxQueuedPerProcess) {
      this.report({
        kind: "queue_overflow",
        processId,
        rawLine,
        limit: this.maxQueuedPerProcess,
        scope: "process",
      });
      return;
    }
    if (this.pending.length >= this.maxQueuedTotal) {
      this.report({
        kind: "queue_overflow",
        processId,
        rawLine,
        limit: this.maxQueuedTotal,
        scope: "total",
      });
      return;
    }

    const seq = (this.seqCounters.get(processId) ?? 0) + 1;
    this.seqCounters.set(processId, seq);
    this.pending.push({ processId, seq, rawJson: rawLine });
    this.pendingPerProcess.set(processId, perProcess + 1);
    this.ensureInterval();

    if (!this.flushScheduled && this.pending.length >= this.flushThreshold) {
      this.scheduleFlush();
    }
  }

  /** 立即落库全部待 flush 行（测试与优雅关闭用）；dispose 后为 no-op。@returns 实际写入行数 */
  flushNow(): number {
    if (this.disposed) {
      return 0;
    }
    return this.drain();
  }

  /** 优雅关闭：flush 余量 + 停全部定时器；幂等，可重复调用 */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.drain();
    this.stopTimers();
  }

  private drain(): number {
    if (this.pending.length === 0) {
      this.stopIntervalIfIdle();
      return 0;
    }
    const rows: ExecutionLogAppendInput[] = this.pending.map((row) => ({
      processId: row.processId,
      seq: row.seq,
      rawJson: row.rawJson,
    }));
    // 先清队再写库：失败也不重试（定案），行已进入上报通道
    this.pending = [];
    this.pendingPerProcess.clear();
    try {
      const written = this.store.appendBatch(rows);
      this.stopIntervalIfIdle();
      return written;
    } catch (cause) {
      this.report({ kind: "flush_failed", droppedRows: rows.length, cause });
      this.stopIntervalIfIdle();
      return 0;
    }
  }

  private ensureInterval(): void {
    if (this.intervalHandle === null) {
      this.intervalHandle = this.timers.setInterval(() => {
        this.drain();
      }, this.flushIntervalMs);
    }
  }

  private scheduleFlush(): void {
    this.flushScheduled = true;
    this.flushTimerHandle = this.timers.setTimeout(() => {
      this.flushScheduled = false;
      this.flushTimerHandle = null;
      this.drain();
    }, 0);
  }

  private stopIntervalIfIdle(): void {
    if (this.intervalHandle !== null && this.pending.length === 0) {
      this.timers.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  private stopTimers(): void {
    if (this.flushTimerHandle !== null) {
      this.timers.clearTimeout(this.flushTimerHandle);
      this.flushTimerHandle = null;
    }
    this.flushScheduled = false;
    if (this.intervalHandle !== null) {
      this.timers.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** 上报异常事件；回调自身抛错不中断管线（记录通道失败无处再报，只能吞） */
  private report(error: ExecutionLogSinkError): void {
    try {
      this.onError(error);
    } catch {
      // onError 回调抛错：管道继续（丢弃决策已定案，不能因记账失败卡死队列）
    }
  }
}
