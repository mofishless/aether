import { describe, expect, it } from "vitest";
import type {
  ExecutionLogAppendInput,
  ExecutionLogSinkError,
  ExecutionLogStore,
  TimerHooks,
} from "../src/index.js";
import { ExecutionLogSink } from "../src/index.js";

// ===== 执行日志 sink 全语义单测（P0-09 §4.4 写路径）=====
// 定时/定量 flush、flush 失败清队、背压拒绝、幂等 dispose——全部用注入的
// 手动定时器与假 store 确定性驱动（压测另见 execution-log-throughput.test.ts）。

class FakeStore implements ExecutionLogStore {
  readonly batches: ExecutionLogAppendInput[][] = [];
  readonly normalized: Array<{ id: number; json: string }> = [];
  /** 置性失败开关：为 true 时 appendBatch 一律抛（模拟外键非法等整批失败） */
  failAppend = false;

  appendBatch(rows: readonly ExecutionLogAppendInput[]): number {
    if (this.failAppend) {
      throw new Error("模拟外键非法");
    }
    this.batches.push(rows.map((row) => ({ ...row })));
    return rows.length;
  }

  updateNormalized(id: number, normalizedJson: string): void {
    this.normalized.push({ id, json: normalizedJson });
  }

  findByProcessId(): [] {
    return [];
  }
}

class ManualTimers {
  private timeoutFns: Array<() => void> = [];
  private intervalFn: (() => void) | null = null;
  setTimeoutCalls = 0;
  readonly intervalMs: number[] = [];

  readonly hooks: TimerHooks = {
    setTimeout: (fn) => {
      this.setTimeoutCalls += 1;
      this.timeoutFns.push(fn);
      return {};
    },
    clearTimeout: () => undefined,
    setInterval: (fn, ms) => {
      this.intervalMs.push(ms);
      this.intervalFn = fn;
      return {};
    },
    clearInterval: () => {
      this.intervalFn = null;
    },
  };

  fireTimeouts(): void {
    const pending = this.timeoutFns.splice(0, this.timeoutFns.length);
    for (const fn of pending) {
      fn();
    }
  }

  fireInterval(): void {
    this.intervalFn?.();
  }

  get intervalArmed(): boolean {
    return this.intervalFn !== null;
  }
}

function makeSink(overrides: Partial<ConstructorParameters<typeof ExecutionLogSink>[0]> = {}): {
  sink: ExecutionLogSink;
  store: FakeStore;
  timers: ManualTimers;
  errors: ExecutionLogSinkError[];
} {
  const store = new FakeStore();
  const timers = new ManualTimers();
  const errors: ExecutionLogSinkError[] = [];
  const sink = new ExecutionLogSink({
    store,
    timers: timers.hooks,
    flushIntervalMs: 200,
    flushThreshold: 500,
    maxQueuedPerProcess: 10_000,
    maxQueuedTotal: 50_000,
    onError: (error) => {
      errors.push(error);
    },
    ...overrides,
  });
  return { sink, store, timers, errors };
}

describe("ExecutionLogSink.append（入队语义）", () => {
  it("同步入队即返回：不动 store；seq 每进程独立从 1 单调；原始先存（normalized 为 null）", () => {
    const { sink, store, timers } = makeSink();
    sink.append("p-1", '{"i":1}');
    sink.append("p-1", '{"i":2}');
    sink.append("p-2", '{"i":1}');

    expect(store.batches).toEqual([]);
    expect(sink.pendingCount()).toBe(3);
    expect(timers.intervalArmed).toBe(true); // 首次 append 惰性启动定时器
    const rows = sink.flushNow();
    expect(rows).toBe(3);
    expect(store.batches).toHaveLength(1);
    const batch = store.batches[0] ?? [];
    expect(batch.map((row) => [row.processId, row.seq])).toEqual([
      ["p-1", 1],
      ["p-1", 2],
      ["p-2", 1],
    ]);
    expect(batch.every((row) => !row.normalizedJson)).toBe(true); // 原始先存
  });

  it("参数校验：空 processId / 非 string rawLine 抛 TypeError（fail fast）", () => {
    const { sink } = makeSink();
    expect(() => sink.append("", "{}")).toThrow(TypeError);
    expect(() => sink.append("p-1", 42 as unknown as string)).toThrow(TypeError);
    expect(sink.pendingCount()).toBe(0);
  });
});

