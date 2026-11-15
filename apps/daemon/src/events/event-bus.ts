// 事件广播通道（SYSTEM_DESIGN §5.4 最小落地，P0-10）：
// daemon 全局单调 seq + 载荷/整体 envelope 双重 zod 出站校验 + JSON-RPC
// notification 帧（method="event"，params=EventEnvelope）同步扇出。
// P0-10 定案（最小补）：hello 通过的连接全量广播——per-topic 过滤、cursor
// 断线重放（有界内存缓冲，水位 TBD-9）与快照恢复留待 P0-11 随驾驶舱 UI 细化。
import { nowIso } from "@aether/core";
import { EventEnvelopeSchema, type EventEnvelope } from "@aether/contracts";
import type { ZodType } from "zod";

/** 出站帧消费者（server 层注入：连接 OPEN 时 ws.send） */
export type EventFrameListener = (frame: string) => void;

/** 事件通道异常（注入回调消费；不静默丢、也不打断发布方） */
export type EventBusError =
  | { readonly kind: "payload_invalid"; readonly topic: string; readonly cause: unknown }
  | { readonly kind: "envelope_invalid"; readonly topic: string; readonly cause: unknown }
  | { readonly kind: "listener_failed"; readonly topic: string; readonly cause: unknown };

export interface EventBusOptions {
  /** 异常上报（默认静默——事件流绝不反向打断发布方；daemon 装配时注入 stderr 中文日志） */
  readonly onError?: (error: EventBusError) => void;
  /** 时钟注入缝（测试确定性）；默认 core nowIso（UTC ISO-8601） */
  readonly now?: () => string;
}

export interface EventBus {
  /** 当前全局水位（已发布条数；subscribe 应答 cursor 用） */
  readonly currentSeq: number;
  /** 发布：payload 过 schema 且 envelope 过 EventEnvelopeSchema 后扇出；校验失败不扇出、不占 seq */
  publish(topic: string, payload: unknown, schema: ZodType): void;
  /** 注册出站帧消费者；返回退订函数 */
  addListener(listener: EventFrameListener): () => void;
}

export function createEventBus(options: EventBusOptions = {}): EventBus {
  const onError = options.onError ?? (() => undefined);
  const now = options.now ?? nowIso;
  const listeners = new Set<EventFrameListener>();
  let seq = 0;

  return {
    get currentSeq() {
      return seq;
    },
    publish(topic: string, payload: unknown, schema: ZodType): void {
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        onError({ kind: "payload_invalid", topic, cause: parsed.error });
        return;
      }
      seq += 1;
      const envelope: EventEnvelope = {
        topic,
        seq,
        emittedAt: now(),
        payload: parsed.data,
      };
      const envelopeParsed = EventEnvelopeSchema.safeParse(envelope);
      if (!envelopeParsed.success) {
        // 出站 envelope 非法 = 发布方 bug（topic/emittedAt 形状错）：回滚 seq，保持水位无洞
        seq -= 1;
        onError({ kind: "envelope_invalid", topic, cause: envelopeParsed.error });
        return;
      }
      const frame = JSON.stringify({
        jsonrpc: "2.0",
        method: "event",
        params: envelope,
      });
      for (const listener of listeners) {
        try {
          listener(frame);
        } catch (cause) {
          onError({ kind: "listener_failed", topic, cause });
        }
      }
    },
    addListener(listener: EventFrameListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
