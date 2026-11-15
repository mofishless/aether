import { z } from "zod";

// ===== 终端渲染帧协议（SYSTEM_DESIGN §7.3 / §7.4）=====
// output/exit 为 daemon → 客户端；input/resize 为客户端 → daemon。
// 每帧携带 §7.4 升级位 mode/version（MVP 固定 byte-replay / 1），
// P3 引入 headless 快照（snapshot+delta）时升级不破坏旧帧格式。

/** §7.4 帧模式：MVP 固定 byte-replay；snapshot+delta 为 P3 预留值（先入协议，不实现） */
export const TERMINAL_FRAME_MODE = {
  BYTE_REPLAY: "byte-replay",
  SNAPSHOT_DELTA: "snapshot+delta",
} as const;
export type TerminalFrameMode = (typeof TERMINAL_FRAME_MODE)[keyof typeof TERMINAL_FRAME_MODE];

export const TerminalFrameModeSchema = z.enum(["byte-replay", "snapshot+delta"]);

/** §7.4 帧版本号：MVP 固定 1 */
export const TERMINAL_FRAME_VERSION = 1;
export const TerminalFrameVersionSchema = z.literal(TERMINAL_FRAME_VERSION);

const frameBase = {
  terminalId: z.string().min(1),
  mode: TerminalFrameModeSchema,
  version: TerminalFrameVersionSchema,
};

/** 终端增量输出（§7.2：attach 先回放有界历史再续增量） */
export const TerminalOutputFrameSchema = z.object({
  type: z.literal("output"),
  ...frameBase,
  /** 终端内单调递增序号 */
  seq: z.number().int().positive(),
  /** base64 字节流 */
  data: z.base64(),
});
export type TerminalOutputFrame = z.infer<typeof TerminalOutputFrameSchema>;

/** 客户端 → daemon 输入 */
export const TerminalInputFrameSchema = z.object({
  type: z.literal("input"),
  ...frameBase,
  /** base64 字节流 */
  data: z.base64(),
});
export type TerminalInputFrame = z.infer<typeof TerminalInputFrameSchema>;

/** 客户端 → daemon 尺寸变更 */
export const TerminalResizeFrameSchema = z.object({
  type: z.literal("resize"),
  ...frameBase,
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type TerminalResizeFrame = z.infer<typeof TerminalResizeFrameSchema>;

/** 终端退出（exitCode null = 被信号杀死等无退出码场景） */
export const TerminalExitFrameSchema = z.object({
  type: z.literal("exit"),
  ...frameBase,
  exitCode: z.number().int().nullable(),
});
export type TerminalExitFrame = z.infer<typeof TerminalExitFrameSchema>;

export const TerminalFrameSchema = z.discriminatedUnion("type", [
  TerminalOutputFrameSchema,
  TerminalInputFrameSchema,
  TerminalResizeFrameSchema,
  TerminalExitFrameSchema,
]);
export type TerminalFrame = z.infer<typeof TerminalFrameSchema>;
