import type { ExecutionProcessLog } from "@aether/contracts";

// 依赖倒置端口（SYSTEM_DESIGN §4.4：core 只依赖 contracts，不 import storage）。
// 形状与 storage 的 ExecutionProcessLogRepository 公共方法面保持结构同形
// （appendBatch / findByProcessId / updateNormalized；同步方法、同参数语义），
// 因此该 Repository 结构性满足本接口，daemon 可直接传入而无需适配器
// （与 workspace-store.port.ts 同法）。

/** 与 storage ExecutionProcessLogCreateInput 结构一致；id/createdAt 由 store 生成。 */
export interface ExecutionLogAppendInput {
  processId: string;
  seq: number;
  rawJson: string;
  /** 原始先存口径：写路径（sink）一律不带，旁路重放回填时才写。 */
  normalizedJson?: string | null;
}

/**
 * 执行日志行存取端口（§4.4 写路径批量落库 + P0-09 重放读序列/回填）。
 * 写路径在热路径之外由 sink 批量调用；重放路径离线逐行回填。
 */
export interface ExecutionLogStore {
  /** 单事务批量 INSERT；任一行失败（如外键非法）整批回滚并抛错。@returns 实际写入行数。 */
  appendBatch(rows: readonly ExecutionLogAppendInput[]): number;
  /** 按 processId 读该进程的日志行序列（seq 升序）；无行返回空数组。 */
  findByProcessId(processId: string): ExecutionProcessLog[];
  /** 回填一行的 normalized_json（旁路转换缓存；行不存在时静默无副作用，重放幂等）。 */
  updateNormalized(id: number, normalizedJson: string): void;
}
