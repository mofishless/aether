// 服务器集成测试（进程内）：真实 ws server + ws client，覆盖握手状态机与 RPC 全链路。
// 跨进程 spawn 协议见 spawn.protocol.test.ts；心跳超时/自动重启等跨进程场景归阶段 2。
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, ServerWelcomeSchema } from "@aether/contracts";
import { startDaemonServer, type DaemonServer } from "../src/server.js";
import {
  closeQuietly,
  connect,
  helloFrame,
  nextClose,
  nextMessage,
  rpcRequest,
  TEST_TOKEN,
} from "./helpers.js";
import type { WebSocket } from "ws";

let server: DaemonServer | undefined;
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) closeQuietly(client);
  await server?.shutdown();
  server = undefined;
});

async function startServer(
  options: { helloTimeoutMs?: number; onShutdownRequested?: () => void } = {},
) {
  const { helloTimeoutMs = 4000, onShutdownRequested } = options;
  server = await startDaemonServer({
    token: TEST_TOKEN,
    helloTimeoutMs,
    // exactOptionalPropertyTypes：仅在提供时传，不显式写 undefined
    ...(onShutdownRequested !== undefined ? { onShutdownRequested } : {}),
  });
  return server;
}

async function connectAndHandshake(): Promise<WebSocket> {
  const activeServer = await startServer();
  const ws = await connect(activeServer.port);
  clients.push(ws);
  ws.send(helloFrame(TEST_TOKEN, PROTOCOL_VERSION));
  const welcomeRaw = await nextMessage(ws);
  expect(ServerWelcomeSchema.parse(JSON.parse(welcomeRaw))).toEqual({
    type: "welcome",
    protocolVersion: PROTOCOL_VERSION,
    daemonVersion: "0.0.1",
  });
  return ws;
}

describe("握手", () => {
  it("合法 hello → ServerWelcome（protocolVersion/daemonVersion）", async () => {
    await connectAndHandshake();
  });

  it("token 不符 → close 4001", async () => {
    const activeServer = await startServer();
    const ws = await connect(activeServer.port);
    clients.push(ws);
    ws.send(helloFrame("wrong-token"));
    expect(await nextClose(ws)).toMatchObject({ code: 4001 });
  });

  it("protocolVersion 失配 → close 4002", async () => {
    const activeServer = await startServer();
    const ws = await connect(activeServer.port);
    clients.push(ws);
    ws.send(helloFrame(TEST_TOKEN, 2));
    expect(await nextClose(ws)).toMatchObject({ code: 4002 });
  });

  it("malformed hello → close 4000", async () => {
    const activeServer = await startServer();
    const ws = await connect(activeServer.port);
    clients.push(ws);
    ws.send("{{{not-json");
    expect(await nextClose(ws)).toMatchObject({ code: 4000 });
  });

  it("hello 前发 RPC 帧 → close 4004", async () => {
    const activeServer = await startServer();
    const ws = await connect(activeServer.port);
    clients.push(ws);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system.health" }));
    expect(await nextClose(ws)).toMatchObject({ code: 4004 });
  });

  it("超时未 hello（注入 80ms）→ close 4003", async () => {
    const activeServer = await startServer({ helloTimeoutMs: 80 });
    const ws = await connect(activeServer.port);
    clients.push(ws);
    expect(await nextClose(ws, 3000)).toMatchObject({ code: 4003 });
  });
});

describe("握手后 RPC", () => {
  it("system.health → {ok:true}", async () => {
    const ws = await connectAndHandshake();
    const response = (await rpcRequest(ws, 1, "system.health")) as { result?: unknown };
    expect(response.result).toEqual({ ok: true });
  });

  it("system.version → {daemonVersion, protocolVersion}", async () => {
    const ws = await connectAndHandshake();
    const response = (await rpcRequest(ws, 2, "system.version")) as { result?: unknown };
    expect(response.result).toEqual({ daemonVersion: "0.0.1", protocolVersion: PROTOCOL_VERSION });
  });

  it("未知方法 → -32601", async () => {
    const ws = await connectAndHandshake();
    const response = (await rpcRequest(ws, 3, "no.such.method")) as { error?: { code: number } };
    expect(response.error?.code).toBe(-32601);
  });

  it("notification → 无响应（后续请求仍正常）", async () => {
    const ws = await connectAndHandshake();
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "system.health" }));
    const response = (await rpcRequest(ws, 4, "system.version")) as { result?: unknown };
    expect(response.result).toEqual({ daemonVersion: "0.0.1", protocolVersion: PROTOCOL_VERSION });
  });

  it("握手后重复发 hello → INVALID_REQUEST -32600（不再是握手帧）", async () => {
    const ws = await connectAndHandshake();
    ws.send(helloFrame(TEST_TOKEN, PROTOCOL_VERSION));
    const response = (await rpcRequest(ws, 5, "system.health")) as { result?: unknown };
    expect(response.result).toEqual({ ok: true });
  });
});

describe("system.shutdown", () => {
  it("回 Success 帧后关闭连接（1001）并触发 onShutdownRequested", async () => {
    let shutdownRequests = 0;
    const ws = await connectAndHandshake2(() => {
      shutdownRequests += 1;
      void server?.shutdown();
    });
    const response = (await rpcRequest(ws, 9, "system.shutdown")) as { result?: unknown };
    expect(response.result).toBeNull();
    expect(await nextClose(ws)).toMatchObject({ code: 1001 });
    expect(shutdownRequests).toBe(1);
  });
});

/** 带自定义 shutdown 回调的握手（复用 startServer） */
async function connectAndHandshake2(onShutdownRequested: () => void): Promise<WebSocket> {
  const activeServer = await startServer({ onShutdownRequested });
  const ws = await connect(activeServer.port);
  clients.push(ws);
  ws.send(helloFrame(TEST_TOKEN, PROTOCOL_VERSION));
  await nextMessage(ws);
  return ws;
}
