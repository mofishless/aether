// terminal-pool：terminalId → 会话 Map（§7.1，VK PtyService 形状）。
// create/write/resize/kill/disposeAll，形状对齐 contracts/rpc.ts 的 terminals.* 语义
// （daemon RPC 挂接在 P0-10）。kill 幂等；自然退出后条目保留（attach 可查有界历史），
// 显式 kill/disposeAll 才移除。每会话独立 seq（从 1 起）与有界历史（§7.2）。
import { randomUUID } from "node:crypto";
import type { TerminalExitFrame, TerminalOutputFrame } from "@aether/contracts";
import { TERMINAL_HISTORY_CAPACITY_BYTES, createBoundedHistory } from "./bounded-history.js";
import type { BoundedHistory } from "./bounded-history.js";
import { buildExitFrame, buildOutputFrame } from "./frame-codec.js";
import { createPtySession } from "./pty-session.js";
import type { PtyExitProof, PtySession } from "./pty-session.js";

export interface TerminalPoolOptions {
  /** 每终端历史容量（字节），默认 256KiB */
  historyCapacityBytes?: number;
}

export interface TerminalPoolCreateInput {
  /** 缺省自动生成 UUID */
  terminalId?: string;
  cwd?: string;
  env?: Record<string, string>;
  name?: string;
  cols: number;
  rows: number;
  /** 显式指定可执行文件（默认按平台探测 shell；测试注入缝） */
  file?: string;
  args?: string[];
  useConpty?: boolean;
}

export interface TerminalPoolHandle {
  terminalId: string;
  pid: number;
}

interface PoolEntry {
  readonly session: PtySession;
  readonly history: BoundedHistory;
}

type OutputListener = (frame: TerminalOutputFrame) => void;
type ExitListener = (frame: TerminalExitFrame) => void;

export interface TerminalPool {
  /** 当前会话数（含已自然退出、待 kill 清理的条目） */
  readonly size: number;
  create(input: TerminalPoolCreateInput): TerminalPoolHandle;
  /** 写入 base64 字节流；未知终端返回 false */
  write(terminalId: string, data: string): boolean;
  resize(terminalId: string, cols: number, rows: number): boolean;
  /** 回放序列（§7.2 attach 先发历史再续增量）；未知终端返回 null */
  historyFrames(terminalId: string): TerminalOutputFrame[] | null;
  /** 幂等：未知/已杀终端返回 null；已知终端强杀、移除条目并 resolve 退出证明 */
  kill(terminalId: string): Promise<PtyExitProof | null>;
  disposeAll(): Promise<void>;
  /** 全池输出帧订阅（terminal.<id>.output 扇形出站）；返回退订函数 */
  onOutput(listener: OutputListener): () => void;
  /** 全池退出帧订阅；返回退订函数 */
  onExit(listener: ExitListener): () => void;
}

export function createTerminalPool(options: TerminalPoolOptions = {}): TerminalPool {
  const historyCapacityBytes = options.historyCapacityBytes ?? TERMINAL_HISTORY_CAPACITY_BYTES;
  const entries = new Map<string, PoolEntry>();
  const outputListeners = new Set<OutputListener>();
  const exitListeners = new Set<ExitListener>();

  return {
    get size() {
      return entries.size;
    },
    create(input: TerminalPoolCreateInput): TerminalPoolHandle {
      const terminalId = input.terminalId ?? randomUUID();
      if (entries.has(terminalId)) {
        throw new Error(`终端 ${terminalId} 已存在，不能重复创建`);
      }
      // exactOptionalPropertyTypes：可选项仅在显式提供时透传给会话（假值 spread 为无操作）
      const session = createPtySession({
        terminalId,
        cols: input.cols,
        rows: input.rows,
        ...(input.cwd !== undefined && { cwd: input.cwd }),
        ...(input.env !== undefined && { env: input.env }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.file !== undefined && { file: input.file }),
        ...(input.args !== undefined && { args: input.args }),
        ...(input.useConpty !== undefined && { useConpty: input.useConpty }),
      });
      const history = createBoundedHistory(historyCapacityBytes);

      session.onOutput((chunk) => {
        history.push(chunk);
        const frame = buildOutputFrame(terminalId, chunk.seq, chunk.data);
        // Set 迭代中退订（删除未访问项）是安全的 JS 语义，直接迭代即可
        for (const listener of outputListeners) {
          listener(frame);
        }
      });
      void session.exited.then((proof) => {
        const frame = buildExitFrame(terminalId, proof.exitCode);
        for (const listener of exitListeners) {
          listener(frame);
        }
      });

      entries.set(terminalId, { session, history });
      return { terminalId, pid: session.pid };
    },
    write(terminalId: string, data: string): boolean {
      const entry = entries.get(terminalId);
      if (entry === undefined) {
        return false;
      }
      entry.session.write(data);
      return true;
    },
    resize(terminalId: string, cols: number, rows: number): boolean {
      const entry = entries.get(terminalId);
      if (entry === undefined) {
        return false;
      }
      entry.session.resize(cols, rows);
      return true;
    },
    historyFrames(terminalId: string): TerminalOutputFrame[] | null {
      const entry = entries.get(terminalId);
      if (entry === undefined) {
        return null;
      }
      return entry.history
        .historyFrames()
        .map((chunk) => buildOutputFrame(terminalId, chunk.seq, chunk.data));
    },
    kill(terminalId: string): Promise<PtyExitProof | null> {
      const entry = entries.get(terminalId);
      if (entry === undefined) {
        return Promise.resolve(null);
      }
      entries.delete(terminalId);
      return entry.session.dispose();
    },
    async disposeAll(): Promise<void> {
      const disposals = [...entries.values()].map((entry) => entry.session.dispose());
      entries.clear();
      await Promise.all(disposals);
    },
    onOutput(listener: OutputListener): () => void {
      outputListeners.add(listener);
      return () => {
        outputListeners.delete(listener);
      };
    },
    onExit(listener: ExitListener): () => void {
      exitListeners.add(listener);
      return () => {
        exitListeners.delete(listener);
      };
    },
  };
}
