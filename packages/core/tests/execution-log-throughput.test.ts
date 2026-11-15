import { describe, expect, it } from "vitest";
import type { ExecutionLogAppendInput, ExecutionLogStore } from "../src/index.js";
import { ExecutionLogSink, INITIAL_AGENT_STATUS, applySessionEvent } from "../src/index.js";
import { messageEvent } from "./helpers/provider-event-fixture.js";

// ===== 写路径压测（任务卡 P0-09 验收 ③：万行/秒灌入不阻塞状态机与查询）=====
// 真实定时器（任务纪律：压测不用假定时器）；store 用内存假实现，
// 考察的是 sink 入队热路径与后台 flush 的调度，不含磁盘 I/O（SQLite 路径
// 由 storage 测试与 adapter 集成测试覆盖）。

const LINE_COUNT = 12_000;
/** 每行 ~1KiB：{"seq":n,"pad":"xxxx…"} */
const PAD = "x".repeat(1000);

function makeLine(seq: number): string {
  return `{"seq":${seq},"pad":"${PAD}"}`;
}

class RecordingStore implements ExecutionLogStore {
  readonly batches: ExecutionLogAppendInput[][] = [];

  appendBatch(rows: readonly ExecutionLogAppendInput[]): number {
    this.batches.push(rows.map((row) => ({ ...row })));
    return rows.length;
  }

  updateNormalized(): void {
    // 压测不触达回填路径
  }

  findByProcessId(): [] {
    return [];
  }

  get totalRows(): number {
    return this.batches.reduce((sum, batch) => sum + batch.length, 0);
  }
}

describe("ExecutionLogSink 写路径压测（真实定时器）", () => {
  it("万行灌入：append 总耗时 < 1s（入队吞吐 ≥ 万行/秒），状态机穿插调用即时返回", async () => {
    const store = new RecordingStore();
    // 默认 200ms/500 行、真实定时器；单进程容量显式放宽到与总量一致——
    // 同步灌入不经过事件循环、后台 flush 无从介入，默认 10k 单进程背压
    // （背压语义由 sink 单测锁定）会把第 10,001 行起拒之门外，压的是容量而非热路径。
    const sink = new ExecutionLogSink({ store, maxQueuedPerProcess: 50_000 });

    const appendStart = performance.now();
    let status = INITIAL_AGENT_STATUS;
    let maxFoldMs = 0;
    for (let seq = 1; seq <= LINE_COUNT; seq += 1) {
      sink.append("p-stress", makeLine(seq));
      if (seq % 250 === 0) {
        // 穿插状态机事件泵（热路径上绝不能被日志写路径阻塞）
        const foldStart = performance.now();
        const transition = applySessionEvent(status, messageEvent(seq));
        const foldMs = performance.now() - foldStart;
        maxFoldMs = Math.max(maxFoldMs, foldMs);
        status = transition.status;
      }
    }
    const appendElapsedMs = performance.now() - appendStart;

    expect(sink.pendingCount()).toBe(LINE_COUNT); // 同步循环内零流失
    expect(appendElapsedMs).toBeLessThan(1_000); // 验收：万行/秒入队
    expect(maxFoldMs).toBeLessThan(10); // 状态机调用即时返回
    expect(status).toBe("running"); // 折叠未被阻塞，状态推进正常

    // 让出事件循环：真实定时器下的后台 flush 得以执行
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    const backgroundFlushed = store.totalRows;
    expect(backgroundFlushed).toBeGreaterThan(0); // 后台 flush 确实在工作

    const flushed = sink.flushNow();
    expect(flushed + backgroundFlushed).toBe(LINE_COUNT); // 无丢失
    expect(store.totalRows).toBe(LINE_COUNT);

    // seq 连续无丢失（1..N）且批内全局 FIFO
    const allRows = store.batches.flat();
    expect(allRows.map((row) => row.seq)).toEqual(
      Array.from({ length: LINE_COUNT }, (_, i) => i + 1),
    );
    sink.dispose();
  });

  it("多进程并发灌入：行数与每进程 seq 各自完整", () => {
    const store = new RecordingStore();
    const sink = new ExecutionLogSink({ store });
    const perProcess = 2_000;
    for (let seq = 1; seq <= perProcess; seq += 1) {
      sink.append("p-a", makeLine(seq));
      sink.append("p-b", makeLine(seq));
    }
    expect(sink.pendingCount()).toBe(perProcess * 2);
    expect(sink.flushNow()).toBe(perProcess * 2);

    const rows = store.batches.flat();
    const rowsA = rows.filter((row) => row.processId === "p-a");
    const rowsB = rows.filter((row) => row.processId === "p-b");
    expect(rowsA.map((row) => row.seq)).toEqual(
      Array.from({ length: perProcess }, (_, i) => i + 1),
    );
    expect(rowsB.map((row) => row.seq)).toEqual(
      Array.from({ length: perProcess }, (_, i) => i + 1),
    );
    sink.dispose();
  });
});
