import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AdapterContext, AgentProcess, ResolvedProviderConfig } from "@aether/core";
import type { ExitProof, ProcessHandle } from "@aether/process-host";
import { createClaudeAdapter } from "../src/adapter.js";
import type { ClaudeAdapterDeps } from "../src/adapter.js";

// ===== 适配器单测：注入 mock query()/spawn/killTree 驱动完整会话旅程 =====
// SDK 形状依据 @anthropic-ai/claude-agent-sdk@0.3.325（sdk.d.ts + code.claude.com/docs/en/agent-sdk）。

const OCCURRED_AT = "2026-01-01T00:00:00Z";

const CFG: ResolvedProviderConfig = {
  kind: "claude-sdk",
  providerConfigId: "pc-1",
  displayName: "Claude",
  config: {},
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PROOF = (over: Partial<ExitProof> = {}): ExitProof =>
  Object.freeze({
    pid: 4000,
    code: 0,
    signal: null,
    killedByUs: false,
    exitedAt: OCCURRED_AT,
    ...over,
  });

interface TestHandle {
  readonly handle: ProcessHandle & { killSpy: ReturnType<typeof vi.fn> };
  readonly exit: ReturnType<typeof deferred<ExitProof>>;
}

function makeTestHandle(pid: number): TestHandle {
  const killSpy = vi.fn();
  const exit = deferred<ExitProof>();
  const handle = {
    pid,
    pgid: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exited: exit.promise,
    kill: killSpy,
  } as unknown as ProcessHandle & { killSpy: ReturnType<typeof vi.fn> };
  return { handle, exit };
}

interface ScriptEnv {
  readonly handles: TestHandle[];
}

type QueryParams = { prompt: unknown; options?: Options };
type Script = (params: QueryParams, env: ScriptEnv) => AsyncGenerator<unknown>;
/** 全量注入（必选五件），spread 进 ClaudeAdapterDeps 不触发 exactOptionalPropertyTypes */
type FullDeps = Required<Pick<ClaudeAdapterDeps, "query" | "spawn" | "killTree" | "now" | "newId">>;

function scriptedDeps(script: Script): {
  deps: FullDeps;
  calls: QueryParams[];
  handles: TestHandle[];
  killTree: ReturnType<typeof vi.fn>;
} {
  const calls: QueryParams[] = [];
  const handles: TestHandle[] = [];
  const spawn = vi.fn(() => {
    const t = makeTestHandle(4000 + handles.length);
    handles.push(t);
    return t.handle;
  });
  const killTree = vi.fn(async (target: ProcessHandle | number): Promise<unknown> => {
    const found = handles.find((t) => t.handle === target);
    if (found !== undefined) found.exit.resolve(PROOF({ code: 1, killedByUs: true }));
    return {
      pid: typeof target === "number" ? target : target.pid,
      method: "taskkill" as const,
      alreadyGone: false,
    };
  });
  let seq = 0;
  const queryFn = async function* (params: QueryParams): AsyncGenerator<unknown> {
    calls.push(params);
    // 模拟真实 SDK：迭代开始时经 spawn 钩子拉起 CLI 进程
    params.options?.spawnClaudeCodeProcess?.({
      command: "node",
      args: ["cli.js"],
      env: {},
      signal: new AbortController().signal,
    });
    yield* script(params, { handles });
  };
  const deps: FullDeps = {
    query: queryFn as unknown as FullDeps["query"],
    spawn,
    killTree: killTree as unknown as FullDeps["killTree"],
    now: () => OCCURRED_AT,
    newId: () => `proc-${++seq}`,
  };
  return { deps, calls, handles, killTree };
}

function makeCtx(events: unknown[]): AdapterContext {
  return {
    emit: (ev) => {
      events.push(ev);
    },
    worktreePath: "/wt/aether-1",
    env: { AETHER_TASK_ID: "task-1" },
    loadEvents: async () => [],
  };
}

// ---- SDK 消息样本（形状对齐 0.3.325）----
const INIT = (sessionId: string) => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  claude_code_version: "2.1.325",
  model: "claude-sonnet-5-5",
  cwd: "/wt",
  tools: [],
  permissionMode: "default",
  slash_commands: [],
  mcp_servers: [],
  output_style: "default",
  skills: [],
  plugins: [],
  apiKeySource: "none",
});
const ASSISTANT_TEXT = (text: string) => ({
  type: "assistant",
  message: { id: "m", role: "assistant", content: [{ type: "text", text }] },
  parent_tool_use_id: null,
  uuid: "u",
  session_id: "ext-abc",
});
const RESULT_SUCCESS = (sessionId = "ext-abc") => ({
  type: "result",
  subtype: "success",
  result: "done",
  is_error: false,
  duration_ms: 1,
  duration_api_ms: 1,
  num_turns: 1,
  session_id: sessionId,
  usage: {},
  total_cost_usd: 0,
});

