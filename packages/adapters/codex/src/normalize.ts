// ===== Codex app-server 通知/ThreadItem → ProviderEvent 归一化（纯函数，协议定案 §3/§4/§10）=====
// 在线路径（adapter 通知泵）与旁路转换器（normalizeLogs 重放）共用同一映射表；
// vendor 协议演进只改本文件（P0-07 同款纪律）。
//
// 映射定案（§10）：
// - agentMessage → message；commandExecution：item/started→tool_use、item/completed→tool_result
// - reasoning/plan → message 附 kind 标注（contracts 无 agent_reasoning 成员，定案走 message+kind；
//   contracts ProviderEvent.message 已声明可选 kind（P1-01 评审 F6）——zod 默认保留
//   声明过的键，live/落库/重放三面一致，无需"剥除前尽力透传"）
// - error 通知 → error 事件（willRetry=false 才映射；true 为瞬时重试不打断 turn）
// - turn/completed(status=failed) → error；completed/interrupted 不发终态（进程长活，
//   终态由退出证明物化，与 claude adapter 排序契约同构）
// - eventId：通知 `${method}:${threadId}:${itemId||turnId}:${emittedAtMs}`（P0-11 去重键约束）；
//   审批 `approval:${approvalId||itemId}`；水合历史 `history:${threadId}:${itemId}`
import type { ProviderEvent } from "@aether/contracts";
import type { AutonomyLevel } from "@aether/contracts";
import type { ServerNotificationFrame } from "./frame-router.js";

/** 重放占位时间：无 emittedAtMs 的通知帧使用（P0-09 落库时以行时间为准，与 claude 侧同款） */
export const EPOCH_PLACEHOLDER = "1970-01-01T00:00:00Z";

/** message 事件的 kind 标注（reasoning/plan 归入 message 时携带；contracts 已声明可选 kind，端到端保留） */
export type CodexMessageEvent = Extract<ProviderEvent, { type: "message" }> & {
  readonly kind?: "reasoning" | "plan";
};

// ---- 基础取值工具（外部 wire 数据一律 unknown 收窄，不信任）----

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** emittedAtMs（毫秒纪元）→ ISO-8601；缺失/非法回退 fallback */
export function isoFromEmittedAt(emittedAtMs: unknown, fallback: string): string {
  return typeof emittedAtMs === "number" && Number.isFinite(emittedAtMs)
    ? new Date(emittedAtMs).toISOString()
    : fallback;
}

// ---- §3.1 用户输入构造（text_elements 蛇形必填数组陷阱，§9-1：省略勿传 null）----

/** text 变体 UserInput：只带 type/text，text_elements 由 serde default 省略时生效 */
export function textUserInput(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

// ---- §6 autonomy → (sandbox, approvalPolicy) 映射（sandbox 与 permissions 互斥，只用 sandbox 维）----

export interface CodexPolicy {
  readonly sandbox: "read-only" | "workspace-write" | "danger-full-access";
  readonly approvalPolicy: "untrusted" | "on-request" | "never";
}

export function autonomyToCodexPolicy(autonomy: AutonomyLevel): CodexPolicy {
  switch (autonomy) {
    case "read_only":
      return { sandbox: "read-only", approvalPolicy: "untrusted" };
    case "workspace_write":
      return { sandbox: "workspace-write", approvalPolicy: "on-request" };
    case "auto":
      return { sandbox: "danger-full-access", approvalPolicy: "never" };
  }
}

// ---- §4 审批映射（v2 为主，v1 DEPRECATED 兜底；decline≠cancel）----

/** 审批裁决档位（端口 PermissionDecision 为 approve/deny 两档；always 为映射表完备性保留） */
export type ApprovalChoice = "allow" | "always" | "deny";

/** v2 decision 值域子集（§4 定案映射：allow→accept / always→acceptForSession / deny→decline） */
export function v2ApprovalDecision(choice: ApprovalChoice): string {
  switch (choice) {
    case "allow":
      return "accept";
    case "always":
      return "acceptForSession";
    case "deny":
      return "decline";
  }
}

/** v1 蛇形 ReviewDecision（DEPRECATED 兜底：approved 系 / denied{rejection}） */
export function v1ApprovalDecision(choice: ApprovalChoice): unknown {
  switch (choice) {
    case "allow":
      return "approved";
    case "always":
      return "approved_for_session";
    case "deny":
      return { denied: { rejection: "用户拒绝" } };
  }
}

/** v2 审批方法（§4 表）与 v1 遗留（DEPRECATED，仅兜底识别） */
export const V2_APPROVAL_METHODS: readonly string[] = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
];
export const V1_APPROVAL_METHODS: readonly string[] = ["execCommandApproval", "applyPatchApproval"];

