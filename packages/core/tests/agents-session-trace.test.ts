import { describe, expect, it } from "vitest";
import type { AgentStatus, ProviderEvent } from "@aether/contracts";
import {
  applySessionEvent,
  INITIAL_AGENT_STATUS,
  type SessionTransitionResult,
} from "../src/index.js";
import {
  errorEvent,
  messageEvent,
  permissionRequestEvent,
  sessionEvent,
  statusEvent,
  toolResultEvent,
  toolUseEvent,
} from "./helpers/provider-event-fixture.js";

// 驱动序列测试：事件数组 fold 出状态轨迹（任务卡 P0-07 TDD 第 1 条）。
// fold 语义 = daemon 侧真实用法：reduce 依次喂事件，rejected 时状态钉在原地。

function foldTrace(
  events: readonly ProviderEvent[],
  initial: AgentStatus = INITIAL_AGENT_STATUS,
): {
  trace: SessionTransitionResult[];
  final: AgentStatus;
} {
  let current = initial;
  const trace: SessionTransitionResult[] = [];
  for (const event of events) {
    const result = applySessionEvent(current, event);
    trace.push(result);
    current = result.status;
  }
  return { trace, final: current };
}

describe("会话状态轨迹 fold", () => {
  it("幸福旅程：握手→活动→权限等待→恢复→收尾→停止", () => {
    const events = [
      sessionEvent("ext-abc"), // starting → ready（首个事件/握手）
      messageEvent(), // ready → running
      toolUseEvent(), // running → running（幂等）
      permissionRequestEvent(), // running → waiting
      toolResultEvent(), // waiting → running（权限应答后工具结果）
      messageEvent(), // running → running
      statusEvent("stopped"), // running → stopped（turn 结束/干净退出）
    ];
    const { trace, final } = foldTrace(events);
    expect(trace.map((step) => step.status)).toEqual([
      "ready",
      "running",
      "running",
      "waiting",
      "running",
      "running",
      "stopped",
    ]);
    expect(trace.every((step) => step.transition === "applied")).toBe(true);
    expect(final).toBe("stopped");
  });

  it("活动即首发：首个事件是 tool_use 时直达 running（core 定案：不强迫经过 ready）", () => {
    const { trace, final } = foldTrace([toolUseEvent(), toolResultEvent(), statusEvent("stopped")]);
    expect(trace.map((step) => step.status)).toEqual(["running", "running", "stopped"]);
    expect(final).toBe("stopped");
  });

  it("权限即首发：starting + permission_request 直达 waiting，应答后回 running", () => {
    const { trace, final } = foldTrace([permissionRequestEvent(), toolResultEvent()]);
    expect(trace.map((step) => step.status)).toEqual(["waiting", "running"]);
    expect(final).toBe("running");
  });

  it("error 旅程：协议错误进入 error，后续事件全部钉死", () => {
    const events = [
      sessionEvent("ext-abc"), // → ready
      messageEvent(), // → running
      toolUseEvent(), // → running
      errorEvent(), // → error（协议错误）
      messageEvent(), // rejected
      permissionRequestEvent(), // rejected
      statusEvent("stopped"), // rejected（终态吸收）
      sessionEvent(null), // rejected
    ];
    const { trace, final } = foldTrace(events);
    expect(trace.map((step) => step.status)).toEqual([
      "ready",
      "running",
      "running",
      "error",
      "error",
      "error",
      "error",
      "error",
    ]);
    expect(trace[4]?.transition).toBe("rejected");
    expect(trace[5]?.transition).toBe("rejected");
    expect(trace[6]?.transition).toBe("rejected");
    expect(trace[7]?.transition).toBe("rejected");
    expect(final).toBe("error");
  });

  it("非零退出旅程：error 事件终结，迟到的 status('stopped') 不改判（排序契约：先报非零退出）", () => {
    const { trace, final } = foldTrace([
      sessionEvent("ext-abc"),
      messageEvent(),
      errorEvent(),
      statusEvent("stopped"),
    ]);
    expect(trace.map((step) => step.status)).toEqual(["ready", "running", "error", "error"]);
    expect(final).toBe("error");
  });

  it("session 结束信号收尾：running + session → stopped", () => {
    const { trace, final } = foldTrace([
      sessionEvent("ext-abc"),
      messageEvent(),
      toolUseEvent(),
      toolResultEvent(),
      sessionEvent("ext-abc"), // 结束信号（core 定案）
    ]);
    expect(trace.map((step) => step.status)).toEqual([
      "ready",
      "running",
      "running",
      "running",
      "stopped",
    ]);
    expect(final).toBe("stopped");
  });

  it("终态吸收：stopped 之后的一切事件不再改变状态", () => {
    const events = [
      statusEvent("stopped"), // starting → stopped（任何活跃态→stopped）
      messageEvent(),
      toolUseEvent(),
      toolResultEvent(),
      permissionRequestEvent(),
      errorEvent(),
      sessionEvent("ext-abc"),
      statusEvent("running"),
    ];
    const { trace, final } = foldTrace(events);
    expect(trace[0]).toEqual({ status: "stopped", transition: "applied" });
    expect(trace.slice(1).every((step) => step.transition === "rejected")).toBe(true);
    expect(final).toBe("stopped");
  });

  it("任何活跃态→stopped：waiting 中直接收到干净退出信号", () => {
    const { trace, final } = foldTrace([
      permissionRequestEvent(), // → waiting
      statusEvent("stopped"), // waiting → stopped（进程退出）
    ]);
    expect(trace.map((step) => step.status)).toEqual(["waiting", "stopped"]);
    expect(final).toBe("stopped");
  });

  it("fold 确定性：同一事件序列两次折叠轨迹一致", () => {
    const events = [
      sessionEvent("ext-abc"),
      messageEvent(),
      permissionRequestEvent(),
      toolResultEvent(),
    ];
    expect(foldTrace(events)).toEqual(foldTrace(events));
  });

  it("fold 支持自定义起点（resume 场景从 ready 起步）", () => {
    const { trace, final } = foldTrace([messageEvent(), statusEvent("stopped")], "ready");
    expect(trace.map((step) => step.status)).toEqual(["running", "stopped"]);
    expect(final).toBe("stopped");
  });
});
