// 渲染侧 daemon RPC 客户端（P0-10）：WebSocket 直连 127.0.0.1（endpoint 经 preload 注入）
// + contracts hello/welcome 握手 + JSON-RPC 2.0 请求/响应（id 关联、超时、错误码中文映射）
// + EventEnvelope 事件分发 + 指数退避（100→500ms 封顶）自动重连。
// 入站帧全部经 contracts strict schema 校验（渲染层不重复定义 wire 形状）。
// 与主进程 supervisor 各持一条连接：daemon 每连接独立握手，token 同源（spawn 时注入）。
import {
  EventEnvelopeSchema,
  JsonRpcResponseSchema,
  PROTOCOL_VERSION,
  ServerWelcomeSchema,
  STATIC_TOPIC,
} from "@aether/contracts";
import type { EventEnvelope, JsonRpcErrorObject } from "@aether/contracts";
import { DEFAULT_BACKOFF_BASE_MS, DEFAULT_BACKOFF_CAP_MS, reconnectDelayMs } from "./backoff.js";
import { createNativeWebSocket } from "./transport.js";
import type { WebSocketLike, WsEvent } from "./transport.js";

export const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

/** daemon 连接端点（preload 从主进程 supervisor 取得；重启后 port/token 均换新） */
export interface DaemonEndpoint {
  readonly port: number;
  readonly token: string;
}

export type RpcConnectionState = "connecting" | "connected" | "disconnected";

/** 不可变状态快照（onSnapshot 回调与 UI store 共用） */
export interface RpcClientSnapshot {
  readonly state: RpcConnectionState;
  /** 当前（重）连尝试序号，从 1 起 */
  readonly attempt: number;
  readonly daemonVersion: string | null;
  readonly protocolVersion: number | null;
  readonly lastError: string | null;
  /** 事件通道是否订阅成功（daemon 未实现 subscribe 时为 false，不影响连接） */
  readonly eventsSubscribed: boolean;
}

/** JSON-RPC params：按位置（数组）或按名（对象） */
export type JsonRpcParams = readonly unknown[] | Readonly<Record<string, unknown>>;

export class RpcClientError extends Error {
  /** JSON-RPC 错误码（协议层错误如超时/断线时为 undefined） */
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "RpcClientError";
    this.code = code;
  }
}

export interface RpcClientOptions {
  /** 每次（重）连尝试前调用：取当前 endpoint；null = daemon 尚未 ready */
  readonly fetchEndpoint: () => Promise<DaemonEndpoint | null>;
  /** WS 工厂注入缝（单测传 MockWebSocket；缺省浏览器原生 WebSocket） */
  readonly createWebSocket?: (url: string) => WebSocketLike;
  /** 打开与握手（等 welcome）超时 ms，默认 5000 */
  readonly connectTimeoutMs?: number;
  /** 单请求超时 ms，默认 5000 */
  readonly requestTimeoutMs?: number;
  /** 重连退避基数/封顶 ms，默认 100/500 */
  readonly backoffBaseMs?: number;
  readonly backoffCapMs?: number;
  /** 状态快照回调（不可变对象） */
  readonly onSnapshot?: (snapshot: RpcClientSnapshot) => void;
  /** 校验通过的 EventEnvelope 回调 */
  readonly onEvent?: (envelope: EventEnvelope) => void;
}

export interface DaemonRpcClient {
  /** 开始连接循环（幂等） */
  start(): void;
  /** 停止：断开连接、拒绝在途请求、不再重连（不可重启） */
  stop(): void;
  /** 发 JSON-RPC 请求并按 id 等响应；未连接/超时/错误帧/断线均 reject（RpcClientError） */
  request<T = unknown>(method: string, params?: JsonRpcParams): Promise<T>;
  getSnapshot(): RpcClientSnapshot;
}

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: RpcClientError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly method: string;
}

