// terminals 全链集成（WS 层，真 TerminalPool + 内存库 + 装配根）：
// 启动 → hello → health → subscribe → terminals.create → write（默认 shell 回显探针）
// → 输出事件推送 → resize → kill → 退出事件推送。平台注意：
// - 输出断言用回显标记（PowerShell/bash 输入回显都有），不解析平台差异字节；
// - exitCode 不判值（Windows ConPTY 强杀与 POSIX SIGHUP 均归一 null，语义不同不硬断）。
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  EventEnvelopeSchema,
  JsonRpcNotificationSchema,
  PROTOCOL_VERSION,
  ServerWelcomeSchema,
  TerminalExitFrameSchema,
  TerminalOutputFrameSchema,
} from "@aether/contracts";
import { startDaemonServer, type DaemonServer } from "../src/server.js";
import { createDaemonAssembly, type DaemonAssembly } from "../src/assembly/assembly.js";
import {
  closeQuietly,
  connect,
  helloFrame,
  nextMessage,
  rpcRequest,
  TEST_TOKEN,
} from "./helpers.js";
import type { WebSocket } from "ws";

interface EventFrame {
  readonly topic: string;
  readonly payload: unknown;
  readonly seq: number;
}

let server: DaemonServer | undefined;
let assembly: DaemonAssembly | undefined;
let client: WebSocket | undefined;
const eventFrames: EventFrame[] = [];

afterEach(async () => {
  if (client !== undefined) {
    closeQuietly(client);
    client = undefined;
  }
  await server?.shutdown();
  server = undefined;
  await assembly?.close();
  assembly = undefined;
  eventFrames.length = 0;
});

/** 收集连接上的事件推送帧（method=event 的 notification） */
function collectEventFrames(ws: WebSocket): void {
  ws.on("message", (data: WebSocket.RawData) => {
    const parsed = JSON.parse(data.toString()) as { method?: unknown; params?: unknown };
    if (parsed.method !== "event") {
      return;
    }
    const envelope = EventEnvelopeSchema.parse(parsed.params);
    eventFrames.push({ topic: envelope.topic, payload: envelope.payload, seq: envelope.seq });
  });
}

/** 轮询等待条件满足（真 shell 启动有平台/CI 波动，轮询比单帧等待稳） */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor 超时 ${timeoutMs}ms（已收到 ${eventFrames.length} 帧）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function startAssembledDaemon(): Promise<WebSocket> {
  assembly = createDaemonAssembly({ dbPath: ":memory:" });
  server = await startDaemonServer({ token: TEST_TOKEN, helloTimeoutMs: 4000, assembly });
  const ws = await connect(server.port);
  client = ws;
  ws.send(helloFrame(TEST_TOKEN, PROTOCOL_VERSION));
  const welcomeRaw = await nextMessage(ws);
  ServerWelcomeSchema.parse(JSON.parse(welcomeRaw));
  collectEventFrames(ws);
  return ws;
}

