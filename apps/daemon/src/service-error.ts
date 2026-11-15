// 服务级错误（P0-11）：kind 决定 RPC 映射——invalid_params → -32602（参数引用错误，
// 如未知 id）、internal → -32603（编排失败，如 git/适配器异常）。中文消息直达客户端。

export type ServiceErrorKind = "invalid_params" | "internal";

export class ServiceError extends Error {
  readonly kind: ServiceErrorKind;

  constructor(kind: ServiceErrorKind, message: string) {
    super(message);
    this.name = "ServiceError";
    this.kind = kind;
  }
}

/** 参数引用错误（未知 id / 非法引用） */
export function invalidParamsError(message: string): ServiceError {
  return new ServiceError("invalid_params", message);
}

/** 编排失败（底层异常包装；cause 保留原始错误供排查） */
export function internalError(message: string, cause?: unknown): ServiceError {
  const suffix = cause === undefined ? "" : `（原因：${errorMessage(cause)}）`;
  return new ServiceError("internal", `${message}${suffix}`);
}

/** 安全提取 unknown 错误的 message（与 core errorMessage 同口径） */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
