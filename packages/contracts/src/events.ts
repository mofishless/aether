import { z } from "zod";
import { AgentStatusSchema, TaskSchema, WorkspaceStatusSchema } from "./domain.js";

// ===== 事件流 envelope（SYSTEM_DESIGN §5.4：订阅推送）=====

/** 点分层级字符串；具体取值由下方 Topic 构造器约定（支持通配下钻） */
export const TopicSchema = z.string().min(1);

export const EventEnvelopeSchema = z
  .object({
    topic: TopicSchema,
    /** daemon 全局单调递增（正整数，断线重放 cursor 依此对齐） */
    seq: z.number().int().positive(),
    /** UTC ISO-8601 */
    emittedAt: z.iso.datetime(),
    /** zod 校验后的强类型载荷，由 topic 对应 schema 收窄（strict 仅作用于顶层键，payload 不受影响） */
    payload: z.unknown(),
  })
  // wire 边界 fail-closed：与 rpc.ts 的 envelope 约定一致，未知字段一律拒绝
  .strict();

/** §5.4 原文形态：payload 以泛型收窄（如 EventEnvelope<ProviderEvent>） */
export interface EventEnvelope<T = unknown> {
  topic: string;
  seq: number;
  emittedAt: string;
  payload: T;
}

// ===== Topic 常量与字面量类型（§5.4 表：7 类 topic 全覆盖）=====
// 4 个静态投影 topic + 3 个参数化模式（session 两态 / 终端输出 / 进程日志）。

/** 静态投影变更 topic（无 id 段） */
export const STATIC_TOPIC = {
  taskUpdated: "task.updated",
  mailboxUpdated: "mailbox.updated",
  workspaceStatus: "workspace.status",
  agentStatus: "agent.status",
} as const;
export type StaticTopic = (typeof STATIC_TOPIC)[keyof typeof STATIC_TOPIC];

/** 参数化 topic 模式字面量（<id> 为实体 id 占位段） */
export type TopicPattern =
  | StaticTopic
  /** ProviderEvent 归一化流 + 状态迁移 */
  | "session.<id>.events"
  /** 状态机迁移（§8.1） */
  | "session.<id>.state"
  /** 终端增量帧（§7.3） */
  | "terminal.<id>.output"
  /** 终端退出帧（§7.3 exit；P0-10 daemon 组装补充） */
  | "terminal.<id>.exit"
  /** 新日志行通知（拉取或内联） */
  | "process.<id>.logs";

// P0 占位：通配下钻的订阅语法（前缀匹配 / "session.<id>.*" 等）随 P0-03 订阅实现细化。

/** 构造具体 topic：session.<id>.events */
export function sessionEventsTopic(sessionId: string): string {
  return `session.${sessionId}.events`;
}

/** 构造具体 topic：session.<id>.state */
export function sessionStateTopic(sessionId: string): string {
  return `session.${sessionId}.state`;
}

/** 构造具体 topic：terminal.<id>.output */
export function terminalOutputTopic(terminalId: string): string {
  return `terminal.${terminalId}.output`;
}

/** 构造具体 topic：terminal.<id>.exit */
export function terminalExitTopic(terminalId: string): string {
  return `terminal.${terminalId}.exit`;
}

/** 构造具体 topic：process.<id>.logs */
export function processLogsTopic(processId: string): string {
  return `process.${processId}.logs`;
}

// ===== 静态投影 topic 的 payload schema（P0-11 驾驶舱投影，§5.4 表末行）=====
// daemon 发布前 / 渲染层消费前共用同一 schema（wire 边界 fail-closed 同口径）；
// 形状贴 domain.ts 已有实体类型，不另造字段。

/** task.updated 载荷：任务行投影（tasks.create/move、agent 状态迁移联动时发布） */
export const TaskUpdatedPayloadSchema = z.object({ task: TaskSchema }).strict();
export type TaskUpdatedPayload = z.infer<typeof TaskUpdatedPayloadSchema>;

/** agent.status 载荷：会话状态点投影（状态机每次 applied 迁移时发布） */
export const AgentStatusPayloadSchema = z
  .object({
    sessionId: z.string().min(1),
    workspaceId: z.string().min(1),
    taskId: z.string().min(1),
    status: AgentStatusSchema,
  })
  .strict();
export type AgentStatusPayload = z.infer<typeof AgentStatusPayloadSchema>;

/**
 * workspace.status 载荷：工作区状态投影。status 用 domain 枚举收窄
 * （WorkspaceStatusSchema；prompt 字面写 string，定案取枚举——wire 边界更严）。
 */
export const WorkspaceStatusPayloadSchema = z
  .object({
    workspaceId: z.string().min(1),
    projectId: z.string().min(1),
    status: WorkspaceStatusSchema,
  })
  .strict();
export type WorkspaceStatusPayload = z.infer<typeof WorkspaceStatusPayloadSchema>;

/** session.<id>.state 载荷：状态机迁移帧（§8.1；previous → status） */
export const SessionStatePayloadSchema = z
  .object({
    sessionId: z.string().min(1),
    previous: AgentStatusSchema,
    status: AgentStatusSchema,
  })
  .strict();
export type SessionStatePayload = z.infer<typeof SessionStatePayloadSchema>;
