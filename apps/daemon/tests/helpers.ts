// 测试共享工具：ws 客户端连接/收帧/关闭码断言与最小 RPC 客户端。
import { WebSocket } from "ws";

/** 与被测 daemon 约定的一次性 token（仅测试） */
export const TEST_TOKEN = "test-one-time-token";

export function connect(port: number, timeoutMs = 3000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`connect 超时 ${timeoutMs}ms`));
    }, timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function nextMessage(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`nextMessage 超时 ${timeoutMs}ms`)), timeoutMs);
    ws.once("message", (data: WebSocket.RawData) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
  });
}

export function nextClose(
  ws: WebSocket,
  timeoutMs = 3000,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`nextClose 超时 ${timeoutMs}ms`)), timeoutMs);
    ws.once("close", (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
    ws.once("error", () => {
      clearTimeout(timer);
      reject(new Error("连接 error 而非 close"));
    });
  });
}

/** 发送 JSON-RPC 请求并等待同 id 响应帧（忽略途中其他 id 的帧） */
export function rpcRequest(
  ws: WebSocket,
  id: number | string,
  method: string,
  params?: unknown,
  timeoutMs = 3000,
): Promise<unknown> {
  const frame = {
    jsonrpc: "2.0",
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  };
  ws.send(JSON.stringify(frame));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`rpcRequest(${method}) 超时 ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (data: WebSocket.RawData) => {
      const parsed = JSON.parse(data.toString()) as { id?: unknown };
      if (parsed.id !== id) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(parsed);
    };
    ws.on("message", onMessage);
  });
}

/** 构造 hello 握手帧文本 */
export function helloFrame(token: string, protocolVersion = 1): string {
  return JSON.stringify({ type: "hello", token, protocolVersion });
}

/** 测试收尾：静默关闭客户端，不抛错 */
export function closeQuietly(ws: WebSocket): void {
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close(1000);
  }
}
