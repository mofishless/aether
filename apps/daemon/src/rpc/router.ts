// RPC 路由（纯函数编排）：JSON-RPC 2.0 envelope 解析（复用 contracts schema，禁止重复定义）
// + system 三方法 + terminals.*（P0-10）+ agents/sessions/projects/tasks/diff/subscribe（P0-11）
// 分派。无自身 IO、无状态——ws 层负责收发，此处只决定"回什么/要不要副作用"。
// P0-11：agents/diff 组是异步方法——routeMessage 可能返回 Promise<RouteOutcome>
//（server 层对两种返回统一处理；envelope/system/terminals 保持同步语义不回归）。
import { z } from "zod";
import {
  JSON_RPC_ERROR_CODES,
  JsonRpcNotificationSchema,
  JsonRpcRequestSchema,
  type JsonRpcErrorResponse,
  type JsonRpcRequest,
  type JsonRpcSuccessResponse,
} from "@aether/contracts";
import type { TerminalPool } from "@aether/terminal";
import type { AgentService } from "../agents/agents-service.js";
import type { CatalogService } from "../catalog/catalog-service.js";
import type { DiffService } from "../diff/diff-service.js";
import type { EventBus } from "../events/event-bus.js";
import { errorResponse, successResponse, type JsonRpcId } from "./respond.js";
import { handleAgentsRequest, isAgentsMethod } from "./agents.js";
import { handleCatalogRequest, isCatalogMethod } from "./catalog.js";
import { handleDiffRequest, isDiffMethod } from "./diff.js";
import { handleSessionsRequest, isSessionsMethod } from "./sessions.js";
import { handleTerminalsRequest, isTerminalsMethod } from "./terminals.js";

export interface RouterDeps {
  readonly daemonVersion: string;
  readonly protocolVersion: number;
  /** terminals.* 装配依赖（P0-10）：缺省时这些方法回 METHOD_NOT_FOUND（骨架行为不变） */
  readonly terminals?: TerminalPool;
  /** subscribe 装配依赖（事件水位 + 重放缓冲）：缺省时回 METHOD_NOT_FOUND */
  readonly events?: EventBus;
  /** projects 组与 tasks 组装配依赖（P0-11）：缺省 → METHOD_NOT_FOUND */
  readonly catalog?: CatalogService;
  /** agents 组与 sessions 组装配依赖（P0-11）：缺省 → METHOD_NOT_FOUND */
  readonly agents?: AgentService;
  /** diff.* 装配依赖（P0-11）：缺省 → METHOD_NOT_FOUND */
  readonly diff?: DiffService;
}

export type RouteOutcome =
  /** notification：JSON-RPC 2.0 规范要求不回帧 */
  | { kind: "none" }
  /** 应答帧前需先回推的重放帧（subscribe cursor：按 seq 序，server 层先发这些再发 frame） */
  | { kind: "response"; frame: string; replayFrames?: readonly string[] }
  /** system.shutdown：Success 帧写回后才执行优雅退出（由服务器层编排） */
  | { kind: "response-and-shutdown"; frame: string };

type AnyResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

function responseOutcome(response: AnyResponse): RouteOutcome {
  return { kind: "response", frame: JSON.stringify(response) };
}

function shutdownOutcome(response: AnyResponse): RouteOutcome {
  return { kind: "response-and-shutdown", frame: JSON.stringify(response) };
}

