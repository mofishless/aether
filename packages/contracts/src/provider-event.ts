import { z } from "zod";
import { AgentStatusSchema } from "./domain.js";

// ===== ProviderEvent：provider 归一化事件（SYSTEM_DESIGN §6.2）=====
// 判别字段 type，成员恰为 7 种：status / message / tool_use / tool_result /
// permission_request / session / error。
// 字段取通用最小集——L1/L2 实际事件结构在 P0-07 对照官方协议
// （Claude Agent SDK stream-json / Codex app-server JSON-RPC）逐项核对后细化，
// 此处不编造 vendor 协议细节。

const providerEventBase = {
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  occurredAt: z.iso.datetime(),
};

export const ProviderEventSchema = z.discriminatedUnion("type", [
  /** 状态机迁移信号（§8.1） */
  z.object({
    ...providerEventBase,
    type: z.literal("status"),
    status: AgentStatusSchema,
  }),
  /** 助手/用户消息文本 */
  z.object({
    ...providerEventBase,
    type: z.literal("message"),
    content: z.string(),
    /**
     * 消息类别标注（可选）：codex 的 reasoning/plan 归入 message 时携带
     * （"reasoning" | "plan"）。zod 默认保留声明过的键——live/落库/重放三面一致
     * （P1-01 评审 F6 定案）；其他 provider 缺省不带。
     */
    kind: z.string().optional(),
  }),
  /** 工具调用发起 */
  z.object({
    ...providerEventBase,
    type: z.literal("tool_use"),
    toolUseId: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
  }),
  /** 工具调用结果（toolUseId 与 tool_use 对应） */
  z.object({
    ...providerEventBase,
    type: z.literal("tool_result"),
    toolUseId: z.string().min(1),
    output: z.unknown(),
    isError: z.boolean(),
  }),
  /** 权限请求：等待 agents.permission.respond 应答（waiting 态） */
  z.object({
    ...providerEventBase,
    type: z.literal("permission_request"),
    requestId: z.string().min(1),
    toolName: z.string().min(1),
    summary: z.string(),
  }),
  /** 会话生命周期（外部会话 id 供 --resume；null = 无） */
  z.object({
    ...providerEventBase,
    type: z.literal("session"),
    externalSessionId: z.string().min(1).nullable(),
  }),
  /** 错误（非零退出 / 协议错误等） */
  z.object({
    ...providerEventBase,
    type: z.literal("error"),
    message: z.string(),
  }),
]);
export type ProviderEvent = z.infer<typeof ProviderEventSchema>;
export type ProviderEventType = ProviderEvent["type"];
