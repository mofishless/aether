import { describe, expect, it } from "vitest";
import type { AgentStatus } from "@aether/contracts";
import { applySessionEvent, INITIAL_AGENT_STATUS } from "../src/index.js";
import {
  errorEvent,
  messageEvent,
  permissionRequestEvent,
  sessionEvent,
  statusEvent,
  toolResultEvent,
  toolUseEvent,
} from "./helpers/provider-event-fixture.js";

// 状态机全路径单测（任务卡 P0-07 TDD 第 1 条：事件序列→状态迁移全路径含 error 分支）。
// 迁移规则 = SYSTEM_DESIGN §8.1 图 + ProviderEvent 语义的 core 定案：
// - 活跃态 = starting / ready / running / waiting；终态 = stopped / error；
// - message / tool_use / tool_result → running；permission_request → waiting；
// - error 事件 → error；status 事件按自报目标态查合法来源表；
// - session 事件：starting 中 = 握手（首个事件）→ ready；其余活跃态 = 结束信号 → stopped；
// - 终态吸收后续一切事件：rejected、状态不变。

const ACTIVE_STATUSES: readonly AgentStatus[] = ["starting", "ready", "running", "waiting"];
const TERMINAL_STATUSES: readonly AgentStatus[] = ["stopped", "error"];

describe("applySessionEvent 初始常量", () => {
  it("INITIAL_AGENT_STATUS = 'starting'", () => {
    expect(INITIAL_AGENT_STATUS).toBe("starting");
  });
});

describe("applySessionEvent(session 事件)", () => {
  it("starting + session(外部 id) → ready（applied，握手/首个事件，§8.1 行 1）", () => {
    const result = applySessionEvent("starting", sessionEvent("ext-abc"));
    expect(result).toEqual({ status: "ready", transition: "applied" });
  });

  it("starting + session(null) → ready（无外部 id 的 CLI 同样完成握手）", () => {
    const result = applySessionEvent("starting", sessionEvent(null));
    expect(result).toEqual({ status: "ready", transition: "applied" });
  });

  it.each(["ready", "running", "waiting"] as const)(
    "%s + session → stopped（applied，结束信号，core 定案）",
    (current) => {
      const result = applySessionEvent(current, sessionEvent("ext-abc"));
      expect(result).toEqual({ status: "stopped", transition: "applied" });
    },
  );

  it.each(TERMINAL_STATUSES)("%s + session → rejected 保持原状态", (current) => {
    const result = applySessionEvent(current, sessionEvent("ext-abc"));
    expect(result.status).toBe(current);
    expect(result.transition).toBe("rejected");
    expect(typeof result.reason).toBe("string");
  });
});

describe.each([
  { label: "message", build: messageEvent, target: "running" as const },
  { label: "tool_use", build: toolUseEvent, target: "running" as const },
  { label: "tool_result", build: toolResultEvent, target: "running" as const },
])("applySessionEvent($label 事件)", ({ label, build, target }) => {
  it.each(ACTIVE_STATUSES)("%s + %s → %s（applied；目标态与当前态相同为幂等应用）", (current) => {
    const result = applySessionEvent(current, build());
    expect(result).toEqual({ status: target, transition: "applied" });
  });

  it.each(TERMINAL_STATUSES)("%s + %s → rejected 保持原状态", (current) => {
    const result = applySessionEvent(current, build());
    expect(result.status).toBe(current);
    expect(result.transition).toBe("rejected");
    expect(result.reason).toBeTruthy();
  });

  it(`${label} 拒绝原因包含终态名与事件类型`, () => {
    const result = applySessionEvent("stopped", build());
    expect(result.reason).toContain("stopped");
    expect(result.reason).toContain(label);
  });
});

describe("applySessionEvent(permission_request 事件)", () => {
  it.each(ACTIVE_STATUSES)("%s + permission_request → waiting（applied）", (current) => {
    const result = applySessionEvent(current, permissionRequestEvent());
    expect(result).toEqual({ status: "waiting", transition: "applied" });
  });

  it.each(TERMINAL_STATUSES)("%s + permission_request → rejected 保持原状态", (current) => {
    const result = applySessionEvent(current, permissionRequestEvent());
    expect(result.status).toBe(current);
    expect(result.transition).toBe("rejected");
    expect(result.reason).toBeTruthy();
  });

  it("拒绝原因包含终态名与 permission_request", () => {
    const result = applySessionEvent("error", permissionRequestEvent());
    expect(result.reason).toContain("error");
    expect(result.reason).toContain("permission_request");
  });
});