/**
 * 权限扩展审批方法（§4 表第三行）。应答形状与 decision 系方法不同——官方 schema
 * （PermissionsRequestApprovalResponse）：
 * - 应答 = {permissions: GrantedPermissionProfile(必填), scope: 'turn'|'session'(缺省 turn), strictAutoReview?}
 * - GrantedPermissionProfile = {fileSystem: AdditionalFileSystemPermissions|null, network: AdditionalNetworkPermissions|null}
 *   ——全字段可空，值域里**没有 decline 字面量**：deny = 空授权（唯一合法拒绝形状），
 *   approve = 请求 params.permissions 原样回授（RequestPermissionProfile 与 Granted 同构）。
 */
export const PERMISSIONS_APPROVAL_METHOD = "item/permissions/requestApproval";

/** permissions 方法应答的 GrantedPermissionProfile 形状（值透传，只声明已知两键） */
export interface GrantedPermissionProfile {
  readonly fileSystem: unknown;
  readonly network: unknown;
}

/** permissions 方法应答构造：approve → 请求 profile 原样回授；deny → 空授权 */
export function v2PermissionsGrant(
  choice: ApprovalChoice,
  requestParams: unknown,
): { permissions: GrantedPermissionProfile; scope: "turn" } {
  const requested = choice === "deny" ? null : asRecord(asRecord(requestParams)?.["permissions"]);
  return {
    permissions: {
      fileSystem: requested?.["fileSystem"] ?? null,
      network: requested?.["network"] ?? null,
    },
    scope: "turn",
  };
}

export function isApprovalMethod(method: string): boolean {
  return V2_APPROVAL_METHODS.includes(method) || V1_APPROVAL_METHODS.includes(method);
}

/** 审批短名（permission_request.toolName 用）：commandExecution / fileChange / permissions / v1 名 */
export function approvalToolName(method: string): string {
  if (method === "item/commandExecution/requestApproval") return "commandExecution";
  if (method === "item/fileChange/requestApproval") return "fileChange";
  if (method === "item/permissions/requestApproval") return "permissions";
  return method === "execCommandApproval" ? "execCommand(v1)" : "applyPatch(v1)";
}

/** 审批摘要：命令/文件清单/权限扩展，尽力从 params 提取（v1 容错）。
 * 双线对账（P1-01）：commandExecution 真实 wire 的命令在 params.call（CommandCall
 * {command, cwd?}，fixtures codex 引擎同口径）；fileChange 携整个 item（changes 清单）。
 * 两形状都容错读取（item 优先，次 call，末平铺）。 */
export function approvalSummary(method: string, params: unknown): string {
  const record = asRecord(params);
  const item = record !== null ? asRecord(record["item"]) : null;
  const call = record !== null ? asRecord(record["call"]) : null;
  const source = item ?? call ?? record;
  const command =
    source !== null
      ? (nonEmptyString(source["command"]) ??
        nonEmptyString(source["cmd"]) ??
        nonEmptyString(source["proposal"]))
      : null;
  if (command !== null) {
    return `命令：${command}`;
  }
  const changes = source !== null ? source["changes"] : undefined;
  if (Array.isArray(changes)) {
    const paths = changes
      .map((change) => nonEmptyString(asRecord(change)?.["path"]))
      .filter((path): path is string => path !== null);
    if (paths.length > 0) {
      return `文件变更：${paths.slice(0, 5).join(", ")}${paths.length > 5 ? " 等" : ""}`;
    }
  }
  if (method === "item/permissions/requestApproval") {
    return "权限扩展请求";
  }
  return `${approvalToolName(method)} 请求审批`;
}

/** 审批路由键（requestId 与 eventId 共用）：approvalId || itemId（§10 定案） */
export function extractApprovalKey(params: unknown): string | null {
  const record = asRecord(params);
  if (record === null) return null;
  return nonEmptyString(record["approvalId"]) ?? nonEmptyString(record["itemId"]);
}

