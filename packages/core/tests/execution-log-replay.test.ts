import { describe, expect, it } from "vitest";
import type { ExecutionProcessLog, ProviderEvent } from "@aether/contracts";
import type { ExecutionLogStore } from "../src/index.js";
import { ExecutionLogReplayService } from "../src/index.js";

// ===== 归一化重放服务单测（P0-09 验收 ①：落库 raw → 重放 → 归一化输出）=====
// normalize 为注入的黑盒（adapter normalizeLogs 形状）；重放服务职责：
// - 返回值口径 = 全流一次 normalize 的事件序列（在线直出对照）；
// - normalized_json 回填口径 = 每行单独 normalize 的事件数组（行级旁路缓存）；
// - sessionId 归属修正 = 注入 override（core 不依赖 storage，P0-10 daemon 接线）。

function messageEvent(eventId: string, sessionId: string): ProviderEvent {
  return {
    eventId,
    sessionId,
    occurredAt: "2026-01-01T00:00:00Z",
    type: "message",
    content: `text-${eventId}`,
  };
}

class FakeStore implements ExecutionLogStore {
  readonly rows: ExecutionProcessLog[];
  readonly normalized: Array<{ id: number; json: string }> = [];
  appendBatchCount = 0;

  constructor(rows: ExecutionProcessLog[]) {
    this.rows = rows;
  }

  appendBatch(): number {
    this.appendBatchCount += 1;
    return 0;
  }

  updateNormalized(id: number, normalizedJson: string): void {
    this.normalized.push({ id, json: normalizedJson });
  }

  findByProcessId(processId: string): ExecutionProcessLog[] {
    return this.rows.filter((row) => row.processId === processId);
  }
}

function logRow(id: number, processId: string, seq: number, rawJson: string): ExecutionProcessLog {
  return {
    id,
    processId,
    seq,
    rawJson,
    normalizedJson: null,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

/** 测试黑盒：每条 {"line":n} → 一个 message 事件；{"line":0} → 零事件（容忍行） */
function fakeNormalize(raw: unknown[]): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  for (const entry of raw) {
    const record =
      typeof entry === "string" ? (JSON.parse(entry) as Record<string, unknown>) : null;
    const line = typeof record?.line === "number" ? record.line : 0;
    if (line > 0) {
      events.push(messageEvent(`e-${line}`, "replay"));
    }
  }
  return events;
}

describe("ExecutionLogReplayService.replayProcess", () => {
  const rows = [
    logRow(11, "p-1", 1, '{"line":1}'),
    logRow(12, "p-1", 2, '{"line":2}'),
    logRow(13, "p-1", 3, '{"line":0}'), // 零事件行
    logRow(14, "p-1", 4, '{"line":3}'),
  ];

  it("返回全流一次 normalize 的事件序列（在线直出口径），按 seq 顺序喂入", () => {
    const store = new FakeStore(rows);
    const service = new ExecutionLogReplayService(store);
    const seen: unknown[][] = [];
    const result = service.replayProcess("p-1", (raw) => {
      seen.push([...raw]);
      return fakeNormalize(raw);
    });

    expect(seen[0]).toEqual(['{"line":1}', '{"line":2}', '{"line":0}', '{"line":3}']);
    expect(result.events.map((event) => event.eventId)).toEqual(["e-1", "e-2", "e-3"]);
    expect(result.events.every((event) => event.sessionId === "replay")).toBe(true); // 未注入 override 保持原样
  });

  it("逐行回填 normalized_json（行级缓存，零事件行回填 '[]'），全部行都被覆盖", () => {
    const store = new FakeStore(rows);
    const service = new ExecutionLogReplayService(store);
    const result = service.replayProcess("p-1", fakeNormalize);

    expect(result.backfilledRowCount).toBe(4);
    expect(store.normalized).toHaveLength(4);
    expect(store.normalized[0]).toEqual({
      id: 11,
      json: '[{"eventId":"e-1","sessionId":"replay","occurredAt":"2026-01-01T00:00:00Z","type":"message","content":"text-e-1"}]',
    });
    expect(store.normalized[2]).toEqual({ id: 13, json: "[]" });
  });

  it("sessionIdOverride：返回序列与回填缓存中的 sessionId 全部替换为归属会话", () => {
    const store = new FakeStore(rows);
    const service = new ExecutionLogReplayService(store);
    const result = service.replayProcess("p-1", fakeNormalize, { sessionIdOverride: "session-42" });

    expect(result.events.every((event) => event.sessionId === "session-42")).toBe(true);
    expect(result.events.map((event) => event.eventId)).toEqual(["e-1", "e-2", "e-3"]); // 其余字段不动
    const backfilled = store.normalized.map((entry) => JSON.parse(entry.json) as ProviderEvent[]);
    expect(backfilled.flat().every((event) => event.sessionId === "session-42")).toBe(true);
  });

  it("重复重放幂等：再次重放覆盖回填、返回同一序列", () => {
    const store = new FakeStore(rows);
    const service = new ExecutionLogReplayService(store);
    const first = service.replayProcess("p-1", fakeNormalize, { sessionIdOverride: "s" });
    const second = service.replayProcess("p-1", fakeNormalize, { sessionIdOverride: "s" });

    expect(second.events).toEqual(first.events);
    expect(store.normalized).toHaveLength(8); // 两次 × 4 行
  });

  it("无日志进程：返回空序列、零回填（不抛）", () => {
    const store = new FakeStore(rows);
    const service = new ExecutionLogReplayService(store);
    const result = service.replayProcess("p-none", fakeNormalize);
    expect(result.events).toEqual([]);
    expect(result.backfilledRowCount).toBe(0);
    expect(store.normalized).toHaveLength(0);
  });

  it("只重放目标进程的行（跨进程隔离）", () => {
    const mixed = new FakeStore([
      logRow(21, "p-1", 1, '{"line":1}'),
      logRow(22, "p-2", 1, '{"line":9}'),
      logRow(23, "p-1", 2, '{"line":2}'),
    ]);
    const service = new ExecutionLogReplayService(mixed);
    const result = service.replayProcess("p-1", fakeNormalize);
    expect(result.events.map((event) => event.eventId)).toEqual(["e-1", "e-2"]);
    expect(result.backfilledRowCount).toBe(2);
  });
});
