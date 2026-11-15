// RouteOutcome 构造器（P0-11 新方法组共用；terminals.ts 自带同形私有件，不动避免回归）。
// 全部经 contracts respond.ts 的构造器产出，帧形状由 strict schema 约束。
import { JSON_RPC_ERROR_CODES } from "@aether/contracts";
import { errorResponse, successResponse, type JsonRpcId } from "./respond.js";
import type { RouteOutcome } from "./router.js";
import { ServiceError, errorMessage } from "../service-error.js";

export function invalidParamsOutcome(id: JsonRpcId, message: string): RouteOutcome {
  return {
    kind: "response",
    frame: JSON.stringify(errorResponse(id, JSON_RPC_ERROR_CODES.INVALID_PARAMS, message)),
  };
}

export function internalErrorOutcome(id: JsonRpcId, message: string): RouteOutcome {
  return {
    kind: "response",
    frame: JSON.stringify(errorResponse(id, JSON_RPC_ERROR_CODES.INTERNAL_ERROR, message)),
  };
}

export function successOutcome(id: JsonRpcId, result: unknown): RouteOutcome {
  return { kind: "response", frame: JSON.stringify(successResponse(id, result)) };
}

/** 服务异常 → JSON-RPC 错误帧：invalid_params → -32602，internal → -32603（中文消息直达）。 */
export function serviceErrorOutcome(id: JsonRpcId, error: unknown): RouteOutcome {
  if (error instanceof ServiceError) {
    return error.kind === "invalid_params"
      ? invalidParamsOutcome(id, error.message)
      : internalErrorOutcome(id, error.message);
  }
  return internalErrorOutcome(id, `内部错误：${errorMessage(error)}`);
}
