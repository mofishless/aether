// ===== Codex app-server JSONL RPC 客户端（协议定案 §1/§2/§4/§7/§9）=====
// 自研传输（§10 定案：不引 SDK）：行缓冲读 stdout → frame-router 四分支 →
// pending Map 关联响应；服务端请求（审批）并发应答、原样回传 id（§9-4 两个 id
// 空间独立）；initialize 握手（experimentalApi:true 必须声明，§9-2，10s 超时）；
// stdin EOF / 进程退出后 250ms 宽限再判死（T3 生产参数，§7）；stderr tail 8KB 摘录。
import type { ProcessHandle } from "@aether/process-host";
import {
  createFrameRouter,
  type FrameRouterCounters,
  type ServerNotificationFrame,
  type ServerRequestFrame,
} from "./frame-router.js";

/** RPC 错误响应（-32600/-32601/-32602/-32603/-32001，协议定案 §1） */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** 传输层死亡（进程退出/管道断裂/EOF 宽限超时后 pending 清算） */
export class RpcTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcTransportError";
  }
}

/** 单请求超时（pending 移除；迟到响应按 orphan 计数） */
export class RpcTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcTimeoutError";
  }
}

/** initialize 入参的 clientInfo（§2.2：name 必填，title/version 可选） */
export interface RpcClientInfo {
  readonly name: string;
  readonly title?: string;
  readonly version?: string;
}

/** 服务端请求处理结果：handled=false 时客户端以 -32601 兜底应答（防悬挂） */
export type ServerRequestOutcome =
  | { readonly handled: true; readonly result: unknown }
  | { readonly handled: false };

export interface JsonlRpcClientOptions {
  /** 治理句柄（spawnCommand 产出；stdin/stdout 必须为 pipe） */
  readonly handle: ProcessHandle;
  /** 已知通知 → 适配器归一化（白名单外的通知静默忽略并计数，§8） */
  readonly onNotification: (frame: ServerNotificationFrame) => void;
  /** 已知服务端请求 → 审批流；返回 handled=false 触发 -32601 兜底 */
  readonly onServerRequest: (
    frame: ServerRequestFrame,
  ) => ServerRequestOutcome | Promise<ServerRequestOutcome>;
  /** 服务端请求方法白名单（§8 方法白名单 + 未知容忍；白名单外由客户端 -32601 兜底应答防悬挂） */
  readonly serverRequestMethods?: ReadonlySet<string>;
  /** 通知方法白名单（白名单外静默忽略并计数） */
  readonly notificationMethods?: ReadonlySet<string>;
  /** initialize 握手超时（默认 10s，§10 定案） */
  readonly initializeTimeoutMs?: number;
  /** 普通请求默认超时（默认 30s；可被 request 入参覆盖） */
  readonly defaultRequestTimeoutMs?: number;
  /** stdin EOF / 进程退出后的判死宽限（默认 250ms，§7 T3 参数） */
  readonly eofGraceMs?: number;
  /** stderr tail 容量（默认 8KB，§7 T3 参数） */
  readonly stderrTailBytes?: number;
}

