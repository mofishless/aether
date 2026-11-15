// daemon 启动器 · 进程层。纯 TS（禁 import electron）——vitest(node) 与 Electron 主进程双宿主：
// - Electron 宿主下 process.execPath = electron.exe，必须带 ELECTRON_RUN_AS_NODE=1 才能当 node 用；
//   node 宿主（vitest）下该 env 无害（spike 已验证，P0-01）。
// spawn 协议（以 apps/daemon/src/index.ts 为准）：env AETHER_DAEMON_TOKEN 注入一次性 token；
// stdout 单行 {"type":"listening","port":N} 给端口；诊断一律 stderr。
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

/** 等待 listening 行的默认超时 */
export const DEFAULT_LISTENING_TIMEOUT_MS = 10_000;

/** stderr 尾部保留量：错误信息带上下文但不无限膨胀 */
const STDERR_TAIL_LIMIT = 2000;

/** 一次性 token：32 字节随机数的 hex。只存在于父进程内存与子进程 env，绝不写日志/stdout */
export function generateDaemonToken(): string {
  return randomBytes(32).toString("hex");
}

export interface DaemonSpawnOptions {
  /** daemon 入口（apps/daemon 产物的 index.js）。由调用方解析：主进程用 app path，测试用显式路径 */
  readonly daemonEntryPath: string;
  readonly token: string;
  /** 传给 daemon 的 argv（如故障注入 flag --hang-silent / --hang-signal） */
  readonly args?: readonly string[];
  /** 追加注入 daemon env（P0-11：launcher 注入 AETHER_DAEMON_DB_PATH；E2E 隔离库同缝覆盖） */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** listening 行超时 ms，默认 10s */
  readonly listeningTimeoutMs?: number;
  /** spawn 一发起即回调：stop 时可立即杀掉"listening 等待中"的子进程，防孤儿 */
  readonly onSpawned?: (child: ChildProcess) => void;
  /** stderr 行级透传；缺省 console.error 前缀 [daemon] */
  readonly onStderrLine?: (line: string) => void;
}

/**
 * 组装 daemon 子进程 env：继承父进程（AETHER_AGENT_CLI_PATH / AETHER_MOCK_SCRIPT 等
 * E2E 注入经此透传）→ extraEnv 覆盖 → 协议保留键最后落座（token/run-as-node 不可被覆盖）。
 * 独立纯函数便于单测锁定优先级。
 */
export function buildDaemonEnv(
  baseEnv: NodeJS.ProcessEnv,
  token: string,
  extraEnv: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ...extraEnv,
    ELECTRON_RUN_AS_NODE: "1",
    AETHER_DAEMON_TOKEN: token,
  };
}

export interface DaemonExitInfo {
  readonly code: number | null;
  readonly signal: string | null;
  /** spawn 失败（如 ENOENT）的错误消息；正常退出为 null */
  readonly error: string | null;
}

export interface DaemonSpawnHandle {
  readonly child: ChildProcess;
  /** listening 行解析出的端口 */
  readonly port: number;
  /** 进程退出（exit 或 spawn error）后 resolve 一次 */
  readonly exited: Promise<DaemonExitInfo>;
  /** 强杀（POSIX SIGKILL / Windows TerminateProcess）；已退出则为无害 no-op */
  kill(): void;
}

/** 解析 listening 行：{"type":"listening","port":N} → N；其余行返回 null（容错跳过） */
function parsePortFromLine(line: string): number | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "listening") return null;
  const port = record["port"];
  return typeof port === "number" && Number.isInteger(port) && port > 0 ? port : null;
}

/** stderr 流：行级透传 + 尾部留存（错误诊断上下文） */
interface StderrTail {
  push(chunk: string): void;
  flush(): void;
  tail(): string;
}

function createStderrTail(onLine?: (line: string) => void): StderrTail {
  let buffer = "";
  let tail = "";
  const emit = (line: string): void => {
    tail = `${tail}${line}\n`.slice(-STDERR_TAIL_LIMIT);
    if (onLine !== undefined) {
      onLine(line);
    } else {
      console.error(`[daemon] ${line}`);
    }
  };
  return {
    push(chunk) {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) emit(line);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    flush() {
      const rest = buffer.trim();
      buffer = "";
      if (rest.length > 0) emit(rest);
    },
    tail: () => tail.trim(),
  };
}

function exitInfoOf(code: number | null, signal: string | null): DaemonExitInfo {
  return Object.freeze({ code, signal, error: null });
}

/**
 * spawn daemon 子进程并等待 listening 行。
 * 失败（listening 超时 / 提前退出 / spawn error）时先杀子进程再 reject——本函数不留孤儿。
 */
export function spawnDaemon(options: DaemonSpawnOptions): Promise<DaemonSpawnHandle> {
  const {
    daemonEntryPath,
    token,
    extraEnv = {},
    listeningTimeoutMs = DEFAULT_LISTENING_TIMEOUT_MS,
    onSpawned,
    onStderrLine,
  } = options;
  const args = options.args ?? [];

  const child = spawn(process.execPath, [daemonEntryPath, ...args], {
    env: buildDaemonEnv(process.env, token, extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
  onSpawned?.(child);

  const stderr = createStderrTail(onStderrLine);
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));

  const exited = new Promise<DaemonExitInfo>((resolve) => {
    child.once("exit", (code, signal) => {
      stderr.flush();
      resolve(exitInfoOf(code, signal));
    });
    // spawn 失败（入口不存在等）只发 error；kill 竞态误发时 resolve 幂等
    child.once("error", (error: Error) => {
      stderr.flush();
      resolve(Object.freeze({ code: null, signal: null, error: error.message }));
    });
  });

  const kill = (): void => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // 已退出的竞态：无需处理
    }
  };

  return new Promise<DaemonSpawnHandle>((resolve, reject) => {
    let settled = false;
    let stdoutText = "";

    const settleReject = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeListener("data", onStdout);
      // 失败路径不留孤儿：本函数的子进程自己清理
      kill();
      reject(new Error(message));
    };

    const timer = setTimeout(() => {
      settleReject(
        `daemon 未在 ${listeningTimeoutMs}ms 内输出 listening 行；stderr 尾部：${stderr.tail()}`,
      );
    }, listeningTimeoutMs);

    void exited.then((info) => {
      if (settled) return;
      const reason =
        info.error !== null
          ? `daemon spawn 失败：${info.error}`
          : `daemon 在 listening 前退出（code=${info.code} signal=${info.signal}）`;
      settleReject(`${reason}；stderr 尾部：${stderr.tail()}`);
    });

    const onStdout = (chunk: Buffer): void => {
      stdoutText += chunk.toString();
      let newlineIndex = stdoutText.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stdoutText.slice(0, newlineIndex).trim();
        stdoutText = stdoutText.slice(newlineIndex + 1);
        const port = parsePortFromLine(line);
        if (port !== null) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.stdout?.removeListener("data", onStdout);
          // 继续消费 stdout 防管道背压（协议约定后续不再有输出）
          child.stdout?.on("data", () => undefined);
          resolve(Object.freeze({ child, port, exited, kill }));
          return;
        }
        newlineIndex = stdoutText.indexOf("\n");
      }
    };
    child.stdout?.on("data", onStdout);
  });
}
