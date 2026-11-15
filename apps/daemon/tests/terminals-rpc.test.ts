// terminals.* RPC 路由语义测试（contracts rpc.ts 签名为准）：
// 参数 strict 校验 fail-closed、未知 id 的 write/resize → INVALID_PARAMS（中文）、
// kill 幂等（未知 id → Success null）、成功路径 result 形状（void → null / 句柄含 pid）。
// 用假终端池（无 PTY）锁定 RPC 语义；真 TerminalPool 全链见 terminals-ws.integration.test.ts。
import { describe, expect, it } from "vitest";
import {
  JSON_RPC_ERROR_CODES,
  JsonRpcErrorResponseSchema,
  JsonRpcSuccessResponseSchema,
  PROTOCOL_VERSION,
} from "@aether/contracts";
import type { TerminalPool, TerminalPoolCreateInput, TerminalPoolHandle } from "@aether/terminal";
import { routeMessage, type RouteOutcome } from "../src/rpc/router.js";
import { createEventBus } from "../src/events/event-bus.js";

/** 假终端池：已知 id = "t-live"；write/resize/kill 记录调用供断言 */
function createFakePool(): TerminalPool & {
  calls: { op: string; terminalId?: string; data?: string; cols?: number; rows?: number }[];
} {
  const calls: { op: string; terminalId?: string; data?: string; cols?: number; rows?: number }[] =
    [];
  const pool: TerminalPool = {
    get size() {
      return 1;
    },
    create(input: TerminalPoolCreateInput): TerminalPoolHandle {
      calls.push({ op: "create" });
      return { terminalId: "t-live", pid: 4242, ...(input.cols === 999 ? {} : {}) };
    },
    write(terminalId: string, data: string): boolean {
      calls.push({ op: "write", terminalId, data });
      return terminalId === "t-live";
    },
    resize(terminalId: string, cols: number, rows: number): boolean {
      calls.push({ op: "resize", terminalId, cols, rows });
      return terminalId === "t-live";
    },
    historyFrames: () => null,
    kill(terminalId: string) {
      calls.push({ op: "kill", terminalId });
      return Promise.resolve({ exitCode: null, signal: 9 });
    },
    disposeAll: () => Promise.resolve(),
    onOutput: () => () => undefined,
    onExit: () => () => undefined,
  };
  return { ...pool, calls };
}

const deps = () => {
  const pool = createFakePool();
  return {
    pool,
    deps: {
      daemonVersion: "0.0.1",
      protocolVersion: PROTOCOL_VERSION,
      terminals: pool,
      events: createEventBus(),
    },
  };
};

function request(method: string, params?: unknown, id: number | string = 1): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  });
}

function requireFrame(outcome: RouteOutcome): string {
  if (outcome.kind === "none") {
    throw new Error(`期望 response 帧，收到 none`);
  }
  return outcome.frame;
}

function successFrame(outcome: RouteOutcome) {
  return JsonRpcSuccessResponseSchema.parse(JSON.parse(requireFrame(outcome)));
}

function errorFrame(outcome: RouteOutcome) {
  return JsonRpcErrorResponseSchema.parse(JSON.parse(requireFrame(outcome)));
}

describe("terminals.create", () => {
  it("合法参数 → Success，result = TerminalHandle（terminalId + pid）", async () => {
    const { deps: routerDeps, pool } = deps();
    const outcome = await routeMessage(
      request("terminals.create", { projectId: "p-1", cwd: "/tmp", cols: 80, rows: 24 }),
      routerDeps,
    );
    expect(outcome.kind).toBe("response");
    const frame = successFrame(outcome);
    expect(frame.result).toEqual({ terminalId: "t-live", pid: 4242 });
    expect(pool.calls).toEqual([{ op: "create" }]);
  });

  it("workspaceId 可选字段允许；缺 cwd / cols=0 / 未知字段 / 缺 params → INVALID_PARAMS", async () => {
    const { deps: routerDeps } = deps();
    const ok = await routeMessage(
      request("terminals.create", {
        projectId: "p-1",
        workspaceId: "w-1",
        cwd: "/tmp",
        cols: 80,
        rows: 24,
      }),
      routerDeps,
    );
    expect(successFrame(ok).result).toEqual({ terminalId: "t-live", pid: 4242 });

    for (const params of [
      { projectId: "p-1", cols: 80, rows: 24 }, // 缺 cwd
      { projectId: "p-1", cwd: "/tmp", cols: 0, rows: 24 }, // 非正尺寸
      { projectId: "p-1", cwd: "/tmp", cols: 80, rows: 24, file: "/bin/sh" }, // 未知字段（RPC 面无 file/args）
    ]) {
      const outcome = await routeMessage(request("terminals.create", params), routerDeps);
      expect(errorFrame(outcome).error.code).toBe(JSON_RPC_ERROR_CODES.INVALID_PARAMS);
    }
    const noParams = await routeMessage(request("terminals.create"), routerDeps);
    expect(errorFrame(noParams).error.code).toBe(JSON_RPC_ERROR_CODES.INVALID_PARAMS);
  });
});