export interface ApprovalEventContext {
  readonly sessionId: string;
  readonly occurredAt: string;
  /** 键兜底（approvalId/itemId 均缺时用服务端请求 id 字符串化） */
  readonly fallbackKey: string;
}

/** 审批服务端请求 → permission_request 事件（未识别方法返回 null） */
export function approvalEventFor(
  method: string,
  params: unknown,
  ctx: ApprovalEventContext,
): { event: ProviderEvent; key: string } | null {
  if (!isApprovalMethod(method)) {
    return null;
  }
  const key = extractApprovalKey(params) ?? ctx.fallbackKey;
  const event: ProviderEvent = {
    eventId: `approval:${key}`,
    sessionId: ctx.sessionId,
    occurredAt: ctx.occurredAt,
    type: "permission_request",
    requestId: key,
    toolName: approvalToolName(method),
    summary: approvalSummary(method, params),
  };
  return { event, key };
}

// ---- §3.2 ThreadItem → 事件（tool_use/tool_result/message/error）----

/** item 事件的来源相位：在线 started / 在线 completed / 历史水合（resume 内嵌 turns） */
export type ItemPhase = "live-started" | "live-completed" | "hydrated";

export interface ItemEventContext {
  readonly sessionId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly occurredAt: string;
  /** eventId 前缀 = 来源 method（item/started | item/completed）或 "history" */
  readonly eventIdPrefix: string;
}

export interface ItemMapped {
  readonly events: ProviderEvent[];
  /** 跳过标签（计数键）；null = 已映射或该相位本就零事件 */
  readonly skippedType: string | null;
}

/** §10 eventId 公式：`${method}:${threadId}:${itemId||turnId}:${emittedAtMs}` */
function notificationEventId(
  method: string,
  threadId: string,
  itemIdOrTurn: string,
  ts: string,
): string {
  return `${method}:${threadId}:${itemIdOrTurn}:${ts}`;
}

function commandExecutionStarted(
  item: Record<string, unknown>,
  ctx: ItemEventContext,
): ProviderEvent {
  return {
    eventId: notificationEventId(
      ctx.eventIdPrefix,
      ctx.threadId,
      nonEmptyString(item["id"]) ?? ctx.turnId,
      ctx.occurredAt,
    ),
    sessionId: ctx.sessionId,
    occurredAt: ctx.occurredAt,
    type: "tool_use",
    toolUseId: nonEmptyString(item["id"]) ?? `${ctx.turnId}-cmd`,
    name: "commandExecution",
    input: {
      command: item["command"] ?? null,
      ...(item["cwd"] !== undefined ? { cwd: item["cwd"] } : {}),
    },
  };
}

function fileChangeStarted(item: Record<string, unknown>, ctx: ItemEventContext): ProviderEvent {
  return {
    eventId: notificationEventId(
      ctx.eventIdPrefix,
      ctx.threadId,
      nonEmptyString(item["id"]) ?? ctx.turnId,
      ctx.occurredAt,
    ),
    sessionId: ctx.sessionId,
    occurredAt: ctx.occurredAt,
    type: "tool_use",
    toolUseId: nonEmptyString(item["id"]) ?? `${ctx.turnId}-file`,
    name: "fileChange",
    input: { changes: item["changes"] ?? [] },
  };
}

function mcpToolCallStarted(item: Record<string, unknown>, ctx: ItemEventContext): ProviderEvent {
  const server = nonEmptyString(item["server"]);
  const tool = nonEmptyString(item["tool"]);
  return {
    eventId: notificationEventId(
      ctx.eventIdPrefix,
      ctx.threadId,
      nonEmptyString(item["id"]) ?? ctx.turnId,
      ctx.occurredAt,
    ),
    sessionId: ctx.sessionId,
    occurredAt: ctx.occurredAt,
    type: "tool_use",
    toolUseId: nonEmptyString(item["id"]) ?? `${ctx.turnId}-mcp`,
    name: tool ?? server ?? "mcpToolCall",
    input: {
      ...(server !== null ? { server } : {}),
      ...(item["arguments"] !== undefined ? { arguments: item["arguments"] } : {}),
    },
  };
}

