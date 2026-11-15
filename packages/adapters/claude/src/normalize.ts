import type { ProviderEvent } from "@aether/contracts";

// ===== SDK stream-json 事件 → ProviderEvent 归一化（纯函数模块）=====
// 形状依据：@anthropic-ai/claude-agent-sdk@0.3.325 sdk.d.ts（SDKMessage 联合）+
// 官方文档 https://code.claude.com/docs/en/agent-sdk/typescript。
// 在线路径（adapter 泵）与旁路转换器（normalizeLogs 重放）共用同一映射表；
// vendor 格式变化只改本文件（调研 05.C #5）。
//
// 映射表（SYSTEM_DESIGN §6.2 七成员）：
// - system/init        → session(externalSessionId) + status(ready)
// - assistant 文本块    → message；tool_use 块 → tool_use
// - user tool_result 块 → tool_result
// - result             → 终态意图（clean/error），不立即物化事件：
//   在线路径须等进程退出证明后按排序契约物化（先判非零退出）；
//   重放路径（normalizeStream）无退出证明，按 result 自报物化。
// - 其余已知无映射成员（stream_event / system:status / system:compact_boundary …）
//   与未知事件 → 跳过并按类型标签计数（容忍策略，不抛）。

/** 重放占位时间：vendor 帧（assistant/user）无 timestamp 字段时使用（P0-09 落库时以行时间为准） */
export const EPOCH_PLACEHOLDER = "1970-01-01T00:00:00Z";

/** 单条消息归一化上下文（occurredAt/eventId 由调用方决定：在线=now/vendor timestamp，重放=timestamp/占位） */
export interface MessageContext {
  readonly sessionId: string;
  /** 流内 1 起单调序号（eventId 组成部分） */
  readonly seq: number;
  readonly occurredAt: string;
  /** eventId 前缀（在线=processId，重放="log"） */
  readonly eventIdPrefix: string;
}

/** result 帧的终态意图：由 adapter 结合退出证明物化（重放路径按自报物化） */
export type TerminalIntent =
  | { readonly kind: "clean"; readonly externalSessionId: string | null }
  | { readonly kind: "error"; readonly message: string };

export interface MappedMessage {
  readonly events: ProviderEvent[];
  /** 跳过时的类型标签（计数键）；null = 已映射或已知形状但零事件（不计数） */
  readonly skippedType: string | null;
  /** init/result 帧携带的外部会话 id（供 --resume） */
  readonly externalSessionId: string | null;
  readonly terminal: TerminalIntent | null;
}

export interface NormalizeStreamInput {
  readonly sessionId: string;
  readonly messages: readonly unknown[];
  /** vendor 帧无 timestamp 时的 occurredAt 兜底（默认 EPOCH_PLACEHOLDER） */
  readonly occurredAtFallback?: string;
}

