import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDaemonRpcClient,
  RpcClientError,
  type DaemonEndpoint,
  type DaemonRpcClient,
  type RpcClientSnapshot,
} from "../../src/renderer/src/rpc/rpc-client.js";
import { MockWebSocket } from "./helpers/mock-websocket.js";

// P0-10 渲染侧 RPC 客户端协议层单测：注入 MockWebSocket + 假定时器，
// 覆盖 hello/welcome 握手、close code 中文映射、id 关联、请求超时、
// 错误码映射、EventEnvelope 分发与校验、断线退避重连、stop() 语义。

interface Harness {
  readonly client: DaemonRpcClient;
  readonly sockets: MockWebSocket[];
  readonly snapshots: RpcClientSnapshot[];
  readonly events: unknown[];
  /** 追加 endpoint 队列（每次（重）连尝试按序取用；耗尽后复用最后一个） */
  pushEndpoint(endpoint: DaemonEndpoint | null): void;
}

const DEFAULT_ENDPOINT: DaemonEndpoint = { port: 41000, token: "tok-1" };
const WELCOME = { type: "welcome", protocolVersion: 1, daemonVersion: "9.9.9" };

function createHarness(
  endpointQueue: readonly (DaemonEndpoint | null)[] = [DEFAULT_ENDPOINT],
): Harness {
  const sockets: MockWebSocket[] = [];
  const snapshots: RpcClientSnapshot[] = [];
  const events: unknown[] = [];
  const queue: (DaemonEndpoint | null)[] = [...endpointQueue];
  // 队列按序弹出；耗尽后复用最后取到的值（默认恒定 endpoint 场景）
  let lastEndpoint: DaemonEndpoint | null = null;

  const client = createDaemonRpcClient({
    fetchEndpoint: () => {
      const next = queue.shift();
      if (next !== undefined) lastEndpoint = next;
      return Promise.resolve(lastEndpoint);
    },
    createWebSocket: (url: string) => {
      const ws = new MockWebSocket(url);
      sockets.push(ws);
      return ws;
    },
    onSnapshot: (snapshot: RpcClientSnapshot) => {
      snapshots.push(snapshot);
    },
    onEvent: (envelope: unknown) => {
      events.push(envelope);
    },
  });

  return {
    client,
    sockets,
    snapshots,
    events,
    pushEndpoint: (endpoint: DaemonEndpoint | null) => {
      queue.push(endpoint);
    },
  };
}

function lastSnapshot(h: Harness): RpcClientSnapshot {
  const snapshot = h.snapshots.at(-1);
  if (snapshot === undefined) throw new Error("尚未产生任何快照");
  return snapshot;
}

/** 取第 index 个已创建 socket（noUncheckedIndexedAccess 收窄 + 用例缺失时给出可读错误） */
function socketAt(h: Harness, index: number): MockWebSocket {
  const ws = h.sockets[index];
  if (ws === undefined) throw new Error(`socket[${index}] 尚未创建`);
  return ws;
}

/** 推进微任务（不推进定时器）：让 fetchEndpoint/事件回调链跑完 */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** 驱动一次完整握手：open → hello → welcome → connected */
async function driveToConnected(h: Harness, socketIndex = 0): Promise<MockWebSocket> {
  const ws = socketAt(h, socketIndex);
  ws.serverOpen();
  await flush();
  ws.serverJson(WELCOME);
  await flush();
  const state = lastSnapshot(h).state;
  if (state !== "connected") throw new Error(`握手后未进入 connected（实际 ${state}）`);
  return ws;
}