function toolResultEvent(
  item: Record<string, unknown>,
  ctx: ItemEventContext,
  toolUseId: string,
  output: Record<string, unknown>,
  isError: boolean,
): ProviderEvent {
  return {
    eventId: notificationEventId(
      ctx.eventIdPrefix,
      ctx.threadId,
      nonEmptyString(item["id"]) ?? ctx.turnId,
      ctx.occurredAt,
    ),
    sessionId: ctx.sessionId,
    occurredAt: ctx.occurredAt,
    type: "tool_result",
    toolUseId,
    output,
    isError,
  };
}

function messageEvent(
  item: Record<string, unknown>,
  ctx: ItemEventContext,
  kind: "reasoning" | "plan" | undefined,
): ProviderEvent {
  const base = {
    eventId: notificationEventId(
      ctx.eventIdPrefix,
      ctx.threadId,
      nonEmptyString(item["id"]) ?? ctx.turnId,
      ctx.occurredAt,
    ),
    sessionId: ctx.sessionId,
    occurredAt: ctx.occurredAt,
    type: "message" as const,
    content: typeof item["text"] === "string" ? item["text"] : "",
  };
  // kind 标注：reasoning/plan 归入 message 时附带（§10 定案；contracts 已声明可选 kind，端到端保留）
  return kind === undefined ? base : ({ ...base, kind } as CodexMessageEvent);
}

function errorContextEvent(item: Record<string, unknown>, ctx: ItemEventContext): ProviderEvent {
  return {
    eventId: notificationEventId(
      ctx.eventIdPrefix,
      ctx.threadId,
      nonEmptyString(item["id"]) ?? ctx.turnId,
      ctx.occurredAt,
    ),
    sessionId: ctx.sessionId,
    occurredAt: ctx.occurredAt,
    type: "error",
    message: nonEmptyString(item["message"]) ?? "errorContext（无消息体）",
  };
}

/**
 * 单个 ThreadItem → 事件组（纯函数）。
 * - live-started：commandExecution/fileChange/mcpToolCall → tool_use；消息类该相位零事件
 * - live-completed：agentMessage/reasoning/plan → message（+kind）；工具类 → tool_result；
 *   errorContext → error；userMessage/webSearch → 计数跳过
 * - hydrated：resume 水合——消息类 → message；工具类 → tool_use+tool_result（同一 item
 *   两事件，eventId 以 u/r 后缀区分）；errorContext → error
 */
export function mapThreadItem(item: unknown, phase: ItemPhase, ctx: ItemEventContext): ItemMapped {
  const record = asRecord(item);
  if (record === null) {
    return { events: [], skippedType: "item/非对象" };
  }
  const itemId = nonEmptyString(record["id"]);
  const type = nonEmptyString(record["type"]);

  if (type === "commandExecution") {
    if (phase === "live-started") {
      return { events: [commandExecutionStarted(record, ctx)], skippedType: null };
    }
    const exitCode = typeof record["exitCode"] === "number" ? record["exitCode"] : null;
    const result = toolResultEvent(
      record,
      ctx,
      itemId ?? `${ctx.turnId}-cmd`,
      {
        command: record["command"] ?? null,
        exitCode,
        ...(record["aggregatedOutput"] !== undefined
          ? { aggregatedOutput: record["aggregatedOutput"] }
          : {}),
      },
      exitCode !== null && exitCode !== 0,
    );
    if (phase === "hydrated") {
      return {
        events: [commandExecutionStarted(record, withSuffix(ctx, "u")), result],
        skippedType: null,
      };
    }
    return { events: [result], skippedType: null };
  }

  if (type === "fileChange") {
    if (phase === "live-started") {
      return { events: [fileChangeStarted(record, ctx)], skippedType: null };
    }
    const exitCode = typeof record["exitCode"] === "number" ? record["exitCode"] : null;
    const result = toolResultEvent(
      record,
      ctx,
      itemId ?? `${ctx.turnId}-file`,
      { changes: record["changes"] ?? [], exitCode },
      exitCode !== null && exitCode !== 0,
    );
    if (phase === "hydrated") {
      return {
        events: [fileChangeStarted(record, withSuffix(ctx, "u")), result],
        skippedType: null,
      };
    }
    return { events: [result], skippedType: null };
  }

  if (type === "mcpToolCall") {
    if (phase === "live-started") {
      return { events: [mcpToolCallStarted(record, ctx)], skippedType: null };
    }
    const status = nonEmptyString(record["status"]);
    const result = toolResultEvent(
      record,
      ctx,
      itemId ?? `${ctx.turnId}-mcp`,
      {
        ...(status !== null ? { status } : {}),
        ...(record["result"] !== undefined ? { result: record["result"] } : {}),
      },
      status === "failed",
    );
    if (phase === "hydrated") {
      return {
        events: [mcpToolCallStarted(record, withSuffix(ctx, "u")), result],
        skippedType: null,
      };
    }
    return { events: [result], skippedType: null };
  }

  if (type === "agentMessage") {
    if (phase === "live-started") {
      return { events: [], skippedType: null }; // 文本在 completed 全量帧送达
    }
    return { events: [messageEvent(record, ctx, undefined)], skippedType: null };
  }

  if (type === "reasoning" || type === "plan") {
    if (phase === "live-started") {
      return { events: [], skippedType: null };
    }
    return { events: [messageEvent(record, ctx, type)], skippedType: null };
  }

  if (type === "errorContext") {
    if (phase === "live-started") {
      return { events: [], skippedType: null };
    }
    return { events: [errorContextEvent(record, ctx)], skippedType: null };
  }

  if (type === "userMessage" || type === "webSearch") {
    return { events: [], skippedType: `item/${type ?? "未知"}` };
  }

  return { events: [], skippedType: `item/${type ?? "未知变体"}` };
}

