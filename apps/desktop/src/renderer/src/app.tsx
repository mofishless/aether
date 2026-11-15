// P0-11 驾驶舱布局：顶栏连接/版本徽标（P0-10 保留）+ 左项目/任务/Agents 栏 +
// 右主区（活动视图 / diff 视图切换）。全部数据经 store（RPC 类型化通道），组件零 fs/net。
import { useState, type ReactElement } from "react";
import type { RpcConnectionState } from "./rpc/rpc-client.js";
import { useAppStore } from "./state/app-store.js";
import { useConnectionStore } from "./state/connection-store.js";
import { ActivityView } from "./components/ActivityView.js";
import { AgentCardList } from "./components/AgentCard.js";
import { DiffView } from "./components/DiffView.js";
import { ProjectList } from "./components/ProjectList.js";
import { SpawnAgentPanel } from "./components/SpawnAgentPanel.js";
import { TaskList } from "./components/TaskList.js";

const STATE_LABEL: Readonly<Record<RpcConnectionState, string>> = {
  connecting: "连接中",
  connected: "已连接",
  disconnected: "已断开",
};

type MainTab = "activity" | "diff";

export function App(): ReactElement {
  const connectionState = useConnectionStore((state) => state.connectionState);
  const daemonVersion = useConnectionStore((state) => state.daemonVersion);
  const eventCount = useConnectionStore((state) => state.eventCount);
  const connectionError = useConnectionStore((state) => state.lastError);
  const transitions = useConnectionStore((state) => state.transitions);
  const domainError = useAppStore((state) => state.lastError);
  const [tab, setTab] = useState<MainTab>("activity");

  const versionText = daemonVersion === null ? "daemon 版本未知" : `daemon v${daemonVersion}`;
  const historyText = transitions.map((state) => STATE_LABEL[state]).join(" → ");
  // 领域层最近错误（app-store）优先于连接层错误展示
  const errorText = domainError ?? connectionError;

  return (
    <div className="app-shell cockpit">
      <header className="status-bar">
        <span data-testid="connection-badge" className={`badge badge--${connectionState}`}>
          {STATE_LABEL[connectionState]}
        </span>
        <span data-testid="daemon-version" className="meta">
          {versionText}
        </span>
        <span data-testid="event-count" className="meta">
          事件 {eventCount}
        </span>
        <span data-testid="state-history" className="meta state-history">
          {historyText}
        </span>
      </header>
      {errorText !== null && (
        <p data-testid="last-error" className="last-error">
          {errorText}
        </p>
      )}
      <div className="cockpit-body">
        <aside className="cockpit-side">
          <ProjectList />
          <TaskList />
          <SpawnAgentPanel />
          <AgentCardList />
        </aside>
        <main className="cockpit-main">
          <nav className="tab-bar">
            <button
              type="button"
              data-testid="tab-activity"
              className={`tab${tab === "activity" ? " tab--active" : ""}`}
              onClick={() => setTab("activity")}
            >
              活动
            </button>
            <button
              type="button"
              data-testid="tab-diff"
              className={`tab${tab === "diff" ? " tab--active" : ""}`}
              onClick={() => setTab("diff")}
            >
              Diff
            </button>
          </nav>
          {tab === "activity" ? <ActivityView /> : <DiffView />}
        </main>
      </div>
    </div>
  );
}
