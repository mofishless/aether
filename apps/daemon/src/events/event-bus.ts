// 事件广播通道（SYSTEM_DESIGN §5.4，P0-10 落地 + P0-11 有界重放）：
// daemon 全局单调 seq + 载荷/整体 envelope 双重 zod 出站校验 + JSON-RPC
// notification 帧（method="event"，params=EventEnvelope）同步扇出。
// P0-10 定案：hello 通过的连接全量广播——per-topic 过滤（订阅语法细化留后续）。
// P0-11 补：有界内存环形缓冲（容量 2000，纯内存态不落库，daemon 内存态水位
// TBD-9 定案为该缓冲），subscribe 带 cursor 时按 topic 精确匹配重放 seq>cursor 帧。
import { nowIso } from "@aether/core";
import { EventEnvelopeSchema, type EventEnvelope } from "@aether/contracts";
import type { ZodType } from "zod";

/** 重放缓冲默认容量（环形淘汰最旧；§5.4 有界内存缓冲，TBD-9 定案值） */
export const DEFAULT_REPLAY_CAPACITY = 2000;

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
  /** 重放缓冲容量（环形淘汰最旧）；默认 2000 */
  readonly replayCapacity?: number;
}

/** 重放缓冲条目：已出站帧 + 定位信息（topic 精确匹配 + seq 过滤） */
interface RetainedEntry {
  readonly topic: string;
  readonly seq: number;
  readonly frame: string;
}

export interface EventBus {
  /** 当前全局水位（已发布条数；subscribe 应答 cursor 用） */
  readonly currentSeq: number;
  /** 缓冲内最旧条目的 seq（缓冲空 = 0）：cursor 早于此值时重放只能给出保留段 */
  readonly earliestRetainedSeq: number;
  /** 发布：payload 过 schema 且 envelope 过 EventEnvelopeSchema 后扇出；校验失败不扇出、不占 seq */
  publish(topic: string, payload: unknown, schema: ZodType): void;
  /** cursor 重放：缓冲内 seq > cursor 且 topic 精确匹配的帧按 seq 升序返回（P0 无通配语法） */
  replay(topics: readonly string[], cursor: number): readonly string[];
  /** 注册出站帧消费者；返回退订函数 */
  addListener(listener: EventFrameListener): () => void;
}

export function createEventBus(options: EventBusOptions = {}): EventBus {
  const onError = options.onError ?? (() => undefined);
  const now = options.now ?? nowIso;
  const replayCapacity = options.replayCapacity ?? DEFAULT_REPLAY_CAPACITY;
  const listeners = new Set<EventFrameListener>();
  const retained: RetainedEntry[] = [];
  let seq = 0;

  return {
    get currentSeq() {
      return seq;
    },
    get earliestRetainedSeq() {
      return retained.length === 0 ? 0 : (retained[0]?.seq ?? 0);
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
      retained.push({ topic, seq, frame });
      if (retained.length > replayCapacity) {
        // 环形淘汰最旧（容量级数组搬移可忽略；发布频率非热路径）
        retained.splice(0, retained.length - replayCapacity);
      }
      for (const listener of listeners) {
        try {
          listener(frame);
        } catch (cause) {
          onError({ kind: "listener_failed", topic, cause });
        }
      }
    },
    replay(topics: readonly string[], cursor: number): readonly string[] {
      const wanted = new Set(topics);
      return retained
        .filter((entry) => entry.seq > cursor && wanted.has(entry.topic))
        .map((entry) => entry.frame);
    },
    addListener(listener: EventFrameListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