describe("ExecutionLogSink 定量触发（threshold）", () => {
  it("达到 threshold 调度一次异步 flush，fire 后单批落库、队清空、定时器停", () => {
    const { sink, store, timers } = makeSink({ flushThreshold: 3 });
    sink.append("p-1", '{"i":1}');
    sink.append("p-1", '{"i":2}');
    sink.append("p-1", '{"i":3}');

    // fire 之前不落库（append 热路径绝不同步写库）
    expect(store.batches).toEqual([]);
    expect(timers.setTimeoutCalls).toBe(1);
    timers.fireTimeouts();

    expect(store.batches).toHaveLength(1);
    expect(store.batches[0]).toHaveLength(3);
    expect(sink.pendingCount()).toBe(0);
    expect(timers.intervalArmed).toBe(false); // 队空后停定时器
  });

  it("连续超量只调度一次（pending flush 去重），一次 fire 全量清队", () => {
    const { sink, store, timers } = makeSink({ flushThreshold: 3 });
    for (let i = 1; i <= 5; i += 1) {
      sink.append("p-1", `{"i":${i}}`);
    }
    expect(timers.setTimeoutCalls).toBe(1);
    timers.fireTimeouts();
    expect(store.batches).toHaveLength(1);
    expect(store.batches[0]).toHaveLength(5);
    expect(sink.pendingCount()).toBe(0);
  });

  it("flush 定时器到期后新一批可再次调度（去重只作用于在途的）", () => {
    const { sink, timers } = makeSink({ flushThreshold: 2 });
    sink.append("p-1", '{"i":1}');
    sink.append("p-1", '{"i":2}');
    timers.fireTimeouts();
    sink.append("p-1", '{"i":3}');
    sink.append("p-1", '{"i":4}');
    expect(timers.setTimeoutCalls).toBe(2);
    timers.fireTimeouts();
  });

  it("在途 flush 定时器在 flushNow 清队后到期：空跑无副作用（竞态无害）", () => {
    const { sink, store, timers } = makeSink({ flushThreshold: 3 });
    sink.append("p-1", '{"i":1}');
    sink.append("p-1", '{"i":2}');
    sink.append("p-1", '{"i":3}'); // 调度在途 flush
    expect(sink.flushNow()).toBe(3); // 手动先清队
    timers.fireTimeouts(); // 在途定时器此刻才到期
    expect(store.batches).toHaveLength(1); // 无第二批、不重复写
    expect(sink.pendingCount()).toBe(0);
  });

  it("多次 append 只武装一个 interval（ensureInterval 幂等）", () => {
    const { sink, timers } = makeSink({ flushThreshold: 100 });
    for (let i = 1; i <= 5; i += 1) {
      sink.append("p-1", `{"i":${i}}`);
    }
    expect(timers.intervalMs).toEqual([200]); // setInterval 恰好一次
    sink.flushNow();
    expect(timers.intervalArmed).toBe(false);
  });
});

describe("ExecutionLogSink 定时触发（interval）", () => {
  it("低于 threshold 时由 interval 兜底 flush", () => {
    const { sink, store, timers } = makeSink({ flushIntervalMs: 200 });
    sink.append("p-1", '{"i":1}');
    expect(timers.intervalMs).toEqual([200]);
    timers.fireInterval();
    expect(store.batches).toHaveLength(1);
    expect(sink.pendingCount()).toBe(0);
    expect(timers.intervalArmed).toBe(false); // 队空即停，不留孤儿定时器
  });

  it("空队时 interval 触发零副作用", () => {
    const { store, timers } = makeSink();
    timers.fireInterval();
    expect(store.batches).toEqual([]);
  });
});