type Timer = ReturnType<typeof setTimeout> | null;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** WS close code → 中文语义（contracts hello 握手 close codes + 常规关闭） */
export function describeCloseCode(code: number, reason: string): string {
  const suffix = reason.length > 0 ? `（reason: ${reason}）` : "";
  switch (code) {
    case 4000:
      return `hello 帧被拒（格式错误）${suffix}`;
    case 4001:
      return `token 不符（daemon 已重启，endpoint 需刷新）${suffix}`;
    case 4002:
      return `协议版本失配${suffix}`;
    case 4003:
      return `hello 超时被拒${suffix}`;
    case 4004:
      return `握手前收到非 hello 帧${suffix}`;
    case 1001:
      return `daemon 正在关闭${suffix}`;
    default:
      return `连接关闭（code=${code}）${suffix}`;
  }
}

/** JSON-RPC 错误码 → 中文描述 */
function describeRpcErrorCode(code: number): string {
  switch (code) {
    case -32700:
      return "服务端无法解析请求帧";
    case -32600:
      return "请求帧无效";
    case -32601:
      return "方法未实现";
    case -32602:
      return "参数无效";
    case -32603:
      return "服务端内部错误";
    default:
      return code >= -32099 && code <= -32000 ? "服务端方法执行失败" : "未知 RPC 错误";
  }
}

function rpcErrorFromResponse(method: string, rpcError: JsonRpcErrorObject): RpcClientError {
  return new RpcClientError(
    `RPC 调用 ${method} 失败：${describeRpcErrorCode(rpcError.code)}（code=${rpcError.code}，服务端消息：${rpcError.message}）`,
    rpcError.code,
  );
}

/** system.version 结果的最小结构校验（contracts 未提供该方法的运行时 schema） */
function parseSystemVersion(
  result: unknown,
): { daemonVersion: string; protocolVersion: number } | null {
  if (typeof result !== "object" || result === null) return null;
  const record = result as Record<string, unknown>;
  const daemonVersion = record["daemonVersion"];
  const protocolVersion = record["protocolVersion"];
  if (typeof daemonVersion !== "string" || typeof protocolVersion !== "number") return null;
  return { daemonVersion, protocolVersion };
}