/** 水合双事件时 tool_use 的 eventId 前缀加 u 后缀（与 tool_result 的 r 区分） */
function withSuffix(ctx: ItemEventContext, suffix: "u" | "r"): ItemEventContext {
  return suffix === "u" ? { ...ctx, eventIdPrefix: `${ctx.eventIdPrefix}:u` } : ctx;
}

// ---- §3.2 通知 → 事件 + 适配器侧信号 ----

/** 通知映射出的适配器侧信号（事件之外的治理输入） */
export interface NotificationSignals {
  readonly threadId: string | null;
  readonly turnId: string | null;
  /** thread/status/changed 目标态（notLoaded/idle/active/systemError） */
  readonly threadStatus: string | null;
  /** turn/completed 自报状态（completed/interrupted/failed） */
  readonly turnCompletedStatus: string | null;
  /** turn/completed 携带的错误消息（status=failed 时非空） */
  readonly turnError: string | null;
  /** error 通知 willRetry（null = 非 error 通知） */
  readonly errorWillRetry: boolean | null;
}

const NO_SIGNALS: NotificationSignals = {
  threadId: null,
  turnId: null,
  threadStatus: null,
  turnCompletedStatus: null,
  turnError: null,
  errorWillRetry: null,
};

export interface NotificationContext {
  readonly sessionId: string;
  /** emittedAtMs 缺失时的 occurredAt 兜底（在线=now()，重放=占位/行时间） */
  readonly occurredAtFallback: string;
}

export interface NotificationMapped {
  readonly events: ProviderEvent[];
  /** 跳过标签（白名单内已知但零映射/增量未消费/白名单外） */
  readonly skippedType: string | null;
  readonly signals: NotificationSignals;
}

function itemEventContext(
  params: Record<string, unknown>,
  note: ServerNotificationFrame,
  ctx: NotificationContext,
  prefix: string,
): ItemEventContext {
  return {
    sessionId: ctx.sessionId,
    threadId: nonEmptyString(params["threadId"]) ?? "",
    turnId: nonEmptyString(params["turnId"]) ?? "",
    occurredAt: isoFromEmittedAt(note.emittedAtMs, ctx.occurredAtFallback),
    eventIdPrefix: prefix,
  };
}

/**
 * 单条通知 → 事件组 + 侧信号（纯函数）。
 * turn/completed 不发终态事件：completed/interrupted 静默（终态归退出证明物化），
 * failed → error 事件。增量 delta 族与用量/弃用通知白名单外由路由器计数。
 */
