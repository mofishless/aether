// ExitProof 构造：一次性冻结的不可变记录（时间统一 UTC ISO-8601，SYSTEM_DESIGN §4.1 总则）。
import type { ExitProof } from "./types.js";

export interface ExitProofInput {
  readonly pid: number;
  readonly code: number | null;
  readonly signal: string | null;
  readonly killedByUs: boolean;
}

export function buildExitProof(input: ExitProofInput): ExitProof {
  return Object.freeze({
    pid: input.pid,
    code: input.code,
    signal: input.signal,
    killedByUs: input.killedByUs,
    exitedAt: new Date().toISOString(),
  });
}
