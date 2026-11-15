import type { AgentStatus, ProviderEvent } from "@aether/contracts";

// ProviderEvent 构造助手：状态机是纯函数，不校验事件载荷，只需满足类型形状。
// occurredAt 取 contracts z.iso.datetime() 认可的 Z 后缀形态。

const SESSION_ID = "session-1";
const OCCURRED_AT = "2026-01-01T00:00:00Z";

function seqId(seq: number): string {
  return `ev-${seq}`;
}

export function statusEvent(status: AgentStatus, seq = 1): ProviderEvent {
  return {
    eventId: seqId(seq),
    sessionId: SESSION_ID,
    occurredAt: OCCURRED_AT,
    type: "status",
    status,
  };
}

export function messageEvent(seq = 1): ProviderEvent {
  return {
    eventId: seqId(seq),
    sessionId: SESSION_ID,
    occurredAt: OCCURRED_AT,
    type: "message",
    content: "assistant 文本",
  };
}

export function toolUseEvent(seq = 1): ProviderEvent {
  return {
    eventId: seqId(seq),
    sessionId: SESSION_ID,
    occurredAt: OCCURRED_AT,
    type: "tool_use",
    toolUseId: "tu-1",
    name: "bash",
    input: null,
  };
}

export function toolResultEvent(seq = 1): ProviderEvent {
  return {
    eventId: seqId(seq),
    sessionId: SESSION_ID,
    occurredAt: OCCURRED_AT,
    type: "tool_result",
    toolUseId: "tu-1",
    output: null,
    isError: false,
  };
}

export function permissionRequestEvent(seq = 1): ProviderEvent {
  return {
    eventId: seqId(seq),
    sessionId: SESSION_ID,
    occurredAt: OCCURRED_AT,
    type: "permission_request",
    requestId: "req-1",
    toolName: "bash",
    summary: "运行测试",
  };
}

export function sessionEvent(externalSessionId: string | null, seq = 1): ProviderEvent {
  return {
    eventId: seqId(seq),
    sessionId: SESSION_ID,
    occurredAt: OCCURRED_AT,
    type: "session",
    externalSessionId,
  };
}

export function errorEvent(seq = 1): ProviderEvent {
  return {
    eventId: seqId(seq),
    sessionId: SESSION_ID,
    occurredAt: OCCURRED_AT,
    type: "error",
    message: "协议错误",
  };
}