function typeSeq(events: unknown[]): string[] {
  return events.map((ev) => (ev as { type: string }).type);
}

describe("createClaudeAdapter：元信息", () => {
  it("kind/capabilities 声明（followUpAtMessage 如实为 false：仅整会话 --resume）", () => {
    const adapter = createClaudeAdapter(CFG, scriptedDeps(async function* () {}).deps);
    expect(adapter.kind).toBe("claude-sdk");
    expect(adapter.capabilities).toEqual({
      canResume: true,
      followUpAtMessage: false,
      permissionFlags: true,
      structuredEvents: true,
      protocols: [],
    });
  });

  it("非 claude-sdk 配置拒绝（工厂按 kind 注册）", () => {
    expect(() =>
      createClaudeAdapter({ ...CFG, kind: "custom" }, scriptedDeps(async function* () {}).deps),
    ).toThrow(/claude-sdk/);
  });
});

describe("spawn：完整旅程 spawn→message→tool_use→tool_result→result→exited", () => {
  async function runJourney(events: unknown[]): Promise<{
    proc: AgentProcess;
    harness: ReturnType<typeof scriptedDeps>;
  }> {
    const harness = scriptedDeps(async function* () {
      yield INIT("ext-abc");
      yield ASSISTANT_TEXT("开工");
      yield {
        type: "assistant",
        message: {
          id: "m2",
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
        },
        parent_tool_use_id: null,
        uuid: "u2",
        session_id: "ext-abc",
      };
      yield {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
        },
        parent_tool_use_id: null,
        uuid: "u3",
        session_id: "ext-abc",
      };
      yield RESULT_SUCCESS();
    });
    const adapter = createClaudeAdapter(CFG, harness.deps);
    const proc = await adapter.spawn(
      { sessionId: "session-1", message: "做点事", autonomy: "workspace_write", model: "sonnet-x" },
      makeCtx(events),
    );
    harness.handles[0]!.exit.resolve(PROOF({ code: 0 }));
    await vi.waitFor(() => expect(typeSeq(events).at(-1)).toBe("session"));
    return { proc, harness };
  }

  it("事件序列：session(init)+status(ready) → message → tool_use → tool_result → session(end)", async () => {
    const events: unknown[] = [];
    await runJourney(events);
    expect(typeSeq(events)).toEqual([
      "session",
      "status",
      "message",
      "tool_use",
      "tool_result",
      "session",
    ]);
    const end = events.at(-1) as { type: string; externalSessionId: string | null };
    expect(end.externalSessionId).toBe("ext-abc");
  });

  it("query options：prompt/cwd/env 合并注入/permissionMode 映射/model 透传", async () => {
    const events: unknown[] = [];
    const { harness } = await runJourney(events);
    expect(harness.calls).toHaveLength(1);
    const call = harness.calls[0] as { prompt: unknown; options?: Options };
    expect(call.prompt).toBe("做点事");
    const options = call.options as Options & { env: Record<string, string> };
    expect(options.cwd).toBe("/wt/aether-1");
    expect(options.model).toBe("sonnet-x");
    expect(options.permissionMode).toBe("acceptEdits");
    expect(options.env.AETHER_TASK_ID).toBe("task-1");
    expect(typeof options.env.PATH).toBe("string");
    expect(options.abortController).toBeInstanceOf(AbortController);
    expect(typeof options.spawnClaudeCodeProcess).toBe("function");
    expect(typeof options.canUseTool).toBe("function");
  });

  it("config.maxTurns 透传 Options.maxTurns；非法值忽略（成本护栏落在 flag）", async () => {
    const runOnce = async (configValue: unknown): Promise<unknown> => {
      const events: unknown[] = [];
      const harness = scriptedDeps(async function* () {
        yield INIT("ext-abc");
        yield RESULT_SUCCESS();
      });
      const adapter = createClaudeAdapter(
        { ...CFG, config: { maxTurns: configValue } },
        harness.deps,
      );
      await adapter.spawn(
        { sessionId: "session-1", message: "x", autonomy: "read_only", model: null },
        makeCtx(events),
      );
      harness.handles[0]!.exit.resolve(PROOF());
      await vi.waitFor(() => expect(typeSeq(events).at(-1)).toBe("session"));
      return (harness.calls[0] as { options?: Options }).options?.maxTurns;
    };
    expect(await runOnce(2)).toBe(2);
    expect(await runOnce("2")).toBeUndefined();
    expect(await runOnce(0)).toBeUndefined();
  });

  it("AgentProcess：pid 来自治理句柄；exited 退出证明；proc.cancel 可用", async () => {
    const events: unknown[] = [];
    const { proc } = await runJourney(events);
    expect(proc.processId).toBe("proc-1");
    expect(proc.pid).toBe(4000);
    await expect(proc.exited).resolves.toEqual({ code: 0 });
    expect(typeof proc.cancel).toBe("function");
  });
});