/** 找到客户端发出的指定 method 的最后一条 JSON-RPC 请求帧（倒序：跳过引导请求的同名帧） */
function findRequestFrame(
  ws: MockWebSocket,
  method: string,
): { id: number; method: string } | null {
  for (const raw of [...ws.sentFrames].reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed === "object" && parsed !== null) {
      const frame = parsed as { id?: unknown; method?: unknown };
      if (
        frame.method === method &&
        (typeof frame.id === "number" || typeof frame.id === "string")
      ) {
        return { id: frame.id as number, method };
      }
    }
  }
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("握手与连接生命周期", () => {
  it("握手成功后进入 connected，welcome 携带 daemon 版本，引导 system.version 与 subscribe", async () => {
    const h = createHarness();
    h.client.start();
    await flush();

    const ws = socketAt(h, 0);
    expect(ws.url).toBe("ws://127.0.0.1:41000");
    ws.serverOpen();
    await flush();
    expect(ws.sentJson(0)).toEqual({ type: "hello", token: "tok-1", protocolVersion: 1 });

    ws.serverJson(WELCOME);
    await flush();
    expect(lastSnapshot(h)).toMatchObject({
      state: "connected",
      daemonVersion: "9.9.9",
    });

    // 引导请求 1：system.version（验证类型化 RPC 请求/响应通道）
    const versionFrame = findRequestFrame(ws, "system.version");
    expect(versionFrame).not.toBeNull();
    ws.serverJson({
      jsonrpc: "2.0",
      id: versionFrame?.id,
      result: { daemonVersion: "9.9.9", protocolVersion: 1 },
    });
    await flush();
    expect(lastSnapshot(h)).toMatchObject({ protocolVersion: 1 });

    // 引导请求 2：subscribe（当前 daemon 未实现 → 通道未开放标记，不崩溃不断连）
    const subscribeFrame = findRequestFrame(ws, "subscribe");
    expect(subscribeFrame).not.toBeNull();
    ws.serverJson({
      jsonrpc: "2.0",
      id: subscribeFrame?.id,
      error: { code: -32601, message: "Method not found: subscribe" },
    });
    await flush();
    expect(lastSnapshot(h)).toMatchObject({ state: "connected", eventsSubscribed: false });
  });

  it("token 不符（close 4001）→ 中文错误 + 退避后携带新 endpoint 重连成功", async () => {
    const h = createHarness([
      { port: 41000, token: "tok-stale" },
      { port: 41001, token: "tok-fresh" },
    ]);
    h.client.start();
    await flush();

    const stale = socketAt(h, 0);
    stale.serverOpen();
    await flush();
    expect(stale.sentJson(0)).toMatchObject({ token: "tok-stale" });
    stale.serverClose(4001, "token mismatch");
    await flush();

    expect(lastSnapshot(h).state).toBe("disconnected");
    expect(lastSnapshot(h).lastError).toContain("token");

    // 首次失败退避 100ms；重连必须重新取 endpoint（supervisor 重启后 port/token 均换新）
    await vi.advanceTimersByTimeAsync(100);
    const fresh = socketAt(h, 1);
    expect(fresh.url).toBe("ws://127.0.0.1:41001");
    fresh.serverOpen();
    await flush();
    expect(fresh.sentJson(0)).toMatchObject({ token: "tok-fresh" });
    fresh.serverJson(WELCOME);
    await flush();
    expect(lastSnapshot(h).state).toBe("connected");
  });

  it("welcome 协议版本失配 → disconnected 且错误信息含版本细节", async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    const ws = socketAt(h, 0);
    ws.serverOpen();
    await flush();
    ws.serverJson({ type: "welcome", protocolVersion: 99, daemonVersion: "0.0.1" });
    await flush();

    expect(lastSnapshot(h).state).toBe("disconnected");
    expect(lastSnapshot(h).lastError).toContain("版本");
  });

  it("首帧不是合法 welcome（收到 JSON-RPC 帧）→ disconnected 且错误指向 welcome 校验", async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    const ws = socketAt(h, 0);
    ws.serverOpen();
    await flush();
    ws.serverJson({ jsonrpc: "2.0", id: 1, result: null });
    await flush();

    expect(lastSnapshot(h).state).toBe("disconnected");
    expect(lastSnapshot(h).lastError).toContain("welcome");
  });

  it("握手悬挂（无 welcome）→ 超时中止并进入退避", async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    const ws = socketAt(h, 0);
    ws.serverOpen();
    await flush();

    await vi.advanceTimersByTimeAsync(5000);
    expect(lastSnapshot(h).state).toBe("disconnected");
    expect(lastSnapshot(h).lastError).toContain("握手超时");
    expect(ws.closeRequested).toBe(true);

    // 超时后仍按退避重连（100ms）
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sockets.length).toBe(2);
  });
});

describe("endpoint 未就绪与重试", () => {
  it("fetchEndpoint 返回 null（daemon 尚未 ready）→ 保持 connecting 退避重试，就绪后连上", async () => {
    const h = createHarness([null, null, DEFAULT_ENDPOINT]);
    h.client.start();
    await flush();

    expect(lastSnapshot(h)).toMatchObject({ state: "connecting" });
    expect(lastSnapshot(h).lastError).toContain("endpoint");
    expect(h.sockets).toHaveLength(0); // 无 endpoint 不开 WS

    // 失败 1（null）→ 100ms；失败 2（null）→ 200ms；第 3 次拿到 endpoint
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.sockets).toHaveLength(1);
    await driveToConnected(h, 0);
    expect(lastSnapshot(h).state).toBe("connected");
  });
});

