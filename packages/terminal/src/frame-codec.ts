// frame-codec：contracts/terminal.ts 四帧的构造与 parse（zod 复用，§7.3/§7.4）。
// 构造即校验：产出的一定是可上线的合法 wire 帧（mode=byte-replay / version=1 升级位齐带）。
// 注：不直接 import zod（本包依赖仅 node-pty + contracts），以结构化类型消费 schema 结果。
import {
  TERMINAL_FRAME_MODE,
  TERMINAL_FRAME_VERSION,
  TerminalExitFrameSchema,
  TerminalFrameSchema,
  TerminalInputFrameSchema,
  TerminalOutputFrameSchema,
  TerminalResizeFrameSchema,
} from "@aether/contracts";
import type {
  TerminalExitFrame,
  TerminalFrame,
  TerminalInputFrame,
  TerminalOutputFrame,
  TerminalResizeFrame,
} from "@aether/contracts";

/** safeParse 失败分支携带的错误（结构化子集，足够诊断；path 在 zod 4 中可缺省） */
interface IssuesError {
  issues: ReadonlyArray<{ path?: ReadonlyArray<PropertyKey>; message: string }>;
}

type ParseResult<T> = { success: true; data: T } | { success: false; error: IssuesError };

/** 把校验问题压成一行中文诊断 */
function issueDetail(error: IssuesError): string {
  const detail = error.issues
    .map((issue) => `${(issue.path ?? []).map(String).join(".")}: ${issue.message}`)
    .join("; ");
  return detail.length > 0 ? detail : "未知校验错误";
}

/** 校验并解包：非法入参抛中文错误 */
function unwrapResult<T>(result: ParseResult<T>, label: string): T {
  if (!result.success) {
    throw new Error(`${label}: ${issueDetail(result.error)}`);
  }
  return result.data;
}

/** 终端增量输出帧（daemon → 客户端） */
export function buildOutputFrame(
  terminalId: string,
  seq: number,
  data: string,
): TerminalOutputFrame {
  const frame = {
    type: "output" as const,
    terminalId,
    seq,
    data,
    mode: TERMINAL_FRAME_MODE.BYTE_REPLAY,
    version: TERMINAL_FRAME_VERSION,
  };
  return unwrapResult(TerminalOutputFrameSchema.safeParse(frame), "output 帧参数非法");
}

/** 客户端 → daemon 输入帧 */
export function buildInputFrame(terminalId: string, data: string): TerminalInputFrame {
  const frame = {
    type: "input" as const,
    terminalId,
    data,
    mode: TERMINAL_FRAME_MODE.BYTE_REPLAY,
    version: TERMINAL_FRAME_VERSION,
  };
  return unwrapResult(TerminalInputFrameSchema.safeParse(frame), "input 帧参数非法");
}

/** 客户端 → daemon 尺寸变更帧 */
export function buildResizeFrame(
  terminalId: string,
  cols: number,
  rows: number,
): TerminalResizeFrame {
  const frame = {
    type: "resize" as const,
    terminalId,
    cols,
    rows,
    mode: TERMINAL_FRAME_MODE.BYTE_REPLAY,
    version: TERMINAL_FRAME_VERSION,
  };
  return unwrapResult(TerminalResizeFrameSchema.safeParse(frame), "resize 帧参数非法");
}

/** 终端退出帧（exitCode null = 信号死/异常终止） */
export function buildExitFrame(terminalId: string, exitCode: number | null): TerminalExitFrame {
  const frame = {
    type: "exit" as const,
    terminalId,
    exitCode,
    mode: TERMINAL_FRAME_MODE.BYTE_REPLAY,
    version: TERMINAL_FRAME_VERSION,
  };
  return unwrapResult(TerminalExitFrameSchema.safeParse(frame), "exit 帧参数非法");
}

/** 解析未知来源的帧（wire 边界校验用）：非法帧抛中文错误 */
export function parseTerminalFrame(value: unknown): TerminalFrame {
  return unwrapResult(TerminalFrameSchema.safeParse(value), "终端帧解析失败");
}
