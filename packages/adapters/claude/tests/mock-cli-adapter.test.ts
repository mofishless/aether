import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterContext, ResolvedProviderConfig } from "@aether/core";
import { INITIAL_AGENT_STATUS, applySessionEvent } from "@aether/core";
import type { AgentStatus, ProviderEvent } from "@aether/contracts";
import { killTree, spawnCommand } from "@aether/process-host";
import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeAdapter } from "../src/adapter.js";
import type { ClaudeAdapterDeps } from "../src/adapter.js";

// ===== mock CLI × 真实 SDK 集成（P0-07b 验收：无真实 CLI、无网络的完整任务旅程）=====
// 经 createClaudeAdapter 的 config.cliPath 指向 fixtures/aether-mock-cli 平台包装器
// （win32=cli.cmd，走 process-host 的 .cmd 安全转义——P0-06 路径端到端复验），
// ctx.env.AETHER_MOCK_SCRIPT 选择 fixture；query 用真实 SDK（spawn/prompt/控制协议全真），
// 只有 CLI 可执行文件是 script 化回放。事件流经 core applySessionEvent fold 驱动状态机。

const MOCK_CLI_DIR = fileURLToPath(
  new URL("../../../../fixtures/aether-mock-cli/", import.meta.url),
);
const WRAPPER = join(MOCK_CLI_DIR, process.platform === "win32" ? "cli.cmd" : "cli.sh");
const FIXTURES_DIR = join(MOCK_CLI_DIR, "fixtures");

const OCCURRED_AT = "2026-01-01T00:00:00Z";

const CFG: ResolvedProviderConfig = {
  kind: "claude-sdk",
  providerConfigId: "pc-mock",
  displayName: "Claude (mock)",
  config: { cliPath: WRAPPER },
};

/** 真实旅程依赖：query/spawn/killTree 全真，仅 CLI 本体是 mock 回放 */
function realJourneyDeps(): ClaudeAdapterDeps {
  let seq = 0;
  return {
    query: realQuery,
    spawn: spawnCommand,
    killTree,
    now: () => OCCURRED_AT,
    newId: () => `proc-mock-${++seq}`,
  };
}

const workdirs: string[] = [];

beforeAll(() => {
  if (process.platform !== "win32") {
    chmodSync(WRAPPER, 0o755);
  }
});

