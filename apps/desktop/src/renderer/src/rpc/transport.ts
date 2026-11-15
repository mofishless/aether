// 渲染侧 WS 传输缝（P0-10）：浏览器原生 WebSocket 与测试 MockWebSocket 的共同最小接口。
// 只抽象 RPC 客户端实际用到的能力（send/close/四类事件订阅），不复制 DOM 全类型面——
// 注入缝让协议层单测（tests/renderer）可以完全脱离真实网络与定时器环境。

/** 客户端关心的四类 WS 事件（close 携带 code/reason 供握手失败语义映射） */
export type WsEvent =
  | { readonly type: "open" }
  | { readonly type: "close"; readonly code: number; readonly reason: string }
  | { readonly type: "message"; readonly data: unknown }
  | { readonly type: "error" };

export type WsEventType = "open" | "close" | "message" | "error";

/** RPC 客户端依赖的 WS 最小面（createWebSocket 注入缝的契约） */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(eventType: WsEventType, listener: (event: WsEvent) => void): void;
}

/** 缺省工厂：包装浏览器原生 WebSocket 为 WebSocketLike（事件对象收窄为 WsEvent） */
export function createNativeWebSocket(url: string): WebSocketLike {
  const socket = new WebSocket(url);
  return {
    send: (data: string) => {
      socket.send(data);
    },
    close: (code?: number, reason?: string) => {
      if (code === undefined) {
        socket.close();
      } else {
        socket.close(code, reason ?? "");
      }
    },
    on: (eventType: WsEventType, listener: (event: WsEvent) => void) => {
      socket.addEventListener(eventType, (domEvent: Event) => {
        if (domEvent.type === "close") {
          const closeEvent = domEvent as CloseEvent;
          listener({ type: "close", code: closeEvent.code, reason: closeEvent.reason });
          return;
        }
        if (domEvent.type === "message") {
          listener({ type: "message", data: (domEvent as MessageEvent).data });
          return;
        }
        listener({ type: domEvent.type as "open" | "error" });
      });
    },
  };
}
