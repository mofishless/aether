// agents.* RPC 方法实现（contracts rpc.ts 签名为准，P0-11）：
// 参数 zod strict 校验 → AgentService 映射；ServiceError 按 kind 映射错误码。
// 异步方法（spawn/followUp 等）：返回 Promise<RouteOutcome>，异常在 handler 内
// 收敛为错误帧（router 层再兜底 INTERNAL_ERROR）。
import { z } from "zod";
import { AutonomyLevelSchema, ProviderKindSchema } from "@aether/contracts";
import type { JsonRpcRequest } from "@aether/contracts";
import type { AgentService } from "../agents/agents-service.js";
import { invalidParamsOutcome, serviceErrorOutcome, successOutcome } from "./outcomes.js";
import type { RouteOutcome } from "./router.js";

export const AGENTS_METHODS = [
  "agents.spawn",
  "agents.followUp",
  "agents.cancel",
  "agents.permission.respond",
] as const;
export type AgentsMethod = (typeof AGENTS_METHODS)[number];

export function isAgentsMethod(method: string): method is AgentsMethod {
  return (AGENTS_METHODS as readonly string[]).includes(method);
}

const idField = z.string().min(1);

export const AgentsSpawnParamsSchema = z
  .object({
    taskId: idField,
    workspaceId: idField.optional(),
    // 缺省 = daemon 取种子的全局默认 agent_profile（contracts 签名注释同口径）
    agentProfileId: idField.optional(),
    // 显式 provider 路由（P1-01 评审 F2）：缺省 = profile 的 provider 配置行 kind；
    // 值域外的值在此拒，值域内但未注册适配器的 kind 由服务面再拒（acp/tui 为 P2+ 占位）
    providerKind: ProviderKindSchema.optional(),
    prompt: z.string().min(1),
    autonomy: AutonomyLevelSchema.optional(),
  })
  .strict();
export const AgentsFollowUpParamsSchema = z
  .object({
    sessionId: idField,
    message: z.string().min(1),
  })
  .strict();
export const AgentsCancelParamsSchema = z.object({ sessionId: idField }).strict();
export const AgentsPermissionRespondParamsSchema = z
  .object({
    // 缺省时服务面按 requestId 反查当前阻塞进程（permission_request 事件不携带 processId）
    processId: idField.optional(),
    requestId: idField,
    decision: z.enum(["approve", "deny"]),
  })
  .strict();

type ParsedParams<T> = { ok: true; data: T } | { ok: false; outcome: RouteOutcome };

function parseParams<T>(request: JsonRpcRequest, schema: z.ZodType<T>): ParsedParams<T> {
  if (request.params === undefined) {
    return {
      ok: false,
      outcome: invalidParamsOutcome(request.id, `${request.method} 需要参数对象`),
    };
  }
  const parsed = schema.safeParse(request.params);
  if (!parsed.success) {
    return {
      ok: false,
      outcome: invalidParamsOutcome(
        request.id,
        `${request.method} 参数非法：${parsed.error.message}`,
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

/** 处理 agents.* 请求（router 已确认 deps.agents 注入）。 */
export function handleAgentsRequest(
  request: JsonRpcRequest,
  agents: AgentService,
): RouteOutcome | Promise<RouteOutcome> {
  const { id, method } = request;
  switch (method) {
    case "agents.spawn": {
      const parsed = parseParams(request, AgentsSpawnParamsSchema);
      if (!parsed.ok) return parsed.outcome;
      return agents
        .spawn(parsed.data)
        .then((handle) => successOutcome(id, handle))
        .catch((error: unknown) => serviceErrorOutcome(id, error));
    }
    case "agents.followUp": {
      const parsed = parseParams(request, AgentsFollowUpParamsSchema);
      if (!parsed.ok) return parsed.outcome;
      return agents
        .followUp(parsed.data)
        .then((handle) => successOutcome(id, handle))
        .catch((error: unknown) => serviceErrorOutcome(id, error));
    }
    case "agents.cancel": {
      const parsed = parseParams(request, AgentsCancelParamsSchema);
      if (!parsed.ok) return parsed.outcome;
      // cancel 应答只等治理指令下达（killTree 树杀与超时升级在 adapter/process-host
      // 内恒收敛）——退出与状态经 agent.status / session.<id>.state 事件推送
      //（对齐 terminals.kill 立即应答定案）。
      return agents
        .cancel(parsed.data)
        .then(() => successOutcome(id, null))
        .catch((error: unknown) => serviceErrorOutcome(id, error));
    }
    case "agents.permission.respond": {
      const parsed = parseParams(request, AgentsPermissionRespondParamsSchema);
      if (!parsed.ok) return parsed.outcome;
      return agents
        .respondPermission(parsed.data)
        .then(() => successOutcome(id, null))
        .catch((error: unknown) => serviceErrorOutcome(id, error));
    }
  }
  return invalidParamsOutcome(id, `未知 agents 方法：${method}`);
}
