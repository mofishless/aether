import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import {
  INITIAL_AGENT_STATUS,
  applySessionEvent,
  type AdapterContext,
  type ResolvedProviderConfig,
} from "@aether/core";
import type { AgentStatus } from "@aether/contracts";
import type { ExitProof, ProcessHandle } from "@aether/process-host";
import { createClaudeAdapter } from "../src/adapter.js";
import type { ClaudeAdapterDeps } from "../src/adapter.js";

// ===== 状态机集成：适配器 emit 的事件流经 core applySessionEvent fold 出全轨迹 =====
// 旅程：starting --session(init)--> ready --message--> running --permission_request-->
// waiting --resolvePermission(approve)--> message --> running --result/干净退出-->
// session(end) --> stopped（§8.1 全主路径覆盖 + error 分支）。

const OCCURRED_AT = "2026-01-01T00:00:00Z";

const CFG: ResolvedProviderConfig = {
  kind: "claude-sdk",
  providerConfigId: "pc-1",
  displayName: "Claude",
  config: {},
};

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeHandle(pid: number): {
  handle: ProcessHandle;
  exit: { promise: Promise<ExitProof>; resolve: (v: ExitProof) => void };
} {
  const exit = deferred<ExitProof>();
  const handle = {
    pid,
    pgid: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exited: exit.promise,
    kill: () => undefined,
  } as unknown as ProcessHandle;
  return { handle, exit };
}

interface FoldedEvent {
  readonly type: string;
  readonly requestId?: string;
  readonly status?: AgentStatus;
}

/** 测试用 canUseTool 窄化形状（真实类型见 SDK CanUseTool） */
type AskPermission = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string; requestId: string },
) => Promise<{ behavior: string }>;

/** 测试用的 query params 窄化形状（适配器传入的 Options 子集） */
interface PumpParams {
  readonly options?: {
    readonly canUseTool?: AskPermission;
    readonly spawnClaudeCodeProcess?: (spawnOptions: {
      command: string;
      args: string[];
      env: Record<string, string>;
      signal: AbortSignal;
    }) => unknown;
    readonly abortController?: AbortController;
  };
}

function collect(events: FoldedEvent[]): AdapterContext {
  return {
    emit: (ev) => {
      events.push(ev as FoldedEvent);
    },
    worktreePath: "/wt",
    env: {},
    loadEvents: async () => [],
  };
}

/** fold：(初始状态, 事件序列) → 应用轨迹（applied 的目标状态序列 + rejected 数） */
function fold(events: FoldedEvent[]): { statuses: AgentStatus[]; rejected: number } {
  let current = INITIAL_AGENT_STATUS;
  const statuses: AgentStatus[] = [];
  let rejected = 0;
  for (const ev of events) {
    const result = applySessionEvent(current, ev as Parameters<typeof applySessionEvent>[1]);
    if (result.transition === "applied") {
      current = result.status;
      statuses.push(result.status);
    } else {
      rejected += 1;
    }
  }
  return { statuses, rejected };
}

