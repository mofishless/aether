// daemon 启动器 · 连接层：ws 连 127.0.0.1 + hello/welcome 握手 + JSON-RPC 请求按 id 关联。
// 纯 TS（禁 import electron）。帧校验复用 contracts strict schema（禁止重复定义，SYSTEM_DESIGN §5.1）。
import { WebSocket } from "ws";
import { JsonRpcResponseSchema, PROTOCOL_VERSION, ServerWelcomeSchema } from "@aether/contracts";

export const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

export class DaemonClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonClientError";
  }
}

/** JSON-RPC params：按位置（数组）或按名（对象） */
export type JsonRpcParams = readonly unknown[] | Readonly<Record<string, unknown>>;

export interface DaemonClientOptions {
  readonly port: number;
  readonly token: string;
  /** 连接与握手（等 welcome）超时 ms，默认 5s */
  readonly connectTimeoutMs?: number;
  /** 单请求超时 ms，默认 5s */
  readonly requestTimeoutMs?: number;
}

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface DaemonClient {
  /** 心跳等协议层场景直接复用底层 socket（ws ping/pong） */
  readonly socket: WebSocket;
  /** 发请求并按 id 等响应；result 直接 resolve，error object 转 DaemonClientError reject */
  request<T = unknown>(method: string, params?: JsonRpcParams): Promise<T>;
  /** 发通知（JSON-RPC 无 id，无响应） */
  notify(method: string, params?: JsonRpcParams): void;
  /** 立即断开（terminate）：拒绝所有在途请求。幂等 */
  close(): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** welcome 校验：schema（含 daemonVersion 非空）+ protocolVersion 与本端一致；失配抛带细节错误 */
function parseWelcome(raw: string): void {
  let parsedFrame: unknown;
  try {
    parsedFrame = JSON.parse(raw);
  } catch {
    throw new DaemonClientError(`welcome 帧不是合法 JSON：${raw.slice(0, 200)}`);
  }
  const welcome = ServerWelcomeSchema.safeParse(parsedFrame);
  if (!welcome.success) {
    throw new DaemonClientError(
      `welcome 帧校验失败：${JSON.stringify(welcome.error.issues)}；原始帧：${raw.slice(0, 200)}`,
    );
  }
  const { protocolVersion, daemonVersion } = welcome.data;
  if (protocolVersion !== PROTOCOL_VERSION) {
    throw new DaemonClientError(
      `protocol version 失配：client=${PROTOCOL_VERSION} daemon=${protocolVersion}（daemon 版本 ${daemonVersion}）`,
    );
  }
}

function waitForOpen(socket: WebSocket, url: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new DaemonClientError(`连接 ${url} 超时 ${timeoutMs}ms`));
    }, timeoutMs);
    const fail = (message: string): void => {
      clearTimeout(timer);
      reject(new DaemonClientError(message));
    };
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error: Error) => fail(`连接失败：${messageOf(error)}`));
    socket.once("close", (code: number, reason: Buffer) =>
      fail(`连接被关闭：code=${code} reason=${reason.toString()}`),
    );
  });
}

function handshake(socket: WebSocket, token: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const timer = setTimeout(() => {
      cleanup();
      socket.terminate();
      reject(new DaemonClientError(`握手超时 ${timeoutMs}ms（未收到 welcome）`));
    }, timeoutMs);
    const onMessage = (data: WebSocket.RawData): void => {
      cleanup();
      try {
        parseWelcome(data.toString());
      } catch (error) {
        socket.terminate();
        reject(error instanceof Error ? error : new DaemonClientError(String(error)));
        return;
      }
      resolve();
    };
    const onClose = (code: number, reason: Buffer): void => {
      cleanup();
      reject(new DaemonClientError(`握手被拒绝：close code=${code} reason=${reason.toString()}`));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(new DaemonClientError(`握手阶段连接错误：${messageOf(error)}`));
    };
    socket.on("message", onMessage);
    socket.on("close", onClose);
    socket.on("error", onError);
    socket.send(JSON.stringify({ type: "hello", token, protocolVersion: PROTOCOL_VERSION }));
  });
}

/** 连接 daemon 并完成 hello/welcome 握手；任何一步失败都抛带细节的 DaemonClientError */
export async function connectDaemonClient(options: DaemonClientOptions): Promise<DaemonClient> {
  const {
    port,
    token,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = options;

  const url = `ws://127.0.0.1:${port}`;
  const socket = new WebSocket(url);
  await waitForOpen(socket, url, connectTimeoutMs);
  try {
    await handshake(socket, token, connectTimeoutMs);
  } catch (error) {
    socket.terminate();
    throw error;
  }

  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let closed = false;

  const failAll = (message: string): void => {
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new DaemonClientError(message));
    }
    pending.clear();
  };

  socket.on("message", (data: WebSocket.RawData) => {
    let parsedFrame: unknown;
    try {
      parsedFrame = JSON.parse(data.toString());
    } catch {
      return; // 非 JSON 帧（不应出现）：忽略，不破坏连接
    }
    const response = JsonRpcResponseSchema.safeParse(parsedFrame);
    if (!response.success) return; // 无法关联的帧留给上层（事件流等）
    const { id } = response.data;
    if (typeof id !== "number") return; // 本客户端 id 恒为自增数字
    const entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if ("error" in response.data) {
      // strict schema 下 Error 变体的 error 字段必在
      const rpcError = response.data.error;
      entry.reject(new DaemonClientError(`RPC 错误 ${rpcError.code}：${rpcError.message}`));
      return;
    }
    entry.resolve(response.data.result);
  });
  socket.on("close", () => failAll("daemon 连接已关闭"));
  socket.on("error", () => failAll("daemon 连接错误"));

  const request = <T>(method: string, params?: JsonRpcParams): Promise<T> => {
    if (closed || socket.readyState !== WebSocket.OPEN) {
      // 返回 rejected promise 而非同步 throw：调用方 .catch() 兜底路径不破
      return Promise.reject(new DaemonClientError(`发送请求 ${method} 失败：连接已关闭`));
    }
    const id = nextId;
    nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new DaemonClientError(`请求 ${method} 超时 ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);
      pending.set(id, { resolve: (result) => resolve(result as T), reject, timer });
      socket.send(
        JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }),
      );
    });
  };

  const notify = (method: string, params?: JsonRpcParams): void => {
    if (closed || socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }),
    );
  };

  return {
    socket,
    request,
    notify,
    close: () => {
      failAll("客户端主动关闭");
      socket.terminate();
    },
  };
}