export function createDaemonRpcClient(options: RpcClientOptions): DaemonRpcClient {
  const {
    fetchEndpoint,
    createWebSocket = createNativeWebSocket,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
    backoffCapMs = DEFAULT_BACKOFF_CAP_MS,
    onSnapshot,
    onEvent,
  } = options;

  // 固有的可变运行时状态（supervisor 同款做法：最小局部可变量 + 不可变快照外发）
  let running = false;
  let generation = 0; // 递增代次：旧尝试的迟到事件一律判失效
  let attempt = 0;
  let consecutiveFailures = 0;
  let phase: "idle" | "opening" | "handshake" | "established" = "idle";
  let socket: WebSocketLike | null = null;
  let openTimer: Timer = null;
  let welcomeTimer: Timer = null;
  let retryTimer: Timer = null;
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  let snapshot: RpcClientSnapshot = {
    state: "connecting",
    attempt: 0,
    daemonVersion: null,
    protocolVersion: null,
    lastError: null,
    eventsSubscribed: false,
  };

  function emit(patch: Partial<RpcClientSnapshot>): void {
    snapshot = { ...snapshot, ...patch };
    onSnapshot?.(snapshot);
  }

  /** 断开当前 socket 并拒绝全部在途请求（不改动调度；调用方需先递增 generation） */
  function teardownSocket(errorMessage: string): void {
    if (openTimer !== null) {
      clearTimeout(openTimer);
      openTimer = null;
    }
    if (welcomeTimer !== null) {
      clearTimeout(welcomeTimer);
      welcomeTimer = null;
    }
    const active = socket;
    socket = null;
    phase = "idle";
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new RpcClientError(errorMessage));
    }
    pending.clear();
    if (active !== null) active.close();
  }

  /** 一次尝试失败（endpoint 未就绪 / 握手失败 / 连接中断）→ 记录并按退避调度下一次 */
  function failAttempt(errorMessage: string, nextState: RpcConnectionState): void {
    generation += 1; // 当前尝试的迟到事件全部失效
    consecutiveFailures += 1;
    teardownSocket(`daemon 连接已断开：${errorMessage}`);
    emit({ state: nextState, lastError: errorMessage });
    if (!running) return;
    const delayMs = reconnectDelayMs(consecutiveFailures, backoffBaseMs, backoffCapMs);
    retryTimer = setTimeout(() => {
      void runAttempt();
    }, delayMs);
  }

  /** welcome 帧校验（contracts strict schema）+ 协议版本一致性；失败即断开重试 */
  function handleWelcomeFrame(data: unknown): void {
    let parsedFrame: unknown;
    try {
      parsedFrame = JSON.parse(typeof data === "string" ? data : "") as unknown;
    } catch {
      failAttempt("welcome 帧不是合法 JSON", "disconnected");
      return;
    }
    const welcome = ServerWelcomeSchema.safeParse(parsedFrame);
    if (!welcome.success) {
      failAttempt(`welcome 帧校验失败：${JSON.stringify(welcome.error.issues)}`, "disconnected");
      return;
    }
    const { protocolVersion, daemonVersion } = welcome.data;
    if (protocolVersion !== PROTOCOL_VERSION) {
      failAttempt(
        `协议版本失配：client=${PROTOCOL_VERSION} daemon=${protocolVersion}（daemon 版本 ${daemonVersion}）`,
        "disconnected",
      );
      return;
    }
    if (welcomeTimer !== null) {
      clearTimeout(welcomeTimer);
      welcomeTimer = null;
    }
    phase = "established";
    consecutiveFailures = 0;
    emit({ state: "connected", daemonVersion, lastError: null });
    bootstrapAfterConnected();
  }

  /** 连接建立后的引导请求：system.version（版本徽标）+ subscribe（事件通道） */
  function bootstrapAfterConnected(): void {
    void internalRequest("system.version")
      .then((result) => {
        const version = parseSystemVersion(result);
        if (version !== null) {
          emit({ daemonVersion: version.daemonVersion, protocolVersion: version.protocolVersion });
        }
      })
      .catch(() => undefined); // 失败保留 welcome 携带的版本，不影响连接
    void internalRequest("subscribe", { topics: Object.values(STATIC_TOPIC) })
      .then(() => {
        emit({ eventsSubscribed: true });
      })
      .catch(() => {
        emit({ eventsSubscribed: false }); // daemon 未实现 subscribe：通道未开放，连接照常
      });
  }

  /** 入站帧路由：JSON-RPC 响应按 id 关联；事件通知（method:"event"）分发；其余忽略 */
  function routeFrame(data: unknown): void {
    let parsedFrame: unknown;
    try {
      parsedFrame = JSON.parse(typeof data === "string" ? data : "") as unknown;
    } catch {
      return; // 非 JSON 帧：忽略，不破坏连接
    }
    const response = JsonRpcResponseSchema.safeParse(parsedFrame);
    if (response.success) {
      const { id } = response.data;
      if (typeof id !== "number") return; // 本客户端 id 恒为自增数字
      const entry = pending.get(id);
      if (entry === undefined) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      if ("error" in response.data) {
        entry.reject(rpcErrorFromResponse(entry.method, response.data.error));
        return;
      }
      entry.resolve(response.data.result);
      return;
    }
    // daemon 事件推送 wire 格式（event-bus.ts 定案）：JSON-RPC notification
    // {jsonrpc:"2.0", method:"event", params:EventEnvelope}——对 params 做 strict
    // 校验后分发；非法 params 忽略该帧，不破坏连接（spec-review major 修复：
    // 原实现对整帧 safeParse，notification 的 jsonrpc/method 键必然被 strict
    // envelope schema 拒绝，事件通道实为死路径）
    if (
      typeof parsedFrame === "object" &&
      parsedFrame !== null &&
      (parsedFrame as { method?: unknown }).method === "event" &&
      "params" in (parsedFrame as object)
    ) {
      const envelope = EventEnvelopeSchema.safeParse((parsedFrame as { params: unknown }).params);
      if (envelope.success) {
        // payload 经 schema 校验必在（运行时 strict），类型上 z.unknown 推断为可选键，收窄需经双重断言
        onEvent?.(envelope.data as unknown as EventEnvelope);
      }
    }
  }

  function internalRequest<T>(method: string, params?: JsonRpcParams): Promise<T> {
    if (phase !== "established" || socket === null) {
      return Promise.reject(
        new RpcClientError(`RPC 请求 ${method} 失败：未连接（state=${snapshot.state}）`),
      );
    }
    const activeSocket = socket;
    const id = nextId;
    nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new RpcClientError(`RPC 请求 ${method} 超时 ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);
      pending.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
        timer,
        method,
      });
      activeSocket.send(
        JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }),
      );
    });
  }

  /** 单次（重）连尝试：取 endpoint → 开 WS → hello/welcome → established */
  async function runAttempt(): Promise<void> {
    if (!running) return;
    retryTimer = null;
    generation += 1;
    const gen = generation;
    attempt += 1;
    emit({ state: "connecting", attempt });

    // ① 每次尝试重新取 endpoint：supervisor 重启 daemon 后 port/token 均换新
    let fetched: DaemonEndpoint | null = null;
    try {
      fetched = await fetchEndpoint();
    } catch {
      fetched = null; // preload 通道异常按未就绪处理
    }
    if (!running || gen !== generation) return;
    if (fetched === null) {
      // daemon 尚未 ready：从未建立过连接，保持 connecting（非 disconnected）
      failAttempt(
        `daemon endpoint 未就绪（主进程 daemon 尚未 ready，attempt=${attempt}）`,
        "connecting",
      );
      return;
    }
    const endpoint = fetched;

    // ② 打开 WS 并绑定四类事件（事件内的迟到帧由 gen 判失效）
    const url = `ws://127.0.0.1:${endpoint.port}`;
    let ws: WebSocketLike;
    try {
      ws = createWebSocket(url);
    } catch (error) {
      failAttempt(`创建 WebSocket 失败（${url}）：${messageOf(error)}`, "disconnected");
      return;
    }
    if (!running || gen !== generation) return;
    socket = ws;
    phase = "opening";
    openTimer = setTimeout(() => {
      if (gen !== generation) return;
      failAttempt(`连接 ${url} 超时 ${connectTimeoutMs}ms（未完成打开）`, "disconnected");
    }, connectTimeoutMs);

    ws.on("open", () => {
      if (gen !== generation) return;
      phase = "handshake";
      if (openTimer !== null) {
        clearTimeout(openTimer);
        openTimer = null;
      }
      ws.send(
        JSON.stringify({ type: "hello", token: endpoint.token, protocolVersion: PROTOCOL_VERSION }),
      );
      welcomeTimer = setTimeout(() => {
        if (gen !== generation) return;
        failAttempt(`握手超时 ${connectTimeoutMs}ms（未收到 welcome）`, "disconnected");
      }, connectTimeoutMs);
    });

    ws.on("message", (event: WsEvent) => {
      if (gen !== generation || event.type !== "message") return;
      if (phase === "handshake") {
        handleWelcomeFrame(event.data);
        return;
      }
      if (phase === "established") {
        routeFrame(event.data);
      }
    });

    ws.on("close", (event: WsEvent) => {
      if (gen !== generation || event.type !== "close") return;
      if (phase === "established") {
        failAttempt(describeCloseCode(event.code, event.reason), "disconnected");
        return;
      }
      failAttempt(`握手失败：${describeCloseCode(event.code, event.reason)}`, "disconnected");
    });

    ws.on("error", () => {
      // 浏览器 WS 语义：error 后必跟 close，统一由 close 分支处理，避免同次失败双计
    });
  }

  function start(): void {
    if (running) return;
    running = true;
    void runAttempt();
  }

  function stop(): void {
    running = false;
    generation += 1;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    teardownSocket("RPC 客户端已停止，连接关闭");
  }

  return {
    start,
    stop,
    request: <T>(method: string, params?: JsonRpcParams) => internalRequest<T>(method, params),
    getSnapshot: () => snapshot,
  };
}