afterAll(async () => {
  for (const dir of workdirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function newWorkdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aether-mock-cli-adapter-"));
  workdirs.push(dir);
  return dir;
}

function makeCtx(
  events: ProviderEvent[],
  scriptName: string,
  worktreePath: string,
): AdapterContext {
  return {
    emit: (ev) => {
      events.push(ev);
    },
    worktreePath,
    env: { AETHER_MOCK_SCRIPT: join(FIXTURES_DIR, scriptName) },
    loadEvents: async () => [],
  };
}

const typeSeq = (events: readonly ProviderEvent[]): string[] => events.map((event) => event.type);

const findMessage = (events: readonly ProviderEvent[]): string | null => {
  const message = events.find((event) => event.type === "message");
  return message !== undefined && message.type === "message" ? message.content : null;
};

/** fold：(初始状态, 事件序列) → 应用轨迹（applied 目标状态序列 + rejected 计数） */
function fold(events: readonly ProviderEvent[]): { statuses: AgentStatus[]; rejected: number } {
  let current = INITIAL_AGENT_STATUS;
  const statuses: AgentStatus[] = [];
  let rejected = 0;
  for (const event of events) {
    const result = applySessionEvent(current, event);
    if (result.transition === "applied") {
      current = result.status;
      statuses.push(result.status);
    } else {
      rejected += 1;
    }
  }
  return { statuses, rejected };
}

describe("mock CLI × 真实 SDK：全旅程（事件序列 + 状态机 + 退出证明）", () => {
  it(
    "happy-path.json：init→assistant→tool_use→tool_result→result + ExitProof code 0 + starting→ready→running→stopped",
    { timeout: 120_000 },
    async () => {
      const events: ProviderEvent[] = [];
      const adapter = createClaudeAdapter(CFG, realJourneyDeps());
      const proc = await adapter.spawn(
        {
          sessionId: "session-mock-1",
          message: "用 mock CLI 跑一遍完整旅程",
          autonomy: "workspace_write",
          model: null,
        },
        makeCtx(events, "happy-path.json", await newWorkdir()),
      );

      const exit = await proc.exited;
      expect(exit.code).toBe(0);
      expect(typeof proc.pid).toBe("number");
      await vi.waitFor(() => expect(typeSeq(events).at(-1)).toBe("session"), { timeout: 30_000 });

      expect(typeSeq(events)).toEqual([
        "session",
        "status",
        "message",
        "tool_use",
        "tool_result",
        "session",
      ]);
      const end = events.at(-1);
      expect(end?.type === "session" ? end.externalSessionId : null).toBe("ext-mock-happy");

      const { statuses, rejected } = fold(events);
      expect(statuses).toEqual(["ready", "ready", "running", "running", "running", "stopped"]);
      expect(rejected).toBe(0);
    },
  );

  it(
    "follow-up：第二轮 spawn argv 携带 --resume ext-mock-happy（$MOCK_ARGV 回显进 assistant 文本）",
    { timeout: 120_000 },
    async () => {
      const round1: ProviderEvent[] = [];
      const round2: ProviderEvent[] = [];
      const adapter = createClaudeAdapter(CFG, realJourneyDeps());
      const workdir = await newWorkdir();
      const proc = await adapter.spawn(
        {
          sessionId: "session-mock-2",
          message: "第一轮",
          autonomy: "workspace_write",
          model: null,
        },
        makeCtx(round1, "happy-path.json", workdir),
      );
      const exit1 = await proc.exited;
      expect(exit1.code).toBe(0);
      await vi.waitFor(() => expect(typeSeq(round1).at(-1)).toBe("session"), { timeout: 30_000 });

      // follow-up：mock CLI 无状态，换 follow-up.json 回放（init 帧复用同一 externalSessionId）
      await adapter.spawnFollowUp(
        proc,
        { message: "接着说" },
        makeCtx(round2, "follow-up.json", workdir),
      );
      await vi.waitFor(() => expect(typeSeq(round2).at(-1)).toBe("session"), { timeout: 30_000 });

      const echoed = findMessage(round2);
      expect(echoed).not.toBeNull();
      expect(echoed ?? "").toContain("--resume");
      expect(echoed ?? "").toContain("ext-mock-happy");
      const end = round2.at(-1);
      expect(end?.type === "session" ? end.externalSessionId : null).toBe("ext-mock-happy");

      const { statuses, rejected } = fold(round2);
      expect(statuses).toEqual(["ready", "ready", "running", "stopped"]);
      expect(rejected).toBe(0);
    },
  );

  it(
    "permission-ask.json：canUseTool 桥真实往返 → waiting→running（resolvePermission 贯通到 mock CLI）",
    { timeout: 120_000 },
    async () => {
      const events: ProviderEvent[] = [];
      const adapter = createClaudeAdapter(CFG, realJourneyDeps());
      const proc = await adapter.spawn(
        {
          sessionId: "session-mock-3",
          message: "触发一次权限请求",
          autonomy: "read_only",
          model: null,
        },
        makeCtx(events, "permission-ask.json", await newWorkdir()),
      );

      await vi.waitFor(() => expect(typeSeq(events)).toContain("permission_request"), {
        timeout: 30_000,
      });
      const request = events.find((event) => event.type === "permission_request");
      expect(request?.type === "permission_request" ? request.requestId : null).toBe(
        "req-mock-perm",
      );
      expect(fold(events).statuses).toContain("waiting");

      await adapter.resolvePermission(proc.processId, "req-mock-perm", "approve");
      const exit = await proc.exited;
      expect(exit.code).toBe(0);
      await vi.waitFor(() => expect(typeSeq(events).at(-1)).toBe("session"), { timeout: 30_000 });

      expect(findMessage(events)).toBe("决策:allow");
      const { statuses, rejected } = fold(events);
      expect(statuses).toEqual(["ready", "ready", "waiting", "running", "stopped"]);
      expect(rejected).toBe(0);
    },
  );

  it(
    "error-exit.json：非零退出（code 3）压过 result 自报 → 终态 error（排序契约）",
    { timeout: 120_000 },
    async () => {
      const events: ProviderEvent[] = [];
      const adapter = createClaudeAdapter(CFG, realJourneyDeps());
      const proc = await adapter.spawn(
        {
          sessionId: "session-mock-4",
          message: "非零退出路径",
          autonomy: "read_only",
          model: null,
        },
        makeCtx(events, "error-exit.json", await newWorkdir()),
      );

      const exit = await proc.exited;
      expect(exit.code).toBe(3);
      await vi.waitFor(() => expect(typeSeq(events).at(-1)).toBe("error"), { timeout: 30_000 });
      const last = events.at(-1);
      expect(last?.type === "error" ? last.message : "").toContain("3");

      const { statuses } = fold(events);
      expect(statuses.at(-1)).toBe("error");
    },
  );
});