interface PendingEntry {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface JsonlRpcClient {
  /** 握手：initialize（capabilities.experimentalApi=true）→ initialized 通知 */
  initialize(clientInfo: RpcClientInfo): Promise<void>;
  /** 发请求并等响应；错误响应 reject RpcError，超时 reject RpcTimeoutError */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  /** 发通知（无 id；如 initialized） */
  notify(method: string, params?: unknown): void;
  /** 应答服务端请求：原样回传其 id（字符串/整数皆可，§9-4） */
  respondServerRequest(id: string | number, result: unknown): void;
  /** 关闭写端（stdin.end → 服务端按 stdio 单客户端语义退出，§7） */
  close(): void;
  /** stderr tail 摘录（最近 8KB，诊断用） */
  stderrTail(): string;
  /** 传输是否已判死（EOF 宽限后） */
  isDead(): boolean;
  /** 容忍计数快照（含未知方法/兜底应答计数） */
  stats(): FrameRouterCounters & { pendingCount: number; autoAnsweredServerRequests: number };
}

const INITIALIZE_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const EOF_GRACE_MS = 250;
const STDERR_TAIL_BYTES = 8192;
const METHOD_NOT_FOUND = -32601;

function isMinStdio(handle: ProcessHandle): boolean {
  return handle.stdin !== null && handle.stdout !== null;
}

/** 取非空管道（构造期校验后窄化，闭包内保持窄化类型） */
function requireStream<T>(stream: T | null, name: string): T {
  if (stream === null) {
    throw new Error(`codex app-server spawn 的 ${name} 必须为 pipe`);
  }
  return stream;
}

/**
 * 创建 JSONL RPC 客户端。构造即挂流监听（stdout 行缓冲 → 路由分发；
 * 进程死亡 → eofGrace 宽限 → pending 清算 RpcTransportError）。
 * 写失败（EPIPE 等）与读侧死亡同路径收敛，不抛出构造期异常。
 */
export function createJsonlRpcClient(options: JsonlRpcClientOptions): JsonlRpcClient {
  const { handle, onNotification, onServerRequest } = options;
  if (!isMinStdio(handle)) {
    throw new Error("codex app-server spawn stdio 必须为 pipe（JSONL RPC 需要 stdin/stdout 管道）");
  }
  const stdin = requireStream(handle.stdin, "stdin");
  const stdout = requireStream(handle.stdout, "stdout");
  const stderr = handle.stderr;
  const initializeTimeoutMs = options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS;
  const defaultTimeoutMs = options.defaultRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const eofGraceMs = options.eofGraceMs ?? EOF_GRACE_MS;
  const stderrTailBytes = options.stderrTailBytes ?? STDERR_TAIL_BYTES;

  let nextId = 1;
  let dead = false;
  /** 宽限期结束后置位：此后 stdout 迟到数据不再分发（判死成立） */
  let frozen = false;
  let writeBroken = "";
  let stderrBuffer = "";
  const pending = new Map<number, PendingEntry>();

  const failAllPending = (error: Error): void => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const markDead = (reason: string): void => {
    if (dead) return;
    dead = true;
    // §7 T3 参数：EOF 后 250ms 宽限再判死——宽限窗口内 buffered 响应仍可送达 pending
    setTimeout(() => {
      frozen = true;
      failAllPending(new RpcTransportError(reason));
    }, eofGraceMs);
  };

  const writeFrame = (frame: Record<string, unknown>): void => {
    if (dead || writeBroken.length > 0) {
      throw new RpcTransportError(
        writeBroken.length > 0 ? `stdin 已不可写（${writeBroken}）` : "传输已判死，拒绝写出",
      );
    }
    stdin.write(`${JSON.stringify(frame)}\n`);
  };

  /** 白名单外服务端请求的 -32601 兜底应答计数（§8 容忍观测） */
  let autoAnsweredServerRequests = 0;

  const router = createFrameRouter({
    ...(options.serverRequestMethods !== undefined
      ? { serverRequestMethods: options.serverRequestMethods }
      : {}),
    ...(options.notificationMethods !== undefined
      ? { notificationMethods: options.notificationMethods }
      : {}),
    onNotification,
    onServerRequest: (frame) => {
      // 服务端请求在流读取回调内派发：审批应答可能异步，这里 fire-and-forget，
      // 不阻塞读循环（并发应答能力，§4）；异常收敛为 -32601 兜底防悬挂。
      void (async () => {
        try {
          const outcome = await onServerRequest(frame);
          if (outcome.handled) {
            writeFrame({ id: frame.id, result: outcome.result });
          } else {
            autoAnsweredServerRequests += 1;
            writeFrame({
              id: frame.id,
              error: { code: METHOD_NOT_FOUND, message: `未知服务端请求方法：${frame.method}` },
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          try {
            autoAnsweredServerRequests += 1;
            writeFrame({ id: frame.id, error: { code: METHOD_NOT_FOUND, message } });
          } catch {
            // 写端已死：进程终止时审批应答无处可送，静默收敛
          }
        }
      })();
    },
    onResponse: (id, payload) => {
      const numericId = typeof id === "number" ? id : Number(id);
      const entry = pending.get(numericId);
      if (entry === undefined) {
        return false; // 迟到/不认识的响应（如超时后到达）→ 路由器计 orphan
      }
      pending.delete(numericId);
      clearTimeout(entry.timer);
      if ("error" in payload) {
        entry.reject(new RpcError(payload.error.message, payload.error.code, payload.error.data));
      } else {
        entry.resolve(payload.result);
      }
      return true;
    },
    onUnknownServerRequest: (frame) => {
      // 白名单外服务端请求：客户端直接 -32601 兜底应答（服务端有审批超时，但
      // 显式应答比悬挂更干净，§8 未知容忍），并计数
      autoAnsweredServerRequests += 1;
      try {
        writeFrame({
          id: frame.id,
          error: { code: METHOD_NOT_FOUND, message: `未知服务端请求方法：${frame.method}` },
        });
      } catch {
        // 写端已死：无处可答，静默收敛
      }
    },
  });

  // ---- stdout 行缓冲：按 \n 切行、剥行尾 \r（协议 §1 读取侧义务）、end 时冲刷尾行 ----
  let lineBuffer = "";
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    if (frozen) return; // 宽限期后判死成立：迟到数据不再分发
    lineBuffer += chunk;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      router.feedLine(line);
    }
  });
  stdout.on("end", () => {
    const tail = lineBuffer;
    lineBuffer = "";
    if (tail.trim().length > 0) {
      router.feedLine(tail);
    }
    markDead("stdout 已结束（服务端关闭或进程退出）");
  });
  stdout.on("error", () => {
    markDead("stdout 流错误");
  });

  if (stderr !== null) {
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      stderrBuffer += chunk;
      if (stderrBuffer.length > stderrTailBytes) {
        stderrBuffer = stderrBuffer.slice(stderrBuffer.length - stderrTailBytes);
      }
    });
  }

  stdin.on("error", (error: Error) => {
    writeBroken = error.message;
    markDead(`stdin 写失败：${error.message}`);
  });

  void handle.exited.then(
    () => {
      markDead("codex app-server 进程已退出");
    },
    () => {
      markDead("codex app-server 进程 spawn 失败");
    },
  );

  return {
    async initialize(clientInfo: RpcClientInfo): Promise<void> {
      // §2.2：initialize 是唯一免检方法；capabilities.experimentalApi=true 必须声明
      // （否则 approvalPolicy/sandbox 等以 -32600 拒绝，§9-2）；initialized 通知礼貌发送。
      await this.request(
        "initialize",
        { clientInfo, capabilities: { experimentalApi: true } },
        initializeTimeoutMs,
      );
      this.notify("initialized", {});
    },

    request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
      const id = nextId;
      nextId += 1;
      const timeout = timeoutMs ?? defaultTimeoutMs;
      return new Promise<unknown>((resolve, reject) => {
        const entry: PendingEntry = {
          resolve,
          reject,
          timer: setTimeout(() => {
            if (pending.delete(id)) {
              reject(new RpcTimeoutError(`请求 ${method} 超时（${timeout}ms）`));
            }
          }, timeout),
        };
        pending.set(id, entry);
        try {
          writeFrame({
            id,
            method,
            ...(params !== undefined ? { params } : {}),
          });
        } catch (error) {
          pending.delete(id);
          clearTimeout(entry.timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    notify(method: string, params?: unknown): void {
      writeFrame({
        method,
        ...(params !== undefined ? { params } : {}),
      });
    },

    respondServerRequest(id: string | number, result: unknown): void {
      // §9-4：应答必须回传服务端原 id（字符串/整数原样），与客户端自身请求 id 空间独立
      writeFrame({ id, result });
    },

    close(): void {
      // §7：stdio 单客户端模式——stdin EOF 即服务端退出；优雅退出保持 stdin 打开至
      // 收到最终状态，close() 只在终局（cancel/dispose）调用
      try {
        stdin.end();
      } catch {
        // 已销毁：无害 no-op
      }
    },

    stderrTail(): string {
      return stderrBuffer;
    },

    isDead(): boolean {
      return dead;
    },

    stats(): FrameRouterCounters & { pendingCount: number; autoAnsweredServerRequests: number } {
      return {
        ...router.counters(),
        pendingCount: pending.size,
        autoAnsweredServerRequests,
      };
    },
  };
}
