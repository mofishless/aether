// agent 卡片（P0-11）：每 session 一张——状态点（颜色映射 AgentStatus）+ 耗时
// （createdAt 起，本地秒级跳动；终态定格）+ 点击切活动视图。
// P1-01 支撑件：provider kind 标签（本地 spawn 时记录；无记录不渲染，不猜——
// Session 契约无 provider 字段。P1-01 评审 F2 接线后，记录值 = spawn 载荷所选
// kind，与 daemon 实际路由一致）。
import { useEffect, useState, type ReactElement } from "react";
import type { AgentStatus, Session } from "@aether/contracts";
import { setActiveSession, useAppStore } from "../state/app-store.js";
import { PROVIDER_CAPABILITIES } from "../state/provider-capabilities.js";

/** 状态点颜色映射（§8.1 七值；starting/ready/running/waiting 活跃，stopped/error 终态） */
const STATUS_DOT_CLASS: Readonly<Record<AgentStatus, string>> = {
  starting: "agent-dot--starting",
  ready: "agent-dot--ready",
  running: "agent-dot--running",
  waiting: "agent-dot--waiting",
  stopped: "agent-dot--stopped",
  error: "agent-dot--error",
};

const TERMINAL_STATUSES: readonly AgentStatus[] = ["stopped", "error"];

function formatElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/** 耗时文本：活跃态 createdAt→now（每秒重算）；终态定格 createdAt→lastActiveAt */
function useElapsedLabel(session: Session): string {
  const terminal = TERMINAL_STATUSES.includes(session.status);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (terminal) return; // 终态不再跳动
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [terminal]);
  const end = terminal ? Date.parse(session.lastActiveAt) : now;
  return formatElapsed(end - Date.parse(session.createdAt));
}

export function AgentCard(props: { session: Session; active: boolean }): ReactElement {
  const { session, active } = props;
  const elapsed = useElapsedLabel(session);
  // 基元选择器（string | undefined）：引用稳定，不触发 React #185 类重渲染
  const providerKind = useAppStore((state) => state.sessionProviderKinds[session.id]);
  return (
    <button
      type="button"
      data-testid="agent-card"
      className={`agent-card${active ? " agent-card--active" : ""}`}
      onClick={() => void setActiveSession(session.id)}
    >
      <span
        data-testid="agent-status-dot"
        className={`agent-dot ${STATUS_DOT_CLASS[session.status]}`}
      />
      <span className="agent-card-body">
        <span className="agent-card-line">
          <span data-testid="agent-status" className="agent-status-text">
            {session.status}
          </span>
          {providerKind !== undefined && (
            <span data-testid="agent-provider-kind" className="provider-chip">
              {PROVIDER_CAPABILITIES[providerKind].label}
            </span>
          )}
          <span data-testid="agent-elapsed" className="agent-elapsed">
            {elapsed}
          </span>
        </span>
        <span className="item-sub">{session.id.slice(0, 8)}</span>
      </span>
    </button>
  );
}

/** 左栏 agent 卡片列表（当前选中任务的 sessions） */
export function AgentCardList(): ReactElement {
  const sessions = useAppStore((state) => state.sessions);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  return (
    <section className="panel" data-testid="agent-panel">
      <h2 className="panel-title">Agents</h2>
      <ul className="item-list">
        {sessions.map((session) => (
          <li key={session.id}>
            <AgentCard session={session} active={session.id === activeSessionId} />
          </li>
        ))}
        {sessions.length === 0 && <li className="item-empty">选中任务后启动 agent</li>}
      </ul>
    </section>
  );
}