describe("JSON-RPC 请求层", () => {
  it("响应按 id 关联：无关 id 帧被忽略，匹配 id 命中", async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    const ws = await driveToConnected(h);

    const outcome = h.client.request<{ ok: boolean }>("system.health");
    await flush();
    const frame = findRequestFrame(ws, "system.health");
    expect(frame).not.toBeNull();

    // 先发一个无关 id 的响应：必须被忽略（挂起探针只登记标志，不 await——否则死锁）
    ws.serverJson({ jsonrpc: "2.0", id: 99999, result: { ok: false } });
    let settled = false;
    void outcome.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();
    expect(settled).toBe(false);

    ws.serverJson({ jsonrpc: "2.0", id: frame?.id, result: { ok: true } });
    await expect(outcome).resolves.toEqual({ ok: true });
  });

  it("请求超时 → reject 且错误含超时语义", async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    await driveToConnected(h);

    const outcome = h.client.request("system.health");
    // 先挂接处理器再推进定时器：拒绝发生在 advanceTimersByTimeAsync 内部，
    // 迟挂处理器会被 node 判为瞬时 unhandled rejection（vitest 记 error）
    const caughtPromise = outcome.then(
      () => {
        throw new Error("应当 reject");
      },
      (error: unknown) => error,
    );
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    const caught = (await caughtPromise) as RpcClientError;
    expect(caught.message).toMatch(/超时/);
  });

  it("错误响应映射中文消息（-32601 方法未实现），RpcClientError 携带 code", async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    const ws = await driveToConnected(h);

    const outcome = h.client.request("subscribe", { topics: ["task.updated"] });
    await flush();
    const frame = findRequestFrame(ws, "subscribe");
    ws.serverJson({
      jsonrpc: "2.0",
      id: frame?.id,
      error: { code: -32601, message: "Method not found: subscribe" },
    });

    const caught = await outcome.then(
      () => {
        throw new Error("应当 reject");
      },
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(RpcClientError);
    expect((caught as RpcClientError).code).toBe(-32601);
    expect((caught as RpcClientError).message).toContain("未实现");
  });

  it("未知应用错误码 → 错误消息含原始 code 与 message", async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    const ws = await driveToConnected(h);

    const outcome = h.client.request("agents.spawn", { taskId: "t" });
    await flush();
    const frame = findRequestFrame(ws, "agents.spawn");
    ws.serverJson({
      jsonrpc: "2.0",
      id: frame?.id,
      error: { code: -32001, message: "workspace busy" },
    });

    await expect(outcome).rejects.toThrow(/-32001/);
    await expect(outcome).rejects.toThrow(/workspace busy/);
  });

  it("未连接时发请求 → 立即 reject", async () => {
    const h = createHarness();
    h.client.start();
    await flush(); // connecting（尚未握手完成）
    await expect(h.client.request("system.health")).rejects.toThrow(/未连接/);
  });
});

describe("事件流（daemon 推送 wire 格式：JSON-RPC notification method=event）", () => {
  it("合法 notification（params=envelope）分发给 onEvent；非法 params/非 JSON 帧被忽略且不断连", async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    const ws = await driveToConnected(h);

    // daemon event-bus 定义的 wire 帧：{jsonrpc, method:"event", params:EventEnvelope}
    ws.serverJson({
      jsonrpc: "2.0",
      method: "event",
      params: {
        topic: "task.updated",
        seq: 1,
        emittedAt: "2026-01-01T00:00:00.000Z",
        payload: { id: "t1" },
      },
    });
    await flush();
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ topic: "task.updated", seq: 1 });

    // params 缺 seq：schema 拒绝 → 忽略该帧（spec-review major：notification 键
    // 在整帧 envelope 解析下必然失败——原实现对 daemon 真实帧是死路径）
    ws.serverJson({
      jsonrpc: "2.0",
      method: "event",
      params: { topic: "task.updated", emittedAt: "2026-01-01T00:00:00.000Z", payload: {} },
    });
    // 裸 envelope（无 notification 包装）：daemon 从不发送的形状 → 忽略
    ws.serverJson({
      topic: "task.updated",
      seq: 2,
      emittedAt: "2026-01-01T00:00:00.000Z",
      payload: { id: "t2" },
    });
    // 非 JSON
    ws.serverRaw("<<<not-json>>>");
    await flush();
    expect(h.events).toHaveLength(1);
    expect(lastSnapshot(h).state).toBe("connected");
  });
});

describe("断线与停止", () => {
  it("连接关闭 → 在途请求被拒绝、进入 disconnected，退避后自动重连", async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    const first = await driveToConnected(h);

    const pending = h.client.request("system.health");
    await flush();
    first.serverClose(1006, "abnormal closure");
    await expect(pending).rejects.toThrow(/关闭/);
    expect(lastSnapshot(h).state).toBe("disconnected");
    expect(lastSnapshot(h).lastError).toContain("1006");

    // 首次失败退避 100ms 后用同一 endpoint（队列耗尽复用最后值）重连成功
    await vi.advanceTimersByTimeAsync(100);
    await driveToConnected(h, 1);
    expect(lastSnapshot(h).state).toBe("connected");
  });

  it("stop() → 在途请求被拒绝且不再发起新连接", async () => {
    const h = createHarness();
    h.client.start();
    await flush();
    await driveToConnected(h);

    const pending = h.client.request("system.health");
    await flush();
    h.client.stop();
    await expect(pending).rejects.toThrow(/关闭/);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets).toHaveLength(1);
  });
});
