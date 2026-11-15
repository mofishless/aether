// agent 活动视图（P0-11）：session.<id>.events 结构化事件流渲染——message 气泡 /
// tool_use 工具名行 / tool_result 结果行 / status·session·error 细行；底部跟问输入框；
// 活动会话有待批权限时渲染批准/拒绝弹层（agents.permission.respond）。
import { useState, type FormEvent, type ReactElement } from "react";
import type { ProviderEvent } from "@aether/contracts";
import { respondPermission, sendFollowUp, useAppStore } from "../state/app-store.js";

/** tool_use.input / tool_result.output 的展示截断（任意 JSON → 单行文本） */
const OUTPUT_PREVIEW_LIMIT = 200;

function previewOf(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "";
  return text.length > OUTPUT_PREVIEW_LIMIT ? `${text.slice(0, OUTPUT_PREVIEW_LIMIT)}…` : text;
}

function EventRow(props: { event: ProviderEvent }): ReactElement {
  const { event } = props;
  switch (event.type) {
    case "message":
      return (
        <div
          data-testid="activity-event"
          data-event-type="message"
          className="bubble bubble--message"
        >
          {event.content}
        </div>
      );
    case "tool_use":
      return (
        <div data-testid="activity-event" data-event-type="tool_use" className="activity-tool">
          工具 {event.name}
          <span className="activity-tool-input">{previewOf(event.input)}</span>
        </div>
      );
    case "tool_result":
      return (
        <div
          data-testid="activity-event"
          data-event-type="tool_result"
          className={`activity-result${event.isError ? " activity-result--error" : ""}`}
        >
          ↳ {previewOf(event.output)}
        </div>
      );
    case "status":
      return (
        <div data-testid="activity-event" data-event-type="status" className="activity-fine">
          状态 → {event.status}
        </div>
      );
    case "session":
      return (
        <div data-testid="activity-event" data-event-type="session" className="activity-fine">
          会话 {event.externalSessionId ?? "（无外部会话 id）"}
        </div>
      );
    case "error":
      return (
        <div
          data-testid="activity-event"
          data-event-type="error"
          className="activity-fine activity-fine--error"
        >
          错误：{event.message}
        </div>
      );
    case "permission_request":
      return (
        <div
          data-testid="activity-event"
          data-event-type="permission_request"
          className="activity-fine"
        >
          请求权限：{event.toolName}
        </div>
      );
  }
}

/** 待批权限弹层（批准 = approve / 拒绝 = deny，均调 agents.permission.respond） */
function PermissionPrompt(props: {
  requestId: string;
  toolName: string;
  summary: string;
}): ReactElement {
  const { requestId, toolName, summary } = props;
  return (
    <div data-testid="permission-prompt" className="permission-prompt">
      <div className="permission-prompt-body">
        <strong>agent 请求权限</strong>
        <div>工具：{toolName}</div>
        <div className="permission-summary">{summary}</div>
      </div>
      <div className="permission-actions">
        <button
          type="button"
          data-testid="permission-approve"
          onClick={() => void respondPermission(requestId, "approve")}
        >
          批准
        </button>
        <button
          type="button"
          data-testid="permission-deny"
          onClick={() => void respondPermission(requestId, "deny")}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}

/** 无会话/无事件时的共享空数组：selector 必须返回稳定引用（每次新 [] 会触发
 *  useSyncExternalStore 快照不稳定 → 无限重渲染 → React #185，E2E 实测翻车点） */
const EMPTY_EVENTS: readonly ProviderEvent[] = [];

export function ActivityView(): ReactElement {
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const eventsBySession = useAppStore((state) => state.eventsBySession);
  const pendingPermissions = useAppStore((state) => state.pendingPermissions);
  // 派生在 selector 外做（引用恒取 store 既有切片或模块级空数组）
  const events =
    activeSessionId === null ? EMPTY_EVENTS : (eventsBySession[activeSessionId] ?? EMPTY_EVENTS);
  const pending =
    activeSessionId === null
      ? undefined
      : pendingPermissions.find((item) => item.sessionId === activeSessionId);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  const onSend = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (message.trim().length === 0 || activeSessionId === null || sending) return;
    setSending(true);
    const ok = await sendFollowUp(message.trim());
    setSending(false);
    if (ok) setMessage("");
  };

  if (activeSessionId === null) {
    return (
      <div data-testid="activity-empty" className="empty-state">
        选择一个 agent 卡片查看活动
      </div>
    );
  }

  return (
    <div data-testid="activity-view" className="activity-view">
      {pending !== undefined && (
        <PermissionPrompt
          requestId={pending.requestId}
          toolName={pending.toolName}
          summary={pending.summary}
        />
      )}
      <div className="activity-stream">
        {events.map((event) => (
          <EventRow key={`${event.eventId}@${event.occurredAt}`} event={event} />
        ))}
        {events.length === 0 && <div className="empty-state">暂无事件</div>}
      </div>
      <form className="inline-form follow-up-form" onSubmit={(event) => void onSend(event)}>
        <input
          data-testid="follow-up-input"
          placeholder="跟问一条消息…"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <button type="submit" data-testid="follow-up-send" disabled={sending}>
          发送
        </button>
      </form>
    </div>
  );
}
