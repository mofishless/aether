import type { AgentStatus, ProviderEvent } from "@aether/contracts";

// ===== Claude 会话状态机（SYSTEM_DESIGN §8.1：starting → ready → running ↔ waiting → stopped / error）=====
// 纯函数：输入 (当前状态, ProviderEvent) → 迁移结果；不可变、无副作用、不读时钟/存储。
// daemon 侧按事件到达顺序 fold；状态迁移、落库与渲染共用同一结果。
//
// core 定案（§8.1 图 + ProviderEvent 七成员语义细化）：
// - 活跃态 = starting / ready / running / waiting；终态 = stopped / error；
// - message / tool_use / tool_result → running：任何活跃态可进
//   （首个事件即活动的 CLI 不强迫经过 ready；waiting 中收到 = 权限拒绝后的替代输出）；
// - permission_request → waiting：任何活跃态可进（含 waiting 内再次请求，幂等）；
// - error 事件 → error（非零退出 / 协议错误）；
// - status 事件按自报目标态查合法来源表（见 STATUS_REPORT_SOURCES）；
//   stopped 从任何活跃态可进（§8.1"任何状态→stopped（进程退出）"）；
// - session 事件：starting 中 = 握手/首个事件 → ready（externalSessionId 是否为 null 均可）；
//   其余活跃态中 = 会话结束信号 → stopped。adapter 约定：session 事件只在生命周期边界
//   （init / 结束）发出，不作中途 externalSessionId 刷新；
// - 终态吸收后续一切事件：rejected、状态不变、附原因。
//   排序契约：adapter 须在进程退出证明后先判定非零退出（发 error）、干净退出才发 stopped；
//   终态之后到达的一切事件（含重复停止信号）均 rejected，状态不再改判。

/** 单次迁移结果：status 在 rejected 时 = 原状态不变（不可变返回，不修改入参）。 */
export interface SessionTransitionResult {
  readonly status: AgentStatus;
  /** applied = 接受（含目标态与当前态相同的幂等应用）；rejected = 非法迁移，保持原状态 */
  readonly transition: "applied" | "rejected";
  /** 仅 rejected 时给出：人类可读原因（含状态名/事件类型） */
  readonly reason?: string;
}

/** 会话初始状态：spawn 已持久预留（session 行已建）、协议尚未握手（§8.1 starting）。 */
export const INITIAL_AGENT_STATUS: AgentStatus = "starting";

const ACTIVE_STATUSES: readonly AgentStatus[] = ["starting", "ready", "running", "waiting"];

function isActive(status: AgentStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

function applied(status: AgentStatus): SessionTransitionResult {
  return { status, transition: "applied" };
}

function rejected(status: AgentStatus, reason: string): SessionTransitionResult {
  return { status, transition: "rejected", reason };
}

// status 事件自报各目标态的合法来源（§8.1 图）：
// - ready 仅握手期进入（starting）；ready→ready 为幂等重报；
// - running / waiting 任何活跃态可进；stopped = 任何活跃态（进程退出）；error 同左；
// - starting 不可回退（只在 spawn 时进入，无入边）。
const STATUS_REPORT_SOURCES: Readonly<Record<AgentStatus, readonly AgentStatus[]>> = {
  starting: ["starting"],
  ready: ["starting", "ready"],
  running: ["starting", "ready", "running", "waiting"],
  waiting: ["starting", "ready", "running", "waiting"],
  stopped: ["starting", "ready", "running", "waiting"],
  error: ["starting", "ready", "running", "waiting"],
};

function applyStatusReport(current: AgentStatus, target: AgentStatus): SessionTransitionResult {
  const sources = STATUS_REPORT_SOURCES[target];
  if (sources.includes(current)) {
    return applied(target);
  }
  if (!isActive(current)) {
    return rejected(
      current,
      `终态 '${current}' 拒绝 status 自报 '${target}'（终态吸收后续一切事件）`,
    );
  }
  return rejected(
    current,
    `非法迁移 ${current} → ${target}（§8.1：starting → ready → running ↔ waiting → stopped/error）`,
  );
}

function applyActivity(
  current: AgentStatus,
  eventType: ProviderEvent["type"],
  target: "running" | "waiting",
): SessionTransitionResult {
  if (isActive(current)) {
    return applied(target);
  }
  return rejected(
    current,
    `终态 '${current}' 拒绝事件 '${eventType}'（会话已结束，不接受活动/权限事件）`,
  );
}

function applyError(current: AgentStatus): SessionTransitionResult {
  if (isActive(current)) {
    return applied("error");
  }
  return rejected(
    current,
    `终态 '${current}' 拒绝 error 事件（终态吸收后续一切事件；非零退出须在终态前报出）`,
  );
}

function applySessionLifecycle(current: AgentStatus): SessionTransitionResult {
  if (current === "starting") {
    return applied("ready");
  }
  if (isActive(current)) {
    return applied("stopped");
  }
  return rejected(current, `终态 '${current}' 拒绝 session 事件（终态吸收后续一切事件）`);
}

/** 状态机主函数：(当前状态, 归一化事件) → 下一状态结果（七事件类型全覆盖）。 */
export function applySessionEvent(
  current: AgentStatus,
  event: ProviderEvent,
): SessionTransitionResult {
  switch (event.type) {
    case "status":
      return applyStatusReport(current, event.status);
    case "message":
    case "tool_use":
    case "tool_result":
      return applyActivity(current, event.type, "running");
    case "permission_request":
      return applyActivity(current, event.type, "waiting");
    case "error":
      return applyError(current);
    case "session":
      return applySessionLifecycle(current);
  }
}
