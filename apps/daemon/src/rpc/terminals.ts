// terminals.* RPC 方法实现（contracts rpc.ts 签名为准，P0-10 装配挂接）：
// 参数 zod strict 校验（wire 边界 fail-closed）→ TerminalPool 映射。
// 语义定案（与 pool 幂等语义对齐）：
// - write/resize 对未知 terminalId：pool 返回 false → INVALID_PARAMS 中文错误。
//   理由：二者是「对已存在终端的操作」，目标不存在 = 参数引用错误（fail-closed，
//   客户端能从错误码立即发现句柄失效）；
// - kill 未知 terminalId：Success（result null）。kill 是终止意图，对不存在目标
//   重放无副作用（幂等），与 write/resize 的 fail-closed 刻意区分（本注释即定案）；
// - kill 不等待退出证明：RPC 立即应答，退出经 terminal.<id>.exit 事件推送（§5.4）。
import { z } from "zod";
import { JSON_RPC_ERROR_CODES, type JsonRpcRequest } from "@aether/contracts";
import type { TerminalPool } from "@aether/terminal";
import { errorResponse, successResponse, type JsonRpcId } from "./respond.js";
import type { RouteOutcome } from "./router.js";

export const TERMINALS_METHODS = [
  "terminals.create",
  "terminals.write",
  "terminals.resize",
  "terminals.kill",
] as const;
export type TerminalsMethod = (typeof TERMINALS_METHODS)[number];

export function isTerminalsMethod(method: string): method is TerminalsMethod {
  return (TERMINALS_METHODS as readonly string[]).includes(method);
}

const terminalIdField = z.string().min(1);
const colsField = z.number().int().positive();
const rowsField = z.number().int().positive();

export const TerminalsCreateParamsSchema = z
  .object({
    projectId: terminalIdField,
    workspaceId: terminalIdField.optional(),
    cwd: z.string().min(1),
    cols: colsField,
    rows: rowsField,
  })
  .strict();
export const TerminalsWriteParamsSchema = z
  .object({
    terminalId: terminalIdField,
    /** base64 字节流（§7.3 input 帧） */
    data: z.base64(),
  })
  .strict();
export const TerminalsResizeParamsSchema = z
  .object({
    terminalId: terminalIdField,
    cols: colsField,
    rows: rowsField,
  })
  .strict();
export const TerminalsKillParamsSchema = z
  .object({
    terminalId: terminalIdField,
  })
  .strict();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidParamsOutcome(id: JsonRpcId, message: string): RouteOutcome {
  return {
    kind: "response",
    frame: JSON.stringify(errorResponse(id, JSON_RPC_ERROR_CODES.INVALID_PARAMS, message)),
  };
}

function internalErrorOutcome(id: JsonRpcId, message: string): RouteOutcome {
  return {
    kind: "response",
    frame: JSON.stringify(errorResponse(id, JSON_RPC_ERROR_CODES.INTERNAL_ERROR, message)),
  };
}

function successOutcome(id: JsonRpcId, result: unknown): RouteOutcome {
  return { kind: "response", frame: JSON.stringify(successResponse(id, result)) };
}

/** 处理 terminals.* 请求（router 已确认 deps.terminals 注入） */
export function handleTerminalsRequest(request: JsonRpcRequest, pool: TerminalPool): RouteOutcome {
  const { id, method, params } = request;
  if (params === undefined) {
    return invalidParamsOutcome(id, `${method} 需要参数对象`);
  }

  switch (method) {
    case "terminals.create": {
      const parsed = TerminalsCreateParamsSchema.safeParse(params);
      if (!parsed.success) {
        return invalidParamsOutcome(id, `terminals.create 参数非法：${parsed.error.message}`);
      }
      try {
        // projectId/workspaceId 仅做校验：终端与项目/工作区的持久关联落库在 P0-11（agents 驾驶舱接线）
        const handle = pool.create({
          cwd: parsed.data.cwd,
          cols: parsed.data.cols,
          rows: parsed.data.rows,
        });
        return successOutcome(id, { terminalId: handle.terminalId, pid: handle.pid });
      } catch (cause) {
        return internalErrorOutcome(id, `终端创建失败：${errorMessage(cause)}`);
      }
    }
    case "terminals.write": {
      const parsed = TerminalsWriteParamsSchema.safeParse(params);
      if (!parsed.success) {
        return invalidParamsOutcome(id, `terminals.write 参数非法：${parsed.error.message}`);
      }
      const { terminalId, data } = parsed.data;
      if (!pool.write(terminalId, data)) {
        return invalidParamsOutcome(id, `未知终端，写入被拒：terminalId=${terminalId}`);
      }
      return successOutcome(id, null);
    }
    case "terminals.resize": {
      const parsed = TerminalsResizeParamsSchema.safeParse(params);
      if (!parsed.success) {
        return invalidParamsOutcome(id, `terminals.resize 参数非法：${parsed.error.message}`);
      }
      const { terminalId, cols, rows } = parsed.data;
      if (!pool.resize(terminalId, cols, rows)) {
        return invalidParamsOutcome(id, `未知终端，resize 被拒：terminalId=${terminalId}`);
      }
      return successOutcome(id, null);
    }
    case "terminals.kill": {
      const parsed = TerminalsKillParamsSchema.safeParse(params);
      if (!parsed.success) {
        return invalidParamsOutcome(id, `terminals.kill 参数非法：${parsed.error.message}`);
      }
      // 立即应答；dispose 内部有信号升级与 settle 兜底，promise 恒收敛，
      // catch 仅为类型防御。退出证明经 terminal.<id>.exit 事件推送。
      void pool.kill(parsed.data.terminalId).catch(() => undefined);
      return successOutcome(id, null);
    }
  }
  // switch 已覆盖 TerminalsMethod 全部成员；此处兜底仅因 request.method 名义类型
  // 是 string（router 的 isTerminalsMethod 收窄不跨越函数边界）
  return invalidParamsOutcome(id, `未知 terminals 方法：${method}`);
}
