// RPC 路由（纯函数）：JSON-RPC 2.0 envelope 解析（复用 contracts schema，禁止重复定义）
// + system 组三方法分派。无 IO、无状态——ws 层负责收发，此处只决定"回什么/要不要副作用"。
import {
  JSON_RPC_ERROR_CODES,
  JsonRpcNotificationSchema,
  JsonRpcRequestSchema,
  type JsonRpcErrorResponse,
  type JsonRpcRequest,
  type JsonRpcSuccessResponse,
} from "@aether/contracts";
import { errorResponse, successResponse, type JsonRpcId } from "./respond.js";

export interface RouterDeps {
  readonly daemonVersion: string;
  readonly protocolVersion: number;
}

export type RouteOutcome =
  /** notification：JSON-RPC 2.0 规范要求不回帧 */
  | { kind: "none" }
  | { kind: "response"; frame: string }
  /** system.shutdown：Success 帧写回后才执行优雅退出（由服务器层编排） */
  | { kind: "response-and-shutdown"; frame: string };

type AnyResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

function responseOutcome(response: AnyResponse): RouteOutcome {
  return { kind: "response", frame: JSON.stringify(response) };
}

function shutdownOutcome(response: AnyResponse): RouteOutcome {
  return { kind: "response-and-shutdown", frame: JSON.stringify(response) };
}

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

function dispatchRequest(request: JsonRpcRequest, deps: RouterDeps): RouteOutcome {
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

  return responseOutcome(
    errorResponse(id, JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`),
  );
}

/**
 * 处理单条已握手消息：
 * - 非 JSON → PARSE_ERROR -32700（id null）
 * - Request schema 不过且 Notification schema 也不过 → INVALID_REQUEST -32600
 *   （注意先 Request 后 Notification：携带 id 的帧若先按 Notification 解析会因 strict 剥离误判）
 * - Notification → none（含未知方法，规范不回）
 * - Request → 分派；未知方法 -32601
 */
export function routeMessage(raw: string, deps: RouterDeps): RouteOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return responseOutcome(errorResponse(null, JSON_RPC_ERROR_CODES.PARSE_ERROR, "Parse error"));
  }

  const request = JsonRpcRequestSchema.safeParse(parsed);
  if (request.success) {
    return dispatchRequest(request.data, deps);
  }
  const notification = JsonRpcNotificationSchema.safeParse(parsed);
  if (notification.success) {
    return { kind: "none" };
  }
  return responseOutcome(
    errorResponse(extractRawId(parsed), JSON_RPC_ERROR_CODES.INVALID_REQUEST, "Invalid Request"),
  );
}