function methodNotFoundOutcome(id: JsonRpcId, method: string): RouteOutcome {
  return responseOutcome(
    errorResponse(id, JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`),
  );
}

/** subscribe 参数（contracts rpc.ts 签名）：topics 非空、cursor 非负整数 */
const SubscribeParamsSchema = z
  .object({
    topics: z.array(z.string().min(1)).min(1),
    cursor: z.number().int().nonnegative().optional(),
  })
  .strict();

/** malformed envelope 的兜底 id：能安全取到 string|number 就回显，否则 null（规范允许） */
function extractRawId(parsed: unknown): JsonRpcId {
  if (typeof parsed === "object" && parsed !== null) {
    const id = (parsed as Record<string, unknown>)["id"];
    if (typeof id === "string" || typeof id === "number") {
      return id;
    }
  }
  return null;
}

function dispatchRequest(
  request: JsonRpcRequest,
  deps: RouterDeps,
): RouteOutcome | Promise<RouteOutcome> {
  const { id, method, params } = request;

  // system 三方法均无参数（AetherRpc 签名），fail-closed：带 params 即拒绝
  if (method === "system.health") {
    if (params !== undefined) {
      return responseOutcome(
        errorResponse(id, JSON_RPC_ERROR_CODES.INVALID_PARAMS, "system.health takes no params"),
      );
    }
    return responseOutcome(successResponse(id, { ok: true }));
  }
  if (method === "system.version") {
    if (params !== undefined) {
      return responseOutcome(
        errorResponse(id, JSON_RPC_ERROR_CODES.INVALID_PARAMS, "system.version takes no params"),
      );
    }
    return responseOutcome(
      successResponse(id, {
        daemonVersion: deps.daemonVersion,
        protocolVersion: deps.protocolVersion,
      }),
    );
  }
  if (method === "system.shutdown") {
    if (params !== undefined) {
      return responseOutcome(
        errorResponse(id, JSON_RPC_ERROR_CODES.INVALID_PARAMS, "system.shutdown takes no params"),
      );
    }
    // AetherRpc 签名返回 void → result: null（Success 帧必有 result 字段）
    return shutdownOutcome(successResponse(id, null));
  }

  // terminals.*（P0-10 装配挂接）：未装配 → METHOD_NOT_FOUND（骨架 deps 向后兼容）
  if (isTerminalsMethod(method)) {
    if (deps.terminals === undefined) {
      return methodNotFoundOutcome(id, method);
    }
    return handleTerminalsRequest(request, deps.terminals);
  }

  // agents.* / sessions.*（P0-11）：未装配 → METHOD_NOT_FOUND
  if (isAgentsMethod(method)) {
    if (deps.agents === undefined) {
      return methodNotFoundOutcome(id, method);
    }
    return handleAgentsRequest(request, deps.agents);
  }
  if (isSessionsMethod(method)) {
    if (deps.agents === undefined) {
      return methodNotFoundOutcome(id, method);
    }
    return handleSessionsRequest(request, deps.agents);
  }

  // projects.* / tasks.*（P0-11）
  if (isCatalogMethod(method)) {
    if (deps.catalog === undefined) {
      return methodNotFoundOutcome(id, method);
    }
    return handleCatalogRequest(request, deps.catalog);
  }

  // diff.*（P0-11）
  if (isDiffMethod(method)) {
    if (deps.diff === undefined) {
      return methodNotFoundOutcome(id, method);
    }
    return handleDiffRequest(request, deps.diff);
  }

  if (method === "subscribe") {
    if (deps.events === undefined) {
      return methodNotFoundOutcome(id, method);
    }
    if (params === undefined) {
      return responseOutcome(
        errorResponse(id, JSON_RPC_ERROR_CODES.INVALID_PARAMS, "subscribe 需要参数对象"),
      );
    }
    const parsed = SubscribeParamsSchema.safeParse(params);
    if (!parsed.success) {
      return responseOutcome(
        errorResponse(
          id,
          JSON_RPC_ERROR_CODES.INVALID_PARAMS,
          `subscribe 参数非法：${parsed.error.message}`,
        ),
      );
    }
    const { topics, cursor } = parsed.data;
    // P0-10 定案保持：cursor 缺省 → 应答当前水位即「从现在开始推送」（全量广播）。
    // P0-11 补：cursor 提供 → 有界内存缓冲按 topic 精确匹配 + seq>cursor 有序回推
    //（ws notification 帧），随后应答当前水位。cursor 早于保留水位时只回保留段
    //（StateSnapshot 快照契约维持现状，P0 水位细化后续落地）。
    if (cursor === undefined) {
      return responseOutcome(successResponse(id, { cursor: deps.events.currentSeq }));
    }
    const replayFrames = deps.events.replay(topics, cursor);
    return {
      kind: "response",
      frame: JSON.stringify(successResponse(id, { cursor: deps.events.currentSeq })),
      replayFrames,
    };
  }

  return methodNotFoundOutcome(id, method);
}

/**
 * 处理单条已握手消息：
 * - 非 JSON → PARSE_ERROR -32700（id null）
 * - Request schema 不过且 Notification schema 也不过 → INVALID_REQUEST -32600
 *   （注意先 Request 后 Notification：携带 id 的帧若先按 Notification 解析会因 strict 剥离误判）
 * - Notification → none（含未知方法，规范不回）
 * - Request → 分派；未知方法 -32601
 *
 * 异步方法（agents 组与 diff 组）返回 Promise：拒绝由此处兜底为 INTERNAL_ERROR（handler
 * 内已先给出精确中文错误，此为最后防线），fulfilled 值可能带 replayFrames（subscribe）。
 */
export function routeMessage(raw: string, deps: RouterDeps): RouteOutcome | Promise<RouteOutcome> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return responseOutcome(errorResponse(null, JSON_RPC_ERROR_CODES.PARSE_ERROR, "Parse error"));
  }

  const request = JsonRpcRequestSchema.safeParse(parsed);
  if (request.success) {
    const outcome = dispatchRequest(request.data, deps);
    if (outcome instanceof Promise) {
      return outcome.catch(() =>
        responseOutcome(
          errorResponse(
            request.data.id,
            JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
            "内部错误：请求处理失败",
          ),
        ),
      );
    }
    return outcome;
  }
  const notification = JsonRpcNotificationSchema.safeParse(parsed);
  if (notification.success) {
    return { kind: "none" };
  }
  return responseOutcome(
    errorResponse(extractRawId(parsed), JSON_RPC_ERROR_CODES.INVALID_REQUEST, "Invalid Request"),
  );
}
