// @aether/terminal —— daemon 内 PTY 终端子系统（SYSTEM_DESIGN §7，P0-08）：
// node-pty 会话封装与终端池（只服务人类 shell 终端 pane；TUI-in-PTY 为 P2+ 扩展位）、
// 有界字节历史（attach 先回放再续增量）、渲染帧编解码（contracts/terminal.ts 四帧 + mode/version 升级位）、
// Windows ConPTY 预热（调研 06 §9.1）。daemon RPC 挂接（terminals.*）在 P0-10。
// 依赖方向：node-pty + @aether/contracts，仅此两项。
export {
  TERMINAL_HISTORY_CAPACITY_BYTES,
  createBoundedHistory,
  type BoundedHistory,
  type HistoryChunk,
} from "./bounded-history.js";
export {
  buildExitFrame,
  buildInputFrame,
  buildOutputFrame,
  buildResizeFrame,
  parseTerminalFrame,
} from "./frame-codec.js";
export {
  createPtySession,
  type PtyExitProof,
  type PtyOutputChunk,
  type PtySession,
  type PtySpawnOptions,
} from "./pty-session.js";
export { resolveDefaultShell } from "./shell.js";
export {
  createTerminalPool,
  type TerminalPool,
  type TerminalPoolCreateInput,
  type TerminalPoolHandle,
  type TerminalPoolOptions,
} from "./terminal-pool.js";
export { isConptyWarmed, warmupConpty } from "./warmup.js";
