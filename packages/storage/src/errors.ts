/** 存储层统一错误：携带操作/表/实体 id 上下文；message 面向用户，detail 保留原始错误供调试。 */
export interface StorageErrorInit {
  operation: string;
  table: string;
  entityId?: string | number;
  message: string;
  detail?: unknown;
}

export class StorageError extends Error {
  readonly operation: string;
  readonly table: string;
  readonly entityId: string | number | undefined;
  readonly detail: unknown;

  constructor(init: StorageErrorInit) {
    super(init.message);
    this.name = "StorageError";
    this.operation = init.operation;
    this.table = init.table;
    this.entityId = init.entityId;
    this.detail = init.detail;
  }
}

export interface StorageErrorContext {
  operation: string;
  table: string;
  entityId?: string | number;
  message: string;
}

/** 把底层 SQLite 异常包装为带上下文的 StorageError；已是 StorageError 则原样透传（避免双层包装）。 */
export function toStorageError(error: unknown, context: StorageErrorContext): StorageError {
  if (error instanceof StorageError) {
    return error;
  }
  return new StorageError({ ...context, detail: error });
}