describe("applySessionEvent(error 事件) —— error 分支全覆盖", () => {
  it.each(ACTIVE_STATUSES)("%s + error → error（applied，非零退出/协议错误，§8.1）", (current) => {
    const result = applySessionEvent(current, errorEvent());
    expect(result).toEqual({ status: "error", transition: "applied" });
  });

  it.each(TERMINAL_STATUSES)(
    "%s + error → rejected（终态吸收；error→error 重复报错同判拒绝）",
    (current) => {
      const result = applySessionEvent(current, errorEvent());
      expect(result.status).toBe(current);
      expect(result.transition).toBe("rejected");
      expect(result.reason).toBeTruthy();
    },
  );

  it("拒绝原因包含终态名与 error", () => {
    const result = applySessionEvent("stopped", errorEvent());
    expect(result.reason).toContain("stopped");
    expect(result.reason).toContain("error");
  });
});

describe("applySessionEvent(status 事件自报)", () => {
  describe.each([
    { target: "ready" as const, sources: ["starting", "ready"] as readonly AgentStatus[] },
    {
      target: "running" as const,
      sources: ACTIVE_STATUSES,
    },
    { target: "waiting" as const, sources: ACTIVE_STATUSES },
    { target: "stopped" as const, sources: ACTIVE_STATUSES },
    { target: "error" as const, sources: ACTIVE_STATUSES },
  ])("自报 '%s'", ({ target, sources }) => {
    const all: readonly AgentStatus[] = [...ACTIVE_STATUSES, ...TERMINAL_STATUSES];
    const rejectedSources = all.filter((status) => !sources.includes(status));

    it.each(sources)("%s + status('%s') → %s（applied）", (current) => {
      const result = applySessionEvent(current, statusEvent(target));
      expect(result).toEqual({ status: target, transition: "applied" });
    });

    it.each(rejectedSources)("非法来源 %s + status('%s') → rejected 保持原状态", (current) => {
      const result = applySessionEvent(current, statusEvent(target));
      expect(result.status).toBe(current);
      expect(result.transition).toBe("rejected");
      expect(result.reason).toBeTruthy();
    });
  });

  describe("自报 'starting'（不可回退，只在 spawn 时进入）", () => {
    it("starting + status('starting') → starting（applied，幂等重报）", () => {
      const result = applySessionEvent("starting", statusEvent("starting"));
      expect(result).toEqual({ status: "starting", transition: "applied" });
    });

    it.each(["ready", "running", "waiting", "stopped", "error"] as const)(
      "%s + status('starting') → rejected 保持原状态",
      (current) => {
        const result = applySessionEvent(current, statusEvent("starting"));
        expect(result.status).toBe(current);
        expect(result.transition).toBe("rejected");
        expect(result.reason).toBeTruthy();
      },
    );
  });

  it("running + status('ready') → rejected（§8.1 无 running→ready 回边）", () => {
    const result = applySessionEvent("running", statusEvent("ready"));
    expect(result).toEqual({
      status: "running",
      transition: "rejected",
      reason: expect.any(String),
    });
  });

  it("stopped + status('running') → rejected（任务卡示例：stopped→running 非法）", () => {
    const result = applySessionEvent("stopped", statusEvent("running"));
    expect(result.status).toBe("stopped");
    expect(result.transition).toBe("rejected");
    expect(result.reason).toContain("stopped");
  });

  it("error + status('stopped') → rejected（终态吸收：非零退出须在终态前报 error）", () => {
    const result = applySessionEvent("error", statusEvent("stopped"));
    expect(result.status).toBe("error");
    expect(result.transition).toBe("rejected");
    expect(result.reason).toBeTruthy();
  });

  it("stopped + status('stopped') → rejected（终态吸收重复停止信号）", () => {
    const result = applySessionEvent("stopped", statusEvent("stopped"));
    expect(result.status).toBe("stopped");
    expect(result.transition).toBe("rejected");
  });
});

describe("applySessionEvent 返回值契约", () => {
  it("applied 结果不带 reason 字段", () => {
    const result = applySessionEvent("ready", messageEvent());
    expect("reason" in result).toBe(false);
  });

  it("rejected 结果带非空 reason", () => {
    const result = applySessionEvent("stopped", messageEvent());
    expect(typeof result.reason).toBe("string");
    expect(result.reason?.length).toBeGreaterThan(0);
  });

  it("纯函数：同输入两次调用结果 deep 相等", () => {
    const first = applySessionEvent("running", permissionRequestEvent());
    const second = applySessionEvent("running", permissionRequestEvent());
    expect(first).toEqual(second);
  });
});
