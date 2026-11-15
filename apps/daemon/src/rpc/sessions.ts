// sessions.* RPC 实现（P0-11 驾驶舱）：sessions.listEvents = 活动视图历史事件拉取
// （执行日志重放，进程行按时间序合并归一化事件）；sessions.list = 任务名下会话清单
// （AgentCard 数据源，workspace.taskId 联表）。两者均为同步方法。
import { z } from "zod";
import type { JsonRpcRequest } from "@aether/contracts";
import type { AgentService } from "../agents/agents-service.js";
import { invalidParamsOutcome, serviceErrorOutcome, successOutcome } from "./outcomes.js";
import type { RouteOutcome } from "./router.js";

export const SESSIONS_METHODS = ["sessions.listEvents", "sessions.list"] as const;
export type SessionsMethod = (typeof SESSIONS_METHODS)[number];

export function isSessionsMethod(method: string): method is SessionsMethod {
  return (SESSIONS_METHODS as readonly string[]).includes(method);
}

export const SessionsListEventsParamsSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();
export const SessionsListParamsSchema = z
  .object({
    taskId: z.string().min(1),
  })
  .strict();

/** 处理 sessions.* 请求（router 已确认 deps.agents 注入；会话域挂在 agents 服务）。 */
export function handleSessionsRequest(request: JsonRpcRequest, agents: AgentService): RouteOutcome {
  const { id, method, params } = request;
  switch (method) {
    case "sessions.listEvents": {
      if (params === undefined) {
        return invalidParamsOutcome(id, "sessions.listEvents 需要参数对象");
      }
      const parsed = SessionsListEventsParamsSchema.safeParse(params);
      if (!parsed.success) {
        return invalidParamsOutcome(id, `sessions.listEvents 参数非法：${parsed.error.message}`);
      }
      try {
        return successOutcome(id, { events: agents.listSessionEvents(parsed.data.sessionId) });
      } catch (error) {
        return serviceErrorOutcome(id, error);
      }
    }
    case "sessions.list": {
      if (params === undefined) {
        return invalidParamsOutcome(id, "sessions.list 需要参数对象");
      }
      const parsed = SessionsListParamsSchema.safeParse(params);
      if (!parsed.success) {
        return invalidParamsOutcome(id, `sessions.list 参数非法：${parsed.error.message}`);
      }
      try {
        return successOutcome(id, agents.listSessionsByTask(parsed.data.taskId));
      } catch (error) {
        return serviceErrorOutcome(id, error);
      }
    }
  }
  return invalidParamsOutcome(id, `未知 sessions 方法：${method}`);
}