export function mapNotification(
  note: ServerNotificationFrame,
  ctx: NotificationContext,
): NotificationMapped {
  const method = note.method;
  const params = asRecord(note.params) ?? {};
  const occurredAt = isoFromEmittedAt(note.emittedAtMs, ctx.occurredAtFallback);

  if (method === "turn/started") {
    const turn = asRecord(params["turn"]);
    const turnId = nonEmptyString(params["turnId"]) ?? nonEmptyString(turn?.["id"]);
    const events: ProviderEvent[] = [
      {
        eventId: `turn/started:${nonEmptyString(params["threadId"]) ?? ""}:${turnId ?? ""}:${occurredAt}`,
        sessionId: ctx.sessionId,
        occurredAt,
        type: "status",
        status: "running",
      },
    ];
    return {
      events,
      skippedType: null,
      signals: { ...NO_SIGNALS, threadId: nonEmptyString(params["threadId"]), turnId },
    };
  }

  if (method === "turn/completed") {
    const turn = asRecord(params["turn"]);
    const status = nonEmptyString(turn?.["status"]);
    const errorRecord = asRecord(turn?.["error"]);
    const errorMessage = nonEmptyString(errorRecord?.["message"]);
    const threadId = nonEmptyString(params["threadId"]);
    const turnId = nonEmptyString(params["turnId"]) ?? nonEmptyString(turn?.["id"]);
    const events: ProviderEvent[] = [];
    if (status === "failed") {
      events.push({
        eventId: `turn/completed:${threadId ?? ""}:${turnId ?? ""}:${occurredAt}`,
        sessionId: ctx.sessionId,
        occurredAt,
        type: "error",
        message: errorMessage ?? `turn 失败（status=failed，无错误详情）`,
      });
    }
    return {
      events,
      skippedType: null,
      signals: {
        ...NO_SIGNALS,
        threadId,
        turnId,
        turnCompletedStatus: status,
        turnError: status === "failed" ? (errorMessage ?? "turn failed") : null,
      },
    };
  }

  if (method === "item/started" || method === "item/completed") {
    const item = params["item"] ?? params; // 容错：item 内嵌或字段平铺两种形状
    const phase: ItemPhase = method === "item/started" ? "live-started" : "live-completed";
    const itemCtx = itemEventContext(params, note, ctx, method);
    const mapped = mapThreadItem(item, phase, itemCtx);
    return {
      events: mapped.events,
      skippedType: mapped.skippedType,
      signals: {
        ...NO_SIGNALS,
        threadId: itemCtx.threadId.length > 0 ? itemCtx.threadId : null,
        turnId: itemCtx.turnId.length > 0 ? itemCtx.turnId : null,
      },
    };
  }

  if (method === "error") {
    const error = asRecord(params["error"]);
    const message =
      nonEmptyString(error?.["message"]) ??
      nonEmptyString(params["message"]) ??
      "codex error 通知（无消息体）";
    const willRetry = params["willRetry"] === true;
    const threadId = nonEmptyString(params["threadId"]);
    const turnId = nonEmptyString(params["turnId"]);
    // §10 定案：willRetry=true 为瞬时错误自动重试，不打断 turn——不映射事件
    const events: ProviderEvent[] = willRetry
      ? []
      : [
          {
            eventId: `error:${threadId ?? ""}:${turnId ?? ""}:${occurredAt}`,
            sessionId: ctx.sessionId,
            occurredAt,
            type: "error",
            message,
          },
        ];
    return {
      events,
      skippedType: willRetry ? "error/willRetry" : null,
      signals: { ...NO_SIGNALS, threadId, turnId, errorWillRetry: willRetry },
    };
  }

  if (method === "thread/status/changed") {
    const status = asRecord(params["status"]);
    const statusType = nonEmptyString(status?.["type"]);
    return {
      events: [],
      skippedType: null,
      signals: {
        ...NO_SIGNALS,
        threadId: nonEmptyString(params["threadId"]),
        threadStatus: statusType,
      },
    };
  }

  if (
    method === "thread/started" ||
    method === "thread/closed" ||
    method === "thread/tokenUsage/updated"
  ) {
    // thread/started 不映射 session 事件（session 事件只在 thread/start 响应边界发一次，
    // 状态机语义：ready 态收到 session 会被解读为会话结束）；closed/用量为治理信号
    return {
      events: [],
      skippedType: null,
      signals: {
        ...NO_SIGNALS,
        threadId:
          nonEmptyString(params["threadId"]) ?? nonEmptyString(asRecord(params["thread"])?.["id"]),
      },
    };
  }

  if (method === "deprecationNotice") {
    return { events: [], skippedType: "deprecationNotice", signals: { ...NO_SIGNALS } };
  }

  return { events: [], skippedType: `notification/${method}`, signals: { ...NO_SIGNALS } };
}

