// ===== Codex app-server LDJSON 帧路由（纯函数，协议定案 §1/§8/§9-3）=====
// wire 事实：stdio 上每行一个 JSON 对象，非标准 JSON-RPC——没有 jsonrpc: "2.0" 键，
// 四种形状靠键判别（§9-3）：
//   请求       {id, method, params}      id 字符串/整数皆可（服务端审批请求）
//   通知       {method, params, emittedAtMs}   无 id
//   成功响应   {id, result}
//   错误响应   {id, error: {code, message, data?}}
// 兼容策略（§8）：方法白名单 + 未知方法容忍——未知 method 静默忽略并计数（不崩、
// 不丢整流）；未知服务端请求由调用方兜底应答（防服务端悬挂），本模块只计数上报。
// 本文件零副作用、零 IO：读行缓冲在 client.ts，方法语义在 normalize/adapter。

/** JSON-RPC 风格错误对象（错误响应分支与 RpcError 共用形状） */
export interface RpcErrorShape {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** 服务端→客户端请求帧（审批等；id 空间与客户端请求独立，§9-4） */
export interface ServerRequestFrame {
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

/** 服务端通知帧（无 id；本机实测带 emittedAtMs） */
export interface ServerNotificationFrame {
  readonly method: string;
  readonly params?: unknown;
  readonly emittedAtMs?: number;
}

/** 单行解析结果：frame / 空行 / 非法 JSON（计数用，不抛） */
export type ParsedFrameLine =
  | { readonly status: "frame"; readonly frame: Record<string, unknown> }
  | { readonly status: "empty" }
  | { readonly status: "invalid"; readonly error: string };

/**
 * 读行 → 剥行尾 \r（Windows CRLF 容错，§1）→ JSON.parse。
 * 空白行返回 empty；非法 JSON返回 invalid（携带错误消息）——调用方计数不崩。
 * 注意：本函数处理的是"已切好的行"；跨 chunk 的行缓冲归属 client.ts。
 */
export function parseFrameLine(line: string): ParsedFrameLine {
  const text = line.replace(/\r$/, "").trim();
  if (text.length === 0) {
    return { status: "empty" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { status: "invalid", error: "顶层不是 JSON 对象" };
    }
    return { status: "frame", frame: parsed as Record<string, unknown> };
  } catch (error) {
    return { status: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}

/** 四分支 + 未识别（形状路由结果；纯判别，无方法白名单语义） */
export type ClassifiedFrame =
  | { readonly kind: "request"; readonly frame: ServerRequestFrame }
  | { readonly kind: "notification"; readonly frame: ServerNotificationFrame }
  | { readonly kind: "response"; readonly id: string | number; readonly result: unknown }
  | { readonly kind: "errorResponse"; readonly id: string | number; readonly error: RpcErrorShape }
  | { readonly kind: "unknown"; readonly reason: string };

function isFrameId(value: unknown): value is string | number {
  return (typeof value === "string" && value.length > 0) || typeof value === "number";
}

/**
 * 单帧（已解析对象）→ 四分支判别。键优先级：method 存在且 id 存在 → 请求；
 * 仅 method → 通知；id + result → 成功响应；id + error → 错误响应；其余 → unknown
 * （计数容忍，不崩）。id 字符串/整数皆可（§10 帧形状定案）。
 */
export function classifyFrame(frame: unknown): ClassifiedFrame {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    return { kind: "unknown", reason: "帧不是对象" };
  }
  const record = frame as Record<string, unknown>;
  const method = record["method"];
  const id = record["id"];
  if (typeof method === "string" && method.length > 0) {
    if (isFrameId(id)) {
      return {
        kind: "request",
        frame: {
          id,
          method,
          ...(record["params"] !== undefined ? { params: record["params"] } : {}),
        },
      };
    }
    return {
      kind: "notification",
      frame: {
        method,
        ...(record["params"] !== undefined ? { params: record["params"] } : {}),
        ...(typeof record["emittedAtMs"] === "number"
          ? { emittedAtMs: record["emittedAtMs"] }
          : {}),
      },
    };
  }
  if (isFrameId(id) && "result" in record) {
    return { kind: "response", id, result: record["result"] };
  }
  if (isFrameId(id) && typeof record["error"] === "object" && record["error"] !== null) {
    const error = record["error"] as Record<string, unknown>;
    if (typeof error["code"] === "number" && typeof error["message"] === "string") {
      return {
        kind: "errorResponse",
        id,
        error: {
          code: error["code"],
          message: error["message"],
          ...(error["data"] !== undefined ? { data: error["data"] } : {}),
        },
      };
    }
  }
  return { kind: "unknown", reason: "既无 method 也无 (id,result/error) 判别键" };
}

/** 容忍计数器（§8 未知方法/坏行不崩不丢流的观测面） */
export interface FrameRouterCounters {
  /** 非法 JSON 行（含顶层非对象） */
  invalidLines: number;
  /** 形状不可判别的帧 */
  unknownShapes: number;
  /** 白名单外的通知方法（静默忽略） */
  unknownNotificationMethods: number;
  /** 白名单外的服务端请求方法（调用方兜底应答后计数） */
  unknownServerRequestMethods: number;
  /** 无 pending 关联的响应（超时后迟到等） */
  orphanResponses: number;
}

export function createFrameRouterCounters(): FrameRouterCounters {
  return {
    invalidLines: 0,
    unknownShapes: 0,
    unknownNotificationMethods: 0,
    unknownServerRequestMethods: 0,
    orphanResponses: 0,
  };
}

export interface FrameRouterHandlers {
  /** 已知方法的服务端请求（审批）；返回 false = 方法不在白名单 → 计数由路由器负责 */
  readonly onServerRequest: (frame: ServerRequestFrame) => void;
  /** 已知方法的通知 */
  readonly onNotification: (frame: ServerNotificationFrame) => void;
  /**
   * 成功/错误响应统一入口（按 id 关联 pending 归 client 处理）。
   * 返回 false = 该 id 无 pending 关联（迟到/不认识）→ 路由器计入 orphanResponses。
   */
  readonly onResponse: (
    id: string | number,
    payload: { result: unknown } | { error: RpcErrorShape },
  ) => boolean;
  /** 未知服务端请求的兜底处理（client 会以 -32601 应答防悬挂）；缺省仅靠计数 */
  readonly onUnknownServerRequest?: (frame: ServerRequestFrame) => void;
}

export interface FrameRouterOptions extends FrameRouterHandlers {
  /** 服务端请求方法白名单（undefined = 全放行）；v2 三个审批 + v1 两个 DEPRECATED */
  readonly serverRequestMethods?: ReadonlySet<string>;
  /** 通知方法白名单（undefined = 全放行） */
  readonly notificationMethods?: ReadonlySet<string>;
}

export interface FrameRouter {
  /** 喂入一行（client 的行缓冲产出）；内部完成解析→判别→分发→计数 */
  feedLine(line: string): void;
  /** 喂入已解析帧（normalizeLogs 重放路径复用分发语义） */
  feedFrame(frame: unknown): void;
  /** 只读计数快照（不可变拷贝） */
  counters(): FrameRouterCounters;
}

/**
 * 组装路由器：parseFrameLine → classifyFrame → 白名单分发 → 计数。
 * 未知通知静默忽略（88 个 ServerNotification 演进面，§8）；未知服务端请求经
 * onUnknownServerRequest 兜底（防服务端等应答悬挂），两者都只计数不抛。
 */
export function createFrameRouter(options: FrameRouterOptions): FrameRouter {
  const counters = createFrameRouterCounters();
  const serverRequestMethods = options.serverRequestMethods;
  const notificationMethods = options.notificationMethods;

  const dispatchFrame = (frame: unknown): void => {
    const classified = classifyFrame(frame);
    switch (classified.kind) {
      case "request": {
        const { frame: request } = classified;
        if (serverRequestMethods === undefined || serverRequestMethods.has(request.method)) {
          options.onServerRequest(request);
        } else {
          counters.unknownServerRequestMethods += 1;
          options.onUnknownServerRequest?.(request);
        }
        return;
      }
      case "notification": {
        const { frame: notification } = classified;
        if (notificationMethods === undefined || notificationMethods.has(notification.method)) {
          options.onNotification(notification);
        } else {
          counters.unknownNotificationMethods += 1; // 静默忽略：通知无需应答
        }
        return;
      }
      case "response": {
        if (!options.onResponse(classified.id, { result: classified.result })) {
          counters.orphanResponses += 1;
        }
        return;
      }
      case "errorResponse": {
        if (!options.onResponse(classified.id, { error: classified.error })) {
          counters.orphanResponses += 1;
        }
        return;
      }
      default: {
        counters.unknownShapes += 1;
      }
    }
  };

  return {
    feedLine(line: string): void {
      const parsed = parseFrameLine(line);
      switch (parsed.status) {
        case "frame":
          dispatchFrame(parsed.frame);
          return;
        case "empty":
          return;
        default:
          counters.invalidLines += 1;
      }
    },
    feedFrame(frame: unknown): void {
      dispatchFrame(frame);
    },
    counters(): FrameRouterCounters {
      return { ...counters };
    },
  };
}
