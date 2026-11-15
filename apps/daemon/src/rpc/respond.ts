// JSON-RPC 2.0 响应帧构造器（形状由 contracts strict schema 约束，构造侧保证可 parse）。
import type {
  JsonRpcErrorResponse,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
} from "@aether/contracts";

// contracts 未直接导出 id 类型（packages/** 不在本任务授权路径内），从 Response 类型派生：
// string | number | null（Response/Error 的 id 允许 null，Request 不允许）。
export type JsonRpcId = JsonRpcResponse["id"];

export function successResponse(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

export function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      // exactOptionalPropertyTypes：仅在提供时携带 data，不显式写 undefined
      ...(data !== undefined ? { data } : {}),
    },
  };
}
