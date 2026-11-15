// pty-session：单个 PTY 会话的 node-pty 封装（§7.1）。
// spawn（cwd/env/name/cols/rows/useConpty）→ write(base64→字节) / resize / 输出订阅(base64 帧) /
// 退出证明 {exitCode, signal} / dispose 强杀释放（幂等）。
// 输出经 node-pty 的 utf8 StringDecoder（跨 chunk 多字节边界安全）→ base64；
// 输入直接传 Buffer 字节（byte-replay 语义）。Windows ConPTY 预热见 warmup.ts。
import { spawn } from "node-pty";
import type { IPty } from "node-pty";
import { EventEmitter } from "node:events";
import { resolveDefaultShell } from "./shell.js";

/** 输出帧数据：会话内单调递增序号（从 1 起）+ base64 字节流 */
export interface PtyOutputChunk {
  seq: number;
  data: string;
}

/** 退出证明：exitCode null = 信号死/异常终止（§7.3 exit 帧 exitCode 语义） */
export interface PtyExitProof {
  exitCode: number | null;
  signal: number | null;
}

export interface PtySpawnOptions {
  terminalId: string;
  cwd?: string;
  /** 增量覆盖 process.env（浅合并，非整体替换） */
  env?: Record<string, string>;
  /** TERM 名，默认 xterm-256color */
  name?: string;
  cols: number;
  rows: number;
  /** 显式指定可执行文件（默认按平台探测 shell；测试注入缝） */
  file?: string;
  args?: string[];
  /** Windows 是否走 ConPTY（默认 true；非 Windows 忽略） */
  useConpty?: boolean;
}

export interface PtySession {
  readonly terminalId: string;
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  /** 底层进程退出（含 dispose 触发）；resolve 值为退出证明 */
  readonly exited: Promise<PtyExitProof>;
  /** 写入 base64 字节流（非法 base64 抛中文错误） */
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** 订阅输出（base64 帧）；返回退订函数 */
  onOutput(listener: (chunk: PtyOutputChunk) => void): () => void;
  /** 强杀并释放 PTY 资源；幂等，resolve 退出证明 */
  dispose(): Promise<PtyExitProof>;
}

const DEFAULT_TERM_NAME = "xterm-256color";

/** 严格 base64（标准字母表 + 0-2 个填充；空串合法） */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeBase64OrThrow(data: string): Buffer {
  if (!BASE64_PATTERN.test(data)) {
    throw new Error(`write 入参必须是合法 base64 字节流: ${JSON.stringify(data.slice(0, 40))}`);
  }
  return Buffer.from(data, "base64");
}

function assertPositiveDimensions(cols: number, rows: number, context: string): void {
  if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
    throw new Error(`${context}需要正整数尺寸，收到 cols=${cols}, rows=${rows}`);
  }
}

/** 信号死/异常终止 → exitCode 归一为 null（§7.3） */
function normalizeExitCode(exitCode: number, signal: number | undefined): number | null {
  const signalNumber = signal ?? 0;
  return signalNumber !== 0 ? null : exitCode;
}

export function createPtySession(options: PtySpawnOptions): PtySession {
  const { terminalId, cols, rows } = options;
  if (terminalId.length === 0) {
    throw new Error("terminalId 不能为空");
  }
  assertPositiveDimensions(cols, rows, "创建会话");

  const file = options.file ?? resolveDefaultShell();
  if (file === null) {
    throw new Error(
      "未探测到可用 shell（win32 需 PowerShell，POSIX 需 /bin/bash 或 /bin/sh），请显式传入 file",
    );
  }
  const args = options.args ?? [];
  const env: Record<string, string | undefined> = { ...process.env, ...options.env };

  // exactOptionalPropertyTypes：可选项仅在显式提供时落入 spawn 选项（假值 spread 为无操作）
  const spawnOptions = {
    name: options.name ?? DEFAULT_TERM_NAME,
    cols,
    rows,
    env,
    encoding: "utf8",
    ...(options.cwd !== undefined && { cwd: options.cwd }),
    ...(process.platform === "win32" && { useConpty: options.useConpty ?? true }),
  };
  const pty: IPty = spawn(file, args, spawnOptions);

  let currentCols = cols;
  let currentRows = rows;
  let nextSeq = 1;
  let disposed = false;
  const outputListeners = new Set<(chunk: PtyOutputChunk) => void>();

  // 退出证明只 settle 一次；spawn 失败/套接字错误也走同一出口，exited 永不悬挂
  let settleExit: (proof: PtyExitProof) => void = () => {};
  const exited = new Promise<PtyExitProof>((resolve) => {
    settleExit = resolve;
  });
  let settled = false;
  const settle = (proof: PtyExitProof): void => {
    if (!settled) {
      settled = true;
      settleExit(proof);
    }
  };

  // node-pty 在无 'error' 监听时会把异步错误直接 throw 崩掉宿主进程
  // （unixTerminal.js 的 listeners('error') < 2 分支）；这里兜底为退出证明，保 daemon 不死。
  (pty as unknown as EventEmitter).on("error", () => {
    settle({ exitCode: null, signal: null });
  });

  pty.onExit(({ exitCode, signal }) => {
    settle({ exitCode: normalizeExitCode(exitCode, signal), signal: signal ?? null });
  });

  pty.onData((text: string) => {
    const chunk: PtyOutputChunk = {
      seq: nextSeq,
      data: Buffer.from(text, "utf8").toString("base64"),
    };
    nextSeq += 1;
    // Set 迭代中退订（删除未访问项）是安全的 JS 语义，直接迭代即可
    for (const listener of outputListeners) {
      listener(chunk);
    }
  });

  return {
    terminalId,
    get pid() {
      return pty.pid;
    },
    get cols() {
      return currentCols;
    },
    get rows() {
      return currentRows;
    },
    exited,
    write(data: string): void {
      pty.write(decodeBase64OrThrow(data));
    },
    resize(nextCols: number, nextRows: number): void {
      assertPositiveDimensions(nextCols, nextRows, "resize ");
      pty.resize(nextCols, nextRows);
      currentCols = nextCols;
      currentRows = nextRows;
    },
    onOutput(listener: (chunk: PtyOutputChunk) => void): () => void {
      outputListeners.add(listener);
      return () => {
        outputListeners.delete(listener);
      };
    },
    dispose(): Promise<PtyExitProof> {
      if (!disposed) {
        disposed = true;
        try {
          pty.kill();
        } catch {
          // 进程已退出时 kill 可能抛错：退出证明由 onExit/error 兜底 settle
        }
      }
      return exited;
    },
  };
}
