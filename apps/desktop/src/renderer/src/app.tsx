// P0-10 渲染骨架 UI（极简）：连接状态徽标三态 + daemon 版本 + 事件计数 + 状态迁移历史。
// 真正的驾驶舱布局在 P0-11 落地；本组件只验证"渲染数据全部来自类型化通道"。
import type { ReactElement } from "react";
import type { RpcConnectionState } from "./rpc/rpc-client.js";
import { useConnectionStore } from "./state/connection-store.js";

const STATE_LABEL: Readonly<Record<RpcConnectionState, string>> = {
  connecting: "连接中",
  connected: "已连接",
  disconnected: "已断开",
};

export function App(): ReactElement {
  const connectionState = useConnectionStore((state) => state.connectionState);
  const daemonVersion = useConnectionStore((state) => state.daemonVersion);
  const eventCount = useConnectionStore((state) => state.eventCount);
  const eventsSubscribed = useConnectionStore((state) => state.eventsSubscribed);
  const lastError = useConnectionStore((state) => state.lastError);
  const transitions = useConnectionStore((state) => state.transitions);

  const versionText = daemonVersion === null ? "daemon 版本未知" : `daemon v${daemonVersion}`;
  const eventText = eventsSubscribed ? `事件 ${eventCount}` : `事件 ${eventCount}（通道未开放）`;
  const historyText = transitions.map((state) => STATE_LABEL[state]).join(" → ");

  return (
    <div className="app-shell">
      <header className="status-bar">
        <span data-testid="connection-badge" className={`badge badge--${connectionState}`}>
          {STATE_LABEL[connectionState]}
        </span>
        <span data-testid="daemon-version" className="meta">
          {versionText}
        </span>
        <span data-testid="event-count" className="meta">
          {eventText}
        </span>
      </header>
      {lastError !== null && (
        <p data-testid="last-error" className="last-error">
          {lastError}
        </p>
      )}
      <p data-testid="state-history" className="state-history">
        {historyText}
      </p>
    </div>
  );
}