describe("spawn：autonomy → SDK permissionMode 三档映射", () => {
  it.each([
    ["read_only", "plan"],
    ["workspace_write", "acceptEdits"],
    ["auto", "auto"],
  ] as const)("%s → %s", async (autonomy, permissionMode) => {
    const events: unknown[] = [];
    const harness = scriptedDeps(async function* () {
      yield INIT("ext-abc");
      yield RESULT_SUCCESS();
    });
    const adapter = createClaudeAdapter(CFG, harness.deps);
    await adapter.spawn(
      { sessionId: "session-1", message: "x", autonomy, model: null },
      makeCtx(events),
    );
    harness.handles[0]!.exit.resolve(PROOF());
    expect((harness.calls[0]!.options as Options).permissionMode).toBe(permissionMode);
  });
});

describe("错误路径", () => {
  it("进程非零退出（非我杀）→ error 事件，终态 error", async () => {
    const events: unknown[] = [];
    const harness = scriptedDeps(async function* () {
      yield INIT("ext-abc");
      yield RESULT_SUCCESS();
    });
    const adapter = createClaudeAdapter(CFG, harness.deps);
    await adapter.spawn(
      { sessionId: "session-1", message: "x", autonomy: "read_only", model: null },
      makeCtx(events),
    );
    harness.handles[0]!.exit.resolve(PROOF({ code: 2, killedByUs: false }));
    await vi.waitFor(() => expect(typeSeq(events).at(-1)).toBe("error"));
    const err = events.at(-1) as { type: string; message: string };
    expect(err.message).toContain("2");
  });

  it("result error_max_turns（干净退出）→ error 事件", async () => {
    const events: unknown[] = [];
    const harness = scriptedDeps(async function* () {
      yield INIT("ext-abc");
      yield {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 3,
        session_id: "ext-abc",
        usage: {},
        total_cost_usd: 0,
        permission_denials: [],
        errors: ["轮次超限"],
        modelUsage: {},
      };
    });
    const adapter = createClaudeAdapter(CFG, harness.deps);
    await adapter.spawn(
      { sessionId: "session-1", message: "x", autonomy: "read_only", model: null },
      makeCtx(events),
    );
    harness.handles[0]!.exit.resolve(PROOF({ code: 0 }));
    await vi.waitFor(() => expect(typeSeq(events).at(-1)).toBe("error"));
    expect((events.at(-1) as { message: string }).message).toContain("轮次超限");
  });

  it("query 启动即抛（进程未创建）→ spawn 拒绝 + error 事件", async () => {
    const events: unknown[] = [];
    // 裸 mock：query 在调用 spawn 钩子之前就抛出（模拟 SDK options 校验失败，
    // 进程从未创建——scriptedDeps 的 mock 会先经钩子 spawn，不符合本场景）。
    // 用 async iterator 而非 generator：首个 next() 即 reject
    const queryFn = (): AsyncIterable<never> => ({
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<never>> => Promise.reject(new Error("boom")),
      }),
    });
    const spawn = vi.fn();
    const adapter = createClaudeAdapter(CFG, {
      query: queryFn as unknown as FullDeps["query"],
      spawn,
      killTree: (async () => null) as unknown as FullDeps["killTree"],
      now: () => OCCURRED_AT,
      newId: () => "proc-boom",
    });
    await expect(
      adapter.spawn(
        { sessionId: "session-1", message: "x", autonomy: "read_only", model: null },
        makeCtx(events),
      ),
    ).rejects.toThrow(/boom/);
    expect(spawn).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(typeSeq(events).at(-1)).toBe("error"));
    expect((events.at(-1) as { message: string }).message).toContain("boom");
  });
});