describe("装配 daemon：terminals 全链（WS + 真 PTY + 内存库）", () => {
  it("hello → health → create → write → 输出事件 → resize → kill → 退出事件", async () => {
    const ws = await startAssembledDaemon();

    // 装配冒烟：health 查询
    const health = (await rpcRequest(ws, 1, "system.health")) as { result?: unknown };
    expect(health.result).toEqual({ ok: true });

    // subscribe：应答当前水位（P0-10 定案：从现在开始推送）
    const subscribe = (await rpcRequest(ws, 2, "subscribe", {
      topics: ["terminal.*"],
    })) as { result?: { cursor?: number } };
    expect(typeof subscribe.result?.cursor).toBe("number");

    // 创建终端（默认 shell：win32=PowerShell / POSIX=bash 族）
    const created = (await rpcRequest(ws, 3, "terminals.create", {
      projectId: "p-integration",
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
    })) as { result?: { terminalId?: string; pid?: number } };
    const terminalId = created.result?.terminalId;
    expect(typeof terminalId).toBe("string");
    expect(typeof created.result?.pid).toBe("number");

    // 写入探针命令（\r = 双平台回车；回显+命令输出都包含标记）
    const probe = "aether-ws-probe-7f3d";
    const writeResult = (await rpcRequest(ws, 4, "terminals.write", {
      terminalId,
      data: Buffer.from(`echo ${probe}\r`, "utf8").toString("base64"),
    })) as { result?: unknown };
    expect(writeResult.result).toBeNull();

    // PTY 输出按块到达（探针串可能跨帧拆分）：拼全部输出帧再判断
    const joinedOutput = (): string =>
      eventFrames
        .filter((frame) => frame.topic === `terminal.${terminalId}.output`)
        .map((frame) => TerminalOutputFrameSchema.parse(frame.payload))
        .map((frame) => Buffer.from(frame.data, "base64").toString("utf8"))
        .join("");
    await waitFor(() => joinedOutput().includes(probe), 20_000);

    // resize → Success null
    const resize = (await rpcRequest(ws, 5, "terminals.resize", {
      terminalId,
      cols: 120,
      rows: 40,
    })) as { result?: unknown };
    expect(resize.result).toBeNull();

    // kill → Success null（幂等语义），退出经 terminal.<id>.exit 事件推送
    const kill = (await rpcRequest(ws, 6, "terminals.kill", { terminalId })) as {
      result?: unknown;
    };
    expect(kill.result).toBeNull();

    await waitFor(
      () =>
        eventFrames.some((frame) => {
          if (frame.topic !== `terminal.${terminalId}.exit`) {
            return false;
          }
          return TerminalExitFrameSchema.safeParse(frame.payload).success;
        }),
      20_000,
    );
    const exitFrame = TerminalExitFrameSchema.parse(
      eventFrames.find((frame) => frame.topic === `terminal.${terminalId}.exit`)?.payload,
    );
    expect(exitFrame.terminalId).toBe(terminalId);
    // exitCode 平台差异（强杀信号语义）：只断言字段存在与 terminalId，不断言值

    // kill 后句柄失效：write → INVALID_PARAMS（未知终端 fail-closed）
    const staleWrite = (await rpcRequest(ws, 7, "terminals.write", {
      terminalId,
      data: Buffer.from("x", "utf8").toString("base64"),
    })) as { error?: { code?: number } };
    expect(staleWrite.error?.code).toBe(-32602);

    // 事件帧序 seq 全局单调（EventEnvelope 已 zod 校验）
    const seqs = eventFrames.map((frame) => frame.seq);
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(seqs).toEqual(sorted);
    expect(new Set(seqs).size).toBe(seqs.length);
  }, 40_000);

  it("推送帧是合法 JSON-RPC notification（method=event）", async () => {
    const ws = await startAssembledDaemon();
    const rawNotifications: string[] = [];
    ws.on("message", (data: WebSocket.RawData) => rawNotifications.push(data.toString()));

    const created = (await rpcRequest(ws, 1, "terminals.create", {
      projectId: "p-frame",
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
    })) as { result?: { terminalId?: string } };
    const terminalId = created.result?.terminalId;
    await rpcRequest(ws, 2, "terminals.kill", { terminalId });
    await waitFor(
      () => eventFrames.some((frame) => frame.topic === `terminal.${terminalId}.exit`),
      20_000,
    );

    // 收到的全部帧里：响应帧带 id、事件帧为 notification——事件帧逐一过 strict schema
    const notificationFrames = rawNotifications
      .map((raw) => JSON.parse(raw) as { method?: unknown })
      .filter((parsed) => parsed.method === "event");
    expect(notificationFrames.length).toBeGreaterThan(0);
    for (const frame of rawNotifications) {
      const parsed = JSON.parse(frame) as Record<string, unknown>;
      if (parsed["method"] === "event") {
        expect(() => JsonRpcNotificationSchema.parse(parsed)).not.toThrow();
      }
    }
  }, 40_000);
});
