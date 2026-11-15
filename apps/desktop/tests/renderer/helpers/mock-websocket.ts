import type { WebSocketLike, WsEvent } from "../../../src/renderer/src/rpc/transport.js";

type WsEventType = "open" | "close" | "message" | "error";
type Listener = (event: WsEvent) => void;

/** WebSocket 假实现（注入缝 createWebSocket 的测试替身）：记录出站帧，入站事件由测试手动驱动。 */
export class MockWebSocket implements WebSocketLike {
  readonly url: string;
  readonly sentFrames: string[] = [];
  /** 客户端已调用 close()（主动断开或握手失败中止） */
  closeRequested = false;

  private readonly listeners = new Map<WsEventType, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sentFrames.push(data);
  }

  close(): void {
    if (this.closeRequested) return;
    this.closeRequested = true;
    this.emit({ type: "close", code: 1000, reason: "mock closed" });
  }

  on(eventType: WsEventType, listener: Listener): void {
    const set = this.listeners.get(eventType) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(eventType, set);
  }

  // ---- 测试驱动面（扮演 daemon 侧）----

  /** 服务端接受 TCP/WS 连接 */
  serverOpen(): void {
    this.emit({ type: "open" });
  }

  /** 服务端发送 JSON 帧（自动序列化） */
  serverJson(frame: unknown): void {
    this.emit({ type: "message", data: JSON.stringify(frame) });
  }

  /** 服务端发送原始文本帧（非法 JSON / 非 envelope 场景） */
  serverRaw(text: string): void {
    this.emit({ type: "message", data: text });
  }

  /** 服务端主动关闭连接 */
  serverClose(code: number, reason: string): void {
    if (this.closeRequested) return;
    this.closeRequested = true;
    this.emit({ type: "close", code, reason });
  }

  /** 取第 index 条出站帧并解析（越界返回 null，便于断言定位） */
  sentJson<T = unknown>(index: number): T | null {
    const raw = this.sentFrames[index];
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }

  private emit(event: WsEvent): void {
    const set = this.listeners.get(event.type);
    if (set === undefined) return;
    for (const listener of set) {
      listener(event);
    }
  }
}
