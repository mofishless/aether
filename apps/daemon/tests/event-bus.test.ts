// EventBus 单元测试（§5.4 事件广播通道最小落地）：
// seq 单调、帧形状（JSON-RPC notification method="event" + EventEnvelope zod 校验）、
// 出站双重校验 fail-closed（校验失败不扇出、不占 seq）、监听器增删。
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  EventEnvelopeSchema,
  JsonRpcNotificationSchema,
  terminalOutputTopic,
} from "@aether/contracts";
import { createEventBus, type EventBusError } from "../src/events/event-bus.js";

const FIXED_NOW = "2026-11-15T00:00:00.000Z";
const payloadSchema = z.object({ type: z.literal("output"), data: z.string() });

function parseNotification(frame: string) {
  return JsonRpcNotificationSchema.parse(JSON.parse(frame));
}

describe("createEventBus", () => {
  it("publish：seq 从 1 全局单调递增，帧 = notification(method=event) + 合法 EventEnvelope", () => {
    const bus = createEventBus({ now: () => FIXED_NOW });
    const frames: string[] = [];
    bus.addListener((frame) => frames.push(frame));

    bus.publish(terminalOutputTopic("t1"), { type: "output", data: "aGk=" }, payloadSchema);
    bus.publish(terminalOutputTopic("t1"), { type: "output", data: "" }, payloadSchema);

    expect(frames).toHaveLength(2);
    const first = parseNotification(frames[0] ?? "");
    expect(first.method).toBe("event");
    const firstEnvelope = EventEnvelopeSchema.parse(first.params);
    expect(firstEnvelope).toEqual({
      topic: "terminal.t1.output",
      seq: 1,
      emittedAt: FIXED_NOW,
      payload: { type: "output", data: "aGk=" },
    });
    const secondEnvelope = EventEnvelopeSchema.parse(parseNotification(frames[1] ?? "").params);
    expect(secondEnvelope.seq).toBe(2);
    expect(bus.currentSeq).toBe(2);
  });

  it("载荷校验失败：不扇出、不占 seq、onError 上报 payload_invalid", () => {
    const errors: EventBusError[] = [];
    const bus = createEventBus({ now: () => FIXED_NOW, onError: (error) => errors.push(error) });
    const frames: string[] = [];
    bus.addListener((frame) => frames.push(frame));

    bus.publish(terminalOutputTopic("t1"), { type: "not-output" }, payloadSchema);

    expect(frames).toHaveLength(0);
    expect(bus.currentSeq).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("payload_invalid");
    // 校验失败不占 seq：下一次合法发布仍从 1 起
    bus.publish(terminalOutputTopic("t1"), { type: "output", data: "" }, payloadSchema);
    expect(EventEnvelopeSchema.parse(parseNotification(frames[0] ?? "").params).seq).toBe(1);
  });

  it("envelope 校验失败（空 topic）：不扇出、seq 回滚、onError 上报 envelope_invalid", () => {
    const errors: EventBusError[] = [];
    const bus = createEventBus({ onError: (error) => errors.push(error) });
    const frames: string[] = [];
    bus.addListener((frame) => frames.push(frame));

    bus.publish("", { type: "output", data: "" }, payloadSchema);

    expect(frames).toHaveLength(0);
    expect(bus.currentSeq).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("envelope_invalid");
  });

  it("多监听器全量扇出；退订后不再收帧；监听器抛错被隔离（其余监听器不受影响）", () => {
    const bus = createEventBus({ now: () => FIXED_NOW });
    const receivedA: string[] = [];
    const receivedB: string[] = [];
    const errors: EventBusError[] = [];

    bus.addListener((frame) => receivedA.push(frame));
    const removeB = bus.addListener((frame) => receivedB.push(frame));
    bus.publish(terminalOutputTopic("t1"), { type: "output", data: "" }, payloadSchema);
    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(1);

    removeB();
    const throwingBus = createEventBus({ onError: (error) => errors.push(error) });
    throwingBus.addListener(() => {
      throw new Error("监听器故障");
    });
    const survivor: string[] = [];
    throwingBus.addListener((frame) => survivor.push(frame));
    throwingBus.publish(terminalOutputTopic("t2"), { type: "output", data: "" }, payloadSchema);
    expect(survivor).toHaveLength(1);
    expect(errors.map((error) => error.kind)).toEqual(["listener_failed"]);
  });
});