describe("terminals.write", () => {
  it("已知 id → Success（result null，void 语义），base64 透传", async () => {
    const { deps: routerDeps, pool } = deps();
    const outcome = await routeMessage(
      request("terminals.write", { terminalId: "t-live", data: "aGVsbG8=" }),
      routerDeps,
    );
    expect(successFrame(outcome).result).toBeNull();
    expect(pool.calls).toEqual([{ op: "write", terminalId: "t-live", data: "aGVsbG8=" }]);
  });

  it("未知 id → INVALID_PARAMS，中文错误消息含 terminalId（fail-closed 定案）", async () => {
    const { deps: routerDeps } = deps();
    const outcome = await routeMessage(
      request("terminals.write", { terminalId: "t-gone", data: "aGVsbG8=" }),
      routerDeps,
    );
    const frame = errorFrame(outcome);
    expect(frame.error.code).toBe(JSON_RPC_ERROR_CODES.INVALID_PARAMS);
    expect(frame.error.message).toContain("t-gone");
  });

  it("非法 base64 → INVALID_PARAMS（zod wire 校验）", async () => {
    const { deps: routerDeps } = deps();
    const outcome = await routeMessage(
      request("terminals.write", { terminalId: "t-live", data: "not-base64!!" }),
      routerDeps,
    );
    expect(errorFrame(outcome).error.code).toBe(JSON_RPC_ERROR_CODES.INVALID_PARAMS);
  });
});

describe("terminals.resize", () => {
  it("已知 id → Success null；未知 id → INVALID_PARAMS 中文消息", async () => {
    const { deps: routerDeps, pool } = deps();
    const ok = await routeMessage(
      request("terminals.resize", { terminalId: "t-live", cols: 120, rows: 40 }),
      routerDeps,
    );
    expect(successFrame(ok).result).toBeNull();
    expect(pool.calls).toEqual([{ op: "resize", terminalId: "t-live", cols: 120, rows: 40 }]);

    const unknown = await routeMessage(
      request("terminals.resize", { terminalId: "t-gone", cols: 120, rows: 40 }),
      routerDeps,
    );
    expect(errorFrame(unknown).error.code).toBe(JSON_RPC_ERROR_CODES.INVALID_PARAMS);
    expect(errorFrame(unknown).error.message).toContain("t-gone");
  });

  it("非正整数尺寸 → INVALID_PARAMS", async () => {
    const { deps: routerDeps } = deps();
    const outcome = await routeMessage(
      request("terminals.resize", { terminalId: "t-live", cols: -1, rows: 40 }),
      routerDeps,
    );
    expect(errorFrame(outcome).error.code).toBe(JSON_RPC_ERROR_CODES.INVALID_PARAMS);
  });
});

describe("terminals.kill", () => {
  it("已知与未知 id 均 Success null（幂等定案：终止意图重放无副作用，与 write/resize 区分）", async () => {
    const { deps: routerDeps, pool } = deps();
    const known = await routeMessage(
      request("terminals.kill", { terminalId: "t-live" }),
      routerDeps,
    );
    expect(successFrame(known).result).toBeNull();
    const unknown = await routeMessage(
      request("terminals.kill", { terminalId: "t-gone" }),
      routerDeps,
    );
    expect(successFrame(unknown).result).toBeNull();
    expect(pool.calls.map((call) => call.op)).toEqual(["kill", "kill"]);
  });
});

describe("terminals.* 未装配（骨架 deps）", () => {
  it("不注入 terminals 时 → METHOD_NOT_FOUND（向后兼容：既有 37 测试的骨架行为）", async () => {
    const outcome = await routeMessage(
      request("terminals.create", { projectId: "p", cwd: "/t", cols: 80, rows: 24 }),
      {
        daemonVersion: "0.0.1",
        protocolVersion: PROTOCOL_VERSION,
      },
    );
    expect(errorFrame(outcome).error.code).toBe(JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND);
  });
});

describe("subscribe（事件水位）", () => {
  it("合法 topics → Success { cursor: 当前水位 }（P0-10 无重放缓冲，定案：从现在开始推送）", async () => {
    const { deps: routerDeps } = deps();
    const outcome = await routeMessage(
      request("subscribe", { topics: ["terminal.t1.output"] }),
      routerDeps,
    );
    const frame = successFrame(outcome);
    expect(frame.result).toEqual({ cursor: 0 });
  });

  it("空 topics / 缺 params / 未知字段 → INVALID_PARAMS", async () => {
    const { deps: routerDeps } = deps();
    for (const params of [
      { topics: [] },
      { topics: ["a"], cursor: -1 },
      { topic: "a" },
      undefined,
    ]) {
      const outcome = await routeMessage(request("subscribe", params), routerDeps);
      expect(errorFrame(outcome).error.code).toBe(JSON_RPC_ERROR_CODES.INVALID_PARAMS);
    }
  });
});