describe("cancel：用户取消 → abort + killTree 树杀 + 终态 stopped", () => {
  it("abort 触发、killTree 收到治理句柄、killedByUs 退出 → session 终态（非 error）", async () => {
    const events: unknown[] = [];
    const harness = scriptedDeps(async function* (params) {
      yield INIT("ext-abc");
      const abort = params.options?.abortController?.signal;
      await new Promise((_, reject) => {
        abort?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    });
    const adapter = createClaudeAdapter(CFG, harness.deps);
    const proc = await adapter.spawn(
      { sessionId: "session-1", message: "x", autonomy: "read_only", model: null },
      makeCtx(events),
    );
    await vi.waitFor(() => expect(typeSeq(events)).toContain("status"));
    await adapter.cancel(proc, "user_cancelled");
    expect(harness.killTree).toHaveBeenCalledTimes(1);
    expect(harness.killTree).toHaveBeenCalledWith(harness.handles[0]?.handle);
    expect((harness.calls[0]!.options as Options).abortController?.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(typeSeq(events).at(-1)).toBe("session"));
    expect(typeSeq(events)).not.toContain("error");
    await expect(proc.exited).resolves.toEqual({ code: 1 });
  });

  it("未知 processId 的 cancel 静默无操作（幂等）", async () => {
    const harness = scriptedDeps(async function* () {});
    const adapter = createClaudeAdapter(CFG, harness.deps);
    const ghost = {
      processId: "nope",
      pid: null,
      cancel: async () => {},
      exited: Promise.resolve({ code: null }),
    };
    await expect(adapter.cancel(ghost as AgentProcess, "user_cancelled")).resolves.toBeUndefined();
    expect(harness.killTree).not.toHaveBeenCalled();
  });
});

describe("权限桥接：canUseTool ↔ permission_request / resolvePermission", () => {
  function permissionScript(requestId: string): Script {
    return async function* (params) {
      yield INIT("ext-abc");
      const decision = await params.options?.canUseTool?.(
        "Bash",
        { command: "rm -rf /" },
        {
          signal: new AbortController().signal,
          toolUseID: "tu_p",
          requestId,
          suggestions: [],
          title: "Claude 想删除文件",
        },
      );
      yield ASSISTANT_TEXT(`决策:${decision?.behavior ?? "none"}`);
      yield RESULT_SUCCESS();
    };
  }

  it("批准：emit permission_request → resolvePermission(approve) → behavior allow", async () => {
    const events: unknown[] = [];
    const harness = scriptedDeps(permissionScript("req_p"));
    const adapter = createClaudeAdapter(CFG, harness.deps);
    const proc = await adapter.spawn(
      { sessionId: "session-1", message: "x", autonomy: "read_only", model: null },
      makeCtx(events),
    );
    await vi.waitFor(() => expect(typeSeq(events)).toContain("permission_request"));
    const req = events.find((ev) => (ev as { type: string }).type === "permission_request") as {
      requestId: string;
      toolName: string;
      summary: string;
    };
    expect(req.requestId).toBe("req_p");
    expect(req.toolName).toBe("Bash");
    expect(req.summary).toBe("Claude 想删除文件");
    await adapter.resolvePermission(proc.processId, "req_p", "approve");
    harness.handles[0]!.exit.resolve(PROOF());
    await vi.waitFor(() => expect(typeSeq(events)).toContain("message"));
    const msg = events.find(
      (ev) => (ev as { type: string; content: string }).type === "message",
    ) as { content: string };
    expect(msg.content).toBe("决策:allow");
  });

  it("拒绝：resolvePermission(deny) → behavior deny + 送达消息", async () => {
    const events: unknown[] = [];
    const harness = scriptedDeps(permissionScript("req_d"));
    const adapter = createClaudeAdapter(CFG, harness.deps);
    const proc = await adapter.spawn(
      { sessionId: "session-1", message: "x", autonomy: "read_only", model: null },
      makeCtx(events),
    );
    await vi.waitFor(() => expect(typeSeq(events)).toContain("permission_request"));
    await adapter.resolvePermission(proc.processId, "req_d", "deny");
    harness.handles[0]!.exit.resolve(PROOF());
    await vi.waitFor(() =>
      expect(events.find((ev) => (ev as { type: string }).type === "message")).toBeDefined(),
    );
    const msg = events.find(
      (ev) => (ev as { type: string; content: string }).type === "message",
    ) as { content: string };
    expect(msg.content).toBe("决策:deny");
  });

  it("未知 requestId 的 resolvePermission 拒绝（待决请求不存在）", async () => {
    const events: unknown[] = [];
    const harness = scriptedDeps(async function* () {
      yield INIT("ext-abc");
      yield RESULT_SUCCESS();
    });
    const adapter = createClaudeAdapter(CFG, harness.deps);
    const proc = await adapter.spawn(
      { sessionId: "session-1", message: "x", autonomy: "read_only", model: null },
      makeCtx(events),
    );
    await expect(adapter.resolvePermission(proc.processId, "ghost", "approve")).rejects.toThrow(
      /ghost/,
    );
    harness.handles[0]!.exit.resolve(PROOF());
  });

  it("cancel 时挂起的权限请求自动 deny（进程取消不放行工具）", async () => {
    const events: unknown[] = [];
    let observed: { behavior: string; message?: string } | undefined;
    const harness = scriptedDeps(async function* (params) {
      yield INIT("ext-abc");
      const decision = await params.options?.canUseTool?.(
        "Bash",
        {},
        {
          signal: params.options?.abortController?.signal ?? new AbortController().signal,
          toolUseID: "tu_c",
          requestId: "req_c",
        },
      );
      observed = decision as { behavior: string; message?: string };
      yield RESULT_SUCCESS();
    });
    const adapter = createClaudeAdapter(CFG, harness.deps);
    const proc = await adapter.spawn(
      { sessionId: "session-1", message: "x", autonomy: "read_only", model: null },
      makeCtx(events),
    );
    await vi.waitFor(() => expect(typeSeq(events)).toContain("permission_request"));
    await adapter.cancel(proc, "user_cancelled");
    await vi.waitFor(() => expect(observed).toBeDefined());
    expect(observed?.behavior).toBe("deny");
  });
});

describe("spawnFollowUp：--resume 接续同一外部会话", () => {
  it("第二轮 query 带 resume=externalSessionId，事件走新 ctx", async () => {
    const events1: unknown[] = [];
    const events2: unknown[] = [];
    const harness = scriptedDeps(async function* () {
      yield INIT("ext-abc");
      yield RESULT_SUCCESS();
    });
    const adapter = createClaudeAdapter(CFG, harness.deps);
    const proc = await adapter.spawn(
      { sessionId: "session-1", message: "第一轮", autonomy: "read_only", model: null },
      makeCtx(events1),
    );
    harness.handles[0]!.exit.resolve(PROOF());
    await vi.waitFor(() => expect(typeSeq(events1).at(-1)).toBe("session"));

    await adapter.spawnFollowUp(proc, { message: "继续" }, makeCtx(events2));
    harness.handles[1]!.exit.resolve(PROOF());
    await vi.waitFor(() => expect(typeSeq(events2).at(-1)).toBe("session"));
    expect(harness.calls).toHaveLength(2);
    const second = harness.calls[1] as { prompt: unknown; options?: Options };
    expect(second.prompt).toBe("继续");
    expect(second.options?.resume).toBe("ext-abc");
    expect(typeSeq(events2)).toEqual(["session", "status", "session"]);
  });

  it("会话尚无 externalSessionId 时 follow-up 拒绝", async () => {
    const events: unknown[] = [];
    const harness = scriptedDeps(async function* () {
      // init/result 均未携带 session_id → externalSessionId 保持 null
      yield INIT("");
      yield RESULT_SUCCESS("");
    });
    const adapter = createClaudeAdapter(CFG, harness.deps);
    const proc = await adapter.spawn(
      { sessionId: "session-1", message: "x", autonomy: "read_only", model: null },
      makeCtx(events),
    );
    await expect(adapter.spawnFollowUp(proc, { message: "继续" }, makeCtx(events))).rejects.toThrow(
      /externalSessionId|resume/,
    );
  });

  it("未知 processId 的 follow-up 拒绝", async () => {
    const harness = scriptedDeps(async function* () {});
    const adapter = createClaudeAdapter(CFG, harness.deps);
    const ghost = {
      processId: "nope",
      pid: null,
      cancel: async () => {},
      exited: Promise.resolve({ code: null }),
    };
    await expect(
      adapter.spawnFollowUp(ghost as AgentProcess, { message: "x" }, makeCtx([])),
    ).rejects.toThrow(/nope|未知/);
  });

  it("上一轮仍活跃时 follow-up：两轮并行活跃，cancel 树杀全部（治理句柄零失联，spec-review major 回归）", async () => {
    const events1: unknown[] = [];
    const events2: unknown[] = [];
    const gates = [deferred<void>(), deferred<void>()];
    let round = 0;
    const harness = scriptedDeps(async function* () {
      const current = round++;
      yield INIT(`ext-${current}`);
      await gates[current]!.promise; // hold：两轮都保持活跃不收敛
    });
    const adapter = createClaudeAdapter(CFG, harness.deps);
    const proc = await adapter.spawn(
      { sessionId: "session-1", message: "第一轮", autonomy: "read_only", model: null },
      makeCtx(events1),
    );
    // 第一轮未结束（gate 未放行）即 follow-up——先等 INIT 帧落地
    // （externalSessionId 自 init 帧写入，但泵是异步的，需等事件可见）
    await vi.waitFor(() => expect(typeSeq(events1)).toContain("session"));
    await adapter.spawnFollowUp(proc, { message: "第二轮" }, makeCtx(events2));
    await vi.waitFor(() => expect(harness.handles).toHaveLength(2));

    await proc.cancel("user_cancelled");
    // 两轮的治理句柄都被树杀（旧 run 不因顶替而失联）
    expect(harness.killTree).toHaveBeenCalledTimes(2);
    const killedPids = harness.killTree.mock.calls.map((call) => (call[0] as ProcessHandle).pid);
    expect(killedPids).toEqual([4000, 4001]);

    // 收尾：放行两轮，各物化终态（killedByUs → session，非 error）
    for (const gate of gates) gate.resolve();
    await vi.waitFor(() => expect(typeSeq(events1).at(-1)).toBe("session"));
    await vi.waitFor(() => expect(typeSeq(events2).at(-1)).toBe("session"));
    await adapter.dispose();
  });
});

describe("resume：断线/重启后恢复会话句柄", () => {
  const SESSION = {
    id: "session-9",
    workspaceId: "ws-1",
    agentProfileId: "ap-1",
    externalSessionId: "ext-xyz",
    status: "stopped",
    lineageParentId: null,
    checkpointRef: null,
    createdAt: OCCURRED_AT,
    lastActiveAt: OCCURRED_AT,
  } as const;

  it("恢复句柄无活进程（pid null / exited 立即收敛），follow-up 走 resume", async () => {
    const events: unknown[] = [];
    const harness = scriptedDeps(async function* () {
      yield INIT("ext-xyz");
      yield RESULT_SUCCESS();
    });
    const adapter = createClaudeAdapter(CFG, harness.deps);
    const proc = await adapter.resume({ ...SESSION }, makeCtx(events));
    expect(proc.pid).toBeNull();
    await expect(proc.exited).resolves.toEqual({ code: null });
    await adapter.spawnFollowUp(proc, { message: "接着说" }, makeCtx(events));
    harness.handles[0]!.exit.resolve(PROOF());
    await vi.waitFor(() => expect(typeSeq(events).at(-1)).toBe("session"));
    expect((harness.calls[0]!.options as Options).resume).toBe("ext-xyz");
  });

  it("externalSessionId 为空时 resume 拒绝（canResume 前置条件）", async () => {
    const harness = scriptedDeps(async function* () {});
    const adapter = createClaudeAdapter(CFG, harness.deps);
    await expect(
      adapter.resume({ ...SESSION, externalSessionId: null }, makeCtx([])),
    ).rejects.toThrow(/externalSessionId/);
  });
});

describe("discover：环境探测（缺失给安装指引，不抛）", () => {
  it("探测成功 → available + version", async () => {
    const probeVersion = vi.fn(async () => "2.1.325");
    const adapter = createClaudeAdapter(CFG, {
      ...scriptedDeps(async function* () {}).deps,
      probeVersion,
    });
    const result = await adapter.discover();
    expect(result).toEqual({ available: true, version: "2.1.325" });
    expect(probeVersion).toHaveBeenCalledTimes(1);
  });

  it("探测失败 → available=false + installHint（含安装指引）", async () => {
    const probeVersion = vi.fn(async () => null);
    const adapter = createClaudeAdapter(CFG, {
      ...scriptedDeps(async function* () {}).deps,
      probeVersion,
    });
    const result = await adapter.discover();
    expect(result.available).toBe(false);
    expect(result.version).toBeUndefined();
    expect(result.installHint).toBeTruthy();
    expect((result.installHint ?? "").length).toBeGreaterThan(10);
  });

  it("配置了 cliPath 时候选首位是它", async () => {
    const probeVersion = vi.fn(async (_candidates: readonly string[]) => null);
    const adapter = createClaudeAdapter(
      { ...CFG, config: { cliPath: "D:/tools/claude.exe" } },
      { ...scriptedDeps(async function* () {}).deps, probeVersion },
    );
    await adapter.discover();
    const candidates = probeVersion.mock.calls[0]?.[0];
    expect(candidates?.[0]).toBe("D:/tools/claude.exe");
  });
});

describe("normalizeLogs：旁路转换器（原始行 → 归一化事件）", () => {
  it("对象/JSON 字符串混合输入；非法行丢弃不炸", () => {
    const harness = scriptedDeps(async function* () {});
    const adapter = createClaudeAdapter(CFG, harness.deps);
    const events = adapter.normalizeLogs([
      JSON.stringify(INIT("ext-abc")),
      { type: "banana" },
      "not-json{{",
      RESULT_SUCCESS(),
    ]);
    expect(events.map((ev) => ev.type)).toEqual(["session", "status", "session"]);
    expect((events.at(-1) as { externalSessionId: string | null }).externalSessionId).toBe(
      "ext-abc",
    );
  });

  it("空输入 → 空事件", () => {
    const harness = scriptedDeps(async function* () {});
    const adapter = createClaudeAdapter(CFG, harness.deps);
    expect(adapter.normalizeLogs([])).toEqual([]);
  });
});

describe("dispose：清理", () => {
  it("活运行被 abort + 树杀；之后 cancel 无操作", async () => {
    const events: unknown[] = [];
    const harness = scriptedDeps(async function* (params) {
      yield INIT("ext-abc");
      await new Promise((_, reject) => {
        params.options?.abortController?.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    });
    const adapter = createClaudeAdapter(CFG, harness.deps);
    await adapter.spawn(
      { sessionId: "session-1", message: "x", autonomy: "read_only", model: null },
      makeCtx(events),
    );
    await vi.waitFor(() => expect(typeSeq(events)).toContain("status"));
    await adapter.dispose();
    expect(harness.killTree).toHaveBeenCalledTimes(1);
    expect((harness.calls[0]!.options as Options).abortController?.signal.aborted).toBe(true);
    const ghost = {
      processId: "proc-1",
      pid: 1,
      cancel: async () => {},
      exited: Promise.resolve({ code: null }),
    };
    await expect(adapter.cancel(ghost as AgentProcess, "shutdown")).resolves.toBeUndefined();
    expect(harness.killTree).toHaveBeenCalledTimes(1);
  });

  it("无活运行的 dispose 无害", async () => {
    const harness = scriptedDeps(async function* () {});
    const adapter = createClaudeAdapter(CFG, harness.deps);
    await expect(adapter.dispose()).resolves.toBeUndefined();
  });
});
