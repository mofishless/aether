import type { ProviderEvent } from "@aether/contracts";
import type { ExecutionLogStore } from "../ports/execution-log-store.port.js";

// ===== 归一化重放服务（P0-09 验收 ①：原始先存、归一化可重放）=====
// replayProcess：读该进程 raw 行序列 → 调注入的 normalize（adapter
// normalizeLogs 形状的纯转换器）→ 回填 normalized_json → 返回归一化事件序列。
//
// 两个口径（定案注释）：
// - 返回值 = 全流一次 normalize 的事件序列（与在线直出对账的口径，
//   验收 ① 即此断言）；
// - normalized_json 回填 = 每行单独 normalize 的事件 JSON 数组。normalize 是
//   黑盒（N 行 → M 事件，行级归属不可从全流结果切分），行级缓存是唯一可
//   归属到行的形态；eventId 的 seq 段按行独立（重放确定性，不依赖行序）。
//
// sessionId 归属：normalizeLogs 重放的 sessionId 是占位 "replay"（adapter 侧
// 既定）。core 不依赖 storage、无 processId→sessionId 端口，归属修正以
// sessionIdOverride 注入——TODO(P0-10 daemon 挂接)：daemon 查 execution_process
// 行的 sessionId 传入（.findById(processId).sessionId）。

/** normalize 转换器注入形状 = AgentAdapter.normalizeLogs（raw 行数组 → 事件数组） */
export type NormalizeLogsFn = (raw: unknown[]) => ProviderEvent[];

export interface ReplayProcessOptions {
  /** 归属会话 id：替换重放事件中的占位 sessionId；缺省保持转换器原样输出 */
  readonly sessionIdOverride?: string;
}

export interface ReplayResult {
  /** 全流一次 normalize 的事件序列（在线直出口径） */
  readonly events: ProviderEvent[];
  /** 本次回填了 normalized_json 的行数（含零事件行的 '[]' 回填） */
  readonly backfilledRowCount: number;
}

export class ExecutionLogReplayService {
  constructor(private readonly store: ExecutionLogStore) {}

  /**
   * 重放一个进程的原始日志：按 seq 升序读行 → 归一化 → 逐行回填旁路缓存。
   * 幂等：重复重放覆盖回填、返回同一序列。无日志进程返回空结果（不抛）。
   */
  replayProcess(
    processId: string,
    normalize: NormalizeLogsFn,
    options?: ReplayProcessOptions,
  ): ReplayResult {
    const sessionIdOverride = options?.sessionIdOverride;
    const rows = this.store.findByProcessId(processId);
    if (rows.length === 0) {
      return { events: [], backfilledRowCount: 0 };
    }

    const rawLines = rows.map((row) => row.rawJson);
    const events = this.withSessionId(normalize(rawLines), sessionIdOverride);

    for (const row of rows) {
      const rowEvents = this.withSessionId(normalize([row.rawJson]), sessionIdOverride);
      this.store.updateNormalized(row.id, JSON.stringify(rowEvents));
    }
    return { events, backfilledRowCount: rows.length };
  }

  /** 归属修正：未注入 override 时原样返回（不可变，不修改入参） */
  private withSessionId(
    events: readonly ProviderEvent[],
    sessionIdOverride: string | undefined,
  ): ProviderEvent[] {
    if (sessionIdOverride === undefined) {
      return [...events];
    }
    return events.map((event) => ({ ...event, sessionId: sessionIdOverride }));
  }
}