describe("适配器事件流 × core 状态机 fold", () => {
  it("含权限往返的完整旅程：starting→ready→running→waiting→running→stopped", async () => {
    const events: FoldedEvent[] = [];
    const handles = [makeHandle(5000)];
    let spawnCount = 0;
    const deps: ClaudeAdapterDeps = {
      query: async function* (params: PumpParams) {
        params.options?.spawnClaudeCodeProcess?.({
          command: "node",
          args: [],
          env: {},
          signal: new AbortController().signal,
        });
        yield {
          type: "system",
          subtype: "init",
          session_id: "ext-fold",
          claude_code_version: "2.1.325",
          model: "m",
          cwd: "/wt",
          tools: [],
          permissionMode: "default",
          slash_commands: [],
          mcp_servers: [],
          output_style: "default",
          skills: [],
          plugins: [],
          apiKeySource: "none",
        };
        const ask = (params.options as { canUseTool?: AskPermission } | undefined)?.canUseTool;
        const decision = await ask?.(
          "Bash",
          { command: "ls" },
          {
            signal: new AbortController().signal,
            toolUseID: "tu",
            requestId: "req-1",
          },
        );
        yield {
          type: "assistant",
          message: {
            id: "m",
            role: "assistant",
            content: [{ type: "text", text: `done:${decision?.behavior}` }],
          },
          parent_tool_use_id: null,
          uuid: "u",
          session_id: "ext-fold",
        };
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          is_error: false,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          session_id: "ext-fold",
          usage: {},
          total_cost_usd: 0,
        };
      } as unknown as NonNullable<ClaudeAdapterDeps["query"]>,
      spawn: (() => {
        const h = handles[0] as { handle: ProcessHandle };
        spawnCount += 1;
        return () => h.handle;
      })(),
      killTree: (async () => ({
        pid: 5000,
        method: "taskkill" as const,
        alreadyGone: false,
      })) as unknown as NonNullable<ClaudeAdapterDeps["killTree"]>,
      now: () => OCCURRED_AT,
      newId: () => "proc-fold",
    };

    const adapter = createClaudeAdapter(CFG, deps);
    const proc = await adapter.spawn(
      { sessionId: "session-fold", message: "任务", autonomy: "read_only", model: null },
      collect(events),
    );

    // 权限请求到达 → waiting；应答 approve 后模型续跑
    await vi.waitFor(() =>
      expect(events.some((ev) => ev.type === "permission_request")).toBe(true),
    );
    await adapter.resolvePermission(proc.processId, "req-1", "approve");

    handles[0]?.exit.resolve(
      Object.freeze({
        pid: 5000,
        code: 0,
        signal: null,
        killedByUs: false,
        exitedAt: OCCURRED_AT,
      }),
    );
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("session"));
    expect(spawnCount).toBe(1);

    const { statuses, rejected } = fold(events);
    expect(statuses).toEqual(["ready", "ready", "waiting", "running", "stopped"]);
    expect(rejected).toBe(0);
  });

  it("非零退出分支：starting→ready→running→error", async () => {
    const events: FoldedEvent[] = [];
    const { handle, exit } = makeHandle(5001);
    const deps: ClaudeAdapterDeps = {
      query: async function* (params: PumpParams) {
        params.options?.spawnClaudeCodeProcess?.({
          command: "node",
          args: [],
          env: {},
          signal: new AbortController().signal,
        });
        yield {
          type: "system",
          subtype: "init",
          session_id: "ext-err",
          claude_code_version: "2.1.325",
          model: "m",
          cwd: "/wt",
          tools: [],
          permissionMode: "default",
          slash_commands: [],
          mcp_servers: [],
          output_style: "default",
          skills: [],
          plugins: [],
          apiKeySource: "none",
        };
        yield {
          type: "assistant",
          message: { id: "m", role: "assistant", content: [{ type: "text", text: "…" }] },
          parent_tool_use_id: null,
          uuid: "u",
          session_id: "ext-err",
        };
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          is_error: false,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          session_id: "ext-err",
          usage: {},
          total_cost_usd: 0,
        };
      } as unknown as NonNullable<ClaudeAdapterDeps["query"]>,
      spawn: () => handle,
      killTree: (async () => ({
        pid: 5001,
        method: "taskkill" as const,
        alreadyGone: false,
      })) as unknown as NonNullable<ClaudeAdapterDeps["killTree"]>,
      now: () => OCCURRED_AT,
      newId: () => "proc-err",
    };
    const adapter = createClaudeAdapter(CFG, deps);
    await adapter.spawn(
      { sessionId: "session-err", message: "任务", autonomy: "read_only", model: null },
      collect(events),
    );
    exit.resolve(
      Object.freeze({
        pid: 5001,
        code: 3,
        signal: null,
        killedByUs: false,
        exitedAt: OCCURRED_AT,
      }),
    );
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("error"));
    const { statuses, rejected } = fold(events);
    expect(statuses).toEqual(["ready", "ready", "running", "error"]);
    expect(rejected).toBe(0);
  });
});