describe("ExecutionLogSink flush 失败策略（清队 + onError，不无限重试）", () => {
  it("flushNow 遇 store 抛错 → 整批经 onError 上报丢弃、队列清空、seq 不回退", () => {
    const { sink, store, errors } = makeSink({ flushThreshold: 100 });
    sink.append("p-1", '{"i":1}');
    sink.append("p-1", '{"i":2}');
    store.failAppend = true;

    const written = sink.flushNow();
    expect(written).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("flush_failed");
    if (errors[0]?.kind === "flush_failed") {
      expect(errors[0].droppedRows).toBe(2);
    }
    expect(sink.pendingCount()).toBe(0);

    // 清队后管道可用：新行继续、seq 延续（被丢弃的号不复用）
    store.failAppend = false;
    sink.append("p-1", '{"i":3}');
    expect(sink.flushNow()).toBe(1);
    const batch = store.batches[0];
    expect(batch).toBeDefined();
    expect(batch?.map((row) => row.seq)).toEqual([3]);
  });

  it("阈值异步 flush 失败同样清队并上报", () => {
    const { sink, store, timers, errors } = makeSink({ flushThreshold: 2 });
    store.failAppend = true;
    sink.append("p-1", '{"i":1}');
    sink.append("p-1", '{"i":2}');
    timers.fireTimeouts(); // 触发定量异步 flush
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("flush_failed");
    expect(sink.pendingCount()).toBe(0);
    expect(store.batches).toHaveLength(0);
  });
});

describe("ExecutionLogSink 背压（拒绝新行，不挖洞）", () => {
  it("单进程超限：拒绝该行（不占 seq）、onError queue_overflow", () => {
    const { sink, errors } = makeSink({ maxQueuedPerProcess: 2, flushThreshold: 100 });
    sink.append("p-1", '{"i":1}');
    sink.append("p-1", '{"i":2}');
    sink.append("p-1", '{"i":3}'); // 超限被拒

    expect(sink.pendingCount()).toBe(2);
    expect(errors).toHaveLength(1);
    if (errors[0]?.kind === "queue_overflow") {
      expect(errors[0].processId).toBe("p-1");
      expect(errors[0].scope).toBe("process");
      expect(errors[0].rawLine).toBe('{"i":3}');
    } else {
      expect.unreachable("应为 queue_overflow/process");
    }

    // 被拒行不占 seq：flush 后下一行拿到 seq=3
    expect(sink.flushNow()).toBe(2);
    sink.append("p-1", '{"i":4}');
    expect(sink.flushNow()).toBe(1);
  });

  it("总量超限：拒绝新行、scope=total（已入队的不受影响）", () => {
    const { sink, store, errors } = makeSink({
      maxQueuedPerProcess: 10,
      maxQueuedTotal: 3,
      flushThreshold: 100,
    });
    sink.append("p-1", '{"i":1}');
    sink.append("p-1", '{"i":2}');
    sink.append("p-2", '{"i":1}');
    sink.append("p-2", '{"i":2}'); // 总量第 4 行被拒

    expect(sink.pendingCount()).toBe(3);
    expect(errors).toHaveLength(1);
    if (errors[0]?.kind === "queue_overflow") {
      expect(errors[0].processId).toBe("p-2");
      expect(errors[0].scope).toBe("total");
    } else {
      expect.unreachable("应为 queue_overflow/total");
    }
    expect(sink.flushNow()).toBe(3);
    expect(store.batches).toHaveLength(1);
  });

  it("flush 释放容量后可继续入队", () => {
    const { sink } = makeSink({ maxQueuedPerProcess: 2, flushThreshold: 100 });
    sink.append("p-1", '{"i":1}');
    sink.append("p-1", '{"i":2}');
    sink.append("p-1", '{"i":3}');
    sink.flushNow();
    sink.append("p-1", '{"i":4}'); // 容量已释放：不再报溢出
    expect(sink.pendingCount()).toBe(1);
  });
});

describe("ExecutionLogSink dispose（优雅关闭）", () => {
  it("flush 余量、停定时器、幂等；dispose 后 append 经 onError 上报拒绝", () => {
    const { sink, store, timers, errors } = makeSink({ flushThreshold: 100 });
    sink.append("p-1", '{"i":1}');
    sink.append("p-1", '{"i":2}');

    sink.dispose();
    expect(store.batches).toHaveLength(1);
    expect(sink.pendingCount()).toBe(0);
    expect(timers.intervalArmed).toBe(false);

    sink.dispose(); // 幂等
    expect(store.batches).toHaveLength(1);

    sink.append("p-1", '{"i":3}');
    expect(sink.pendingCount()).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("sink_disposed");
  });

  it("dispose 时 flush 失败同样走 onError 清队（不抛出）", () => {
    const { sink, store, errors } = makeSink();
    sink.append("p-1", '{"i":1}');
    store.failAppend = true;
    expect(() => sink.dispose()).not.toThrow();
    expect(errors[0]?.kind).toBe("flush_failed");
    expect(sink.pendingCount()).toBe(0);
  });
});