// ---- §5 resume 水合：thread/resume 响应内嵌 turns → 事件 ----

export interface HydrationContext {
  readonly sessionId: string;
  readonly threadId: string;
  /** item/turn 无时间戳时的兜底 */
  readonly occurredAtFallback: string;
}

/**
 * resume 响应内嵌 thread.turns 全量历史 → 事件（确定性 eventId：history:threadId:itemId:ts，
 * 同一 thread 多次 resume 重放同一批事件——P0-11 eventId@occurredAt 去重键天然收敛）。
 */
export function mapResumeTurns(
  turns: unknown,
  ctx: HydrationContext,
): { events: ProviderEvent[]; skipped: Record<string, number> } {
  const events: ProviderEvent[] = [];
  const skipped: Record<string, number> = {};
  if (!Array.isArray(turns)) {
    return { events, skipped };
  }
  for (const turnEntry of turns) {
    const turn = asRecord(turnEntry);
    if (turn === null) continue;
    const turnId = nonEmptyString(turn["id"]) ?? "";
    const turnTime =
      nonEmptyString(turn["completedAt"]) ??
      nonEmptyString(turn["startedAt"]) ??
      ctx.occurredAtFallback;
    const items = Array.isArray(turn["items"]) ? turn["items"] : [];
    for (const itemEntry of items) {
      const mapped = mapThreadItem(itemEntry, "hydrated", {
        sessionId: ctx.sessionId,
        threadId: ctx.threadId,
        turnId,
        occurredAt: turnTime,
        eventIdPrefix: "history",
      });
      if (mapped.skippedType !== null) {
        const key = mapped.skippedType;
        skipped[key] = (skipped[key] ?? 0) + 1;
      }
      events.push(...mapped.events);
    }
  }
  return { events, skipped };
}

// ---- normalizeLogs 旁路重放（raw 行数组 → ProviderEvent 数组）----

/**
 * 原始日志行（JSONL 字符串或已解析对象）→ 事件（旁路转换器，vendor 格式变化只改本文件）。
 * 通知走 mapNotification；审批请求映射 permission_request；响应/未知形状跳过。
 * sessionId 占位 "replay"：normalizeLogs 端口无会话上下文（与 claude adapter 同款）。
 */
export function normalizeFrames(
  raw: readonly unknown[],
  options: { sessionId?: string; occurredAtFallback?: string } = {},
): { events: ProviderEvent[]; skipped: Record<string, number> } {
  const sessionId = options.sessionId ?? "replay";
  const fallback = options.occurredAtFallback ?? EPOCH_PLACEHOLDER;
  const events: ProviderEvent[] = [];
  const skipped: Record<string, number> = {};
  const countSkip = (key: string): void => {
    skipped[key] = (skipped[key] ?? 0) + 1;
  };

  for (const entry of raw) {
    let frame: unknown = entry;
    if (typeof entry === "string") {
      const text = entry.trim();
      if (text.length === 0) {
        countSkip("空行");
        continue;
      }
      try {
        frame = JSON.parse(text) as unknown;
      } catch {
        countSkip("非法 JSON 行");
        continue;
      }
    }
    const record = asRecord(frame);
    if (record === null) {
      countSkip("非对象帧");
      continue;
    }
    const method = nonEmptyString(record["method"]);
    if (method !== null) {
      const id = record["id"];
      if (id !== undefined) {
        // 服务端请求（审批）：白名单内映射 permission_request，其余跳过
        const mapped = approvalEventFor(method, record["params"], {
          sessionId,
          occurredAt: fallback,
          fallbackKey: typeof id === "string" || typeof id === "number" ? String(id) : "unknown",
        });
        if (mapped !== null) {
          events.push(mapped.event);
        } else {
          countSkip(`request/${method}`);
        }
        continue;
      }
      const notification = {
        method,
        ...(record["params"] !== undefined ? { params: record["params"] } : {}),
        ...(typeof record["emittedAtMs"] === "number"
          ? { emittedAtMs: record["emittedAtMs"] }
          : {}),
      };
      const mapped = mapNotification(notification, { sessionId, occurredAtFallback: fallback });
      if (mapped.skippedType !== null) {
        countSkip(mapped.skippedType);
      }
      events.push(...mapped.events);
      continue;
    }
    countSkip("响应/未知形状");
  }
  return { events, skipped };
}