export interface NormalizeStreamResult {
  readonly events: ProviderEvent[];
  /** 类型标签 → 跳过条数（未知/无映射事件容忍计数） */
  readonly skipped: Readonly<Record<string, number>>;
  /** 最后一帧 result 的终态意图（已物化为末尾事件；无 result 时为 null） */
  readonly terminal: TerminalIntent | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 单条 SDK 消息 → ProviderEvent 数组（+跳过标签 +终态意图）。纯函数、无副作用。 */
export function mapSdkMessage(message: unknown, ctx: MessageContext): MappedMessage {
  const record = asRecord(message);
  if (record === null) {
    return { events: [], skippedType: "unknown", externalSessionId: null, terminal: null };
  }
  const type = nonEmptyString(record.type);
  const events: ProviderEvent[] = [];
  // eventId 后缀 = 源内位置（content 块下标），非发出计数：丢弃块不占号，
  // 同一 vendor 帧重放得到稳定 eventId
  const base = (index: number): { eventId: string; sessionId: string; occurredAt: string } => ({
    eventId: `${ctx.eventIdPrefix}-${ctx.seq}-${index}`,
    sessionId: ctx.sessionId,
    occurredAt: ctx.occurredAt,
  });

  if (type === "system") {
    const subtype = nonEmptyString(record.subtype) ?? "unknown";
    if (subtype === "init") {
      const externalSessionId = nonEmptyString(record.session_id);
      events.push({ ...base(0), type: "session", externalSessionId });
      events.push({ ...base(1), type: "status", status: "ready" });
      return { events, skippedType: null, externalSessionId, terminal: null };
    }
    return {
      events,
      skippedType: `system/${subtype}`,
      externalSessionId: null,
      terminal: null,
    };
  }

  if (type === "assistant") {
    const assistant = asRecord(record.message);
    const content = assistant !== null ? assistant.content : undefined;
    if (!Array.isArray(content)) {
      return { events, skippedType: "assistant", externalSessionId: null, terminal: null };
    }
    for (let index = 0; index < content.length; index += 1) {
      const block = asRecord(content[index]);
      if (block === null) continue;
      if (block.type === "text") {
        const text = typeof block.text === "string" ? block.text.trim() : "";
        if (text.length > 0) {
          events.push({ ...base(index), type: "message", content: text });
        }
        continue; // 空 text 块：已知形状，静默丢弃
      }
      if (block.type === "tool_use") {
        const toolUseId = nonEmptyString(block.id);
        const name = nonEmptyString(block.name);
        if (toolUseId !== null && name !== null) {
          events.push({
            ...base(index),
            type: "tool_use",
            toolUseId,
            name,
            input: block.input,
          });
        }
        continue;
      }
      // thinking 等其余块类型：已知形状，无 ProviderEvent 成员，静默丢弃
    }
    const errorTag = nonEmptyString(record.error);
    if (errorTag !== null) {
      events.push({ ...base(content.length), type: "error", message: `assistant ${errorTag}` });
    }
    return { events, skippedType: null, externalSessionId: null, terminal: null };
  }

  if (type === "user") {
    const user = asRecord(record.message);
    const content = user !== null ? user.content : undefined;
    if (Array.isArray(content)) {
      for (let index = 0; index < content.length; index += 1) {
        const block = asRecord(content[index]);
        if (block === null || block.type !== "tool_result") continue; // 文本型 user 帧：静默丢弃
        const toolUseId = nonEmptyString(block.tool_use_id);
        if (toolUseId === null) continue;
        events.push({
          ...base(index),
          type: "tool_result",
          toolUseId,
          output: block.content,
          isError: block.is_error === true,
        });
      }
    }
    return { events, skippedType: null, externalSessionId: null, terminal: null };
  }

  if (type === "result") {
    const externalSessionId = nonEmptyString(record.session_id);
    const subtype = nonEmptyString(record.subtype);
    if (subtype === "success") {
      const isError = record.is_error === true;
      const terminal: TerminalIntent = isError
        ? { kind: "error", message: nonEmptyString(record.result) ?? "轮内错误（result.is_error）" }
        : { kind: "clean", externalSessionId };
      return { events, skippedType: null, externalSessionId, terminal };
    }
    if (subtype !== null && subtype.startsWith("error_")) {
      const errors = Array.isArray(record.errors) ? record.errors : [];
      const message =
        errors
          .map((entry) => (typeof entry === "string" ? entry : ""))
          .filter((entry) => entry.length > 0)
          .join("; ") || (subtype as string);
      return { events, skippedType: null, externalSessionId, terminal: { kind: "error", message } };
    }
    return {
      events,
      skippedType: `result/${subtype ?? "unknown"}`,
      externalSessionId,
      terminal: null,
    };
  }

  if (type === "stream_event") {
    // includePartialMessages=false 时不应出现；开着时 P0 也不消费增量
    return { events, skippedType: "stream_event", externalSessionId: null, terminal: null };
  }

  return { events, skippedType: type ?? "unknown", externalSessionId: null, terminal: null };
}

/** vendor 帧 ISO timestamp（assistant/user 可带；缺失返回 null） */
export function vendorTimestamp(message: unknown): string | null {
  const record = asRecord(message);
  return record === null ? null : nonEmptyString(record.timestamp);
}

/**
 * 整流归一化（normalizeLogs 重放路径）：逐条 mapSdkMessage，终态按 result 自报物化
 * （无进程退出证明可依；在线路径见 adapter 的排序契约处理）。
 */
export function normalizeStream(input: NormalizeStreamInput): NormalizeStreamResult {
  const { sessionId, messages } = input;
  const fallback = input.occurredAtFallback ?? EPOCH_PLACEHOLDER;
  const events: ProviderEvent[] = [];
  const skipped: Record<string, number> = {};
  let terminal: TerminalIntent | null = null;
  let terminalContext: MessageContext | null = null;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const seq = index + 1;
    const occurredAt = vendorTimestamp(message) ?? fallback;
    const ctx: MessageContext = { sessionId, seq, occurredAt, eventIdPrefix: "log" };
    const mapped = mapSdkMessage(message, ctx);
    if (mapped.skippedType !== null) {
      const key = mapped.skippedType;
      skipped[key] = (skipped[key] ?? 0) + 1;
    }
    if (mapped.terminal !== null) {
      terminal = mapped.terminal;
      terminalContext = ctx;
    }
    events.push(...mapped.events);
  }

  if (terminal !== null && terminalContext !== null) {
    if (terminal.kind === "error") {
      events.push({
        eventId: `${terminalContext.eventIdPrefix}-${terminalContext.seq}-end`,
        sessionId,
        occurredAt: terminalContext.occurredAt,
        type: "error",
        message: terminal.message,
      });
    } else {
      events.push({
        eventId: `${terminalContext.eventIdPrefix}-${terminalContext.seq}-end`,
        sessionId,
        occurredAt: terminalContext.occurredAt,
        type: "session",
        externalSessionId: terminal.externalSessionId,
      });
    }
  }

  return { events, skipped, terminal };
}
