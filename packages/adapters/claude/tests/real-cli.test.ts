import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext, AgentProcess, ResolvedProviderConfig } from "@aether/core";
import { killTree, spawnCommand } from "@aether/process-host";
import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeAdapter } from "../src/adapter.js";
import type { ClaudeAdapterDeps } from "../src/adapter.js";

// ===== 真实 CLI 集成测试（CI 默认跳过）=====
// 运行条件：本机已安装可用凭证（ANTHROPIC_API_KEY 或 claude 登录态），并设置：
//   AETHER_TEST_REAL_CLI=1
// 真实 query() 完成一个微任务：消耗护栏 = maxTurns:2（Options.maxTurns 硬性轮次上限，
// 成本护栏落在 flag 而非提示词——§8.2『prompt 约束不可靠』）+ read_only（plan 模式）。
// SDK/CLI 形状依据 @anthropic-ai/claude-agent-sdk@0.3.325（内置 CLI 2.1.325）。

const CFG: ResolvedProviderConfig = {
  kind: "claude-sdk",
  providerConfigId: "pc-real",
  displayName: "Claude (real)",
  config: { maxTurns: 2 },
};

const workdirs: string[] = [];

afterAll(async () => {
  for (const dir of workdirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function realDeps(): ClaudeAdapterDeps {
  return { query: realQuery, spawn: spawnCommand, killTree, newId: () => crypto.randomUUID() };
}

function makeCtx(events: unknown[], worktreePath: string): AdapterContext {
  return {
    emit: (ev) => {
      events.push(ev);
    },
    worktreePath,
    env: {},
    loadEvents: async () => [],
  };
}

function types(events: unknown[]): string[] {
  return events.map((ev) => (ev as { type: string }).type);
}

describe.skipIf(!process.env.AETHER_TEST_REAL_CLI)(
  "真实 CLI 集成（AETHER_TEST_REAL_CLI=1）",
  () => {
    it("discover 探测到内置 CLI 版本", { timeout: 60_000 }, async () => {
      const adapter = createClaudeAdapter(CFG, realDeps());
      const result = await adapter.discover();
      expect(result.available).toBe(true);
      expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it(
      "微任务全旅程：spawn → message + result → sessionId → follow-up resume 接续 → 退出证明",
      { timeout: 180_000 },
      async () => {
        const adapter = createClaudeAdapter(CFG, realDeps());
        const workdir = await mkdtemp(join(tmpdir(), "aether-real-cli-"));
        workdirs.push(workdir);
        const events: unknown[] = [];

        const proc: AgentProcess = await adapter.spawn(
          {
            sessionId: "session-real-1",
            message: "请只回复两个字符：ok。不要调用任何工具。",
            autonomy: "read_only",
            model: null,
          },
          makeCtx(events, workdir),
        );
        const exitProof = await proc.exited;
        expect(typeof proc.pid).toBe("number");
        expect([0, 1]).toContain(exitProof.code === null ? 0 : exitProof.code);

        await vi.waitFor(() => {
          expect(types(events)).toContain("message");
          expect(types(events)).toContain("session");
        });
        const sessionId = (types(events).at(-1) === "session" ? events.at(-1) : undefined) as
          | { externalSessionId: string | null }
          | undefined;
        const externalSessionId =
          sessionId?.externalSessionId ??
          (
            events.find(
              (ev) =>
                (ev as { type: string }).type === "session" &&
                (ev as { externalSessionId: string | null }).externalSessionId !== null,
            ) as { externalSessionId: string | null } | undefined
          )?.externalSessionId;
        expect(externalSessionId).toBeTruthy();

        // follow-up：--resume 接续同一外部会话（真实 CLI 冷启动需数秒，
        // waitFor 默认 1s 不够——显式放宽）
        const followUpEvents: unknown[] = [];
        await adapter.spawnFollowUp(
          proc,
          { message: "请再只回复两个字符：ok。" },
          makeCtx(followUpEvents, workdir),
        );
        await vi.waitFor(
          () => {
            expect(types(followUpEvents)).toContain("message");
          },
          { timeout: 120_000, interval: 500 },
        );
        const followUpSession = followUpEvents.find(
          (ev) =>
            (ev as { type: string }).type === "session" &&
            (ev as { externalSessionId: string | null }).externalSessionId !== null,
        ) as { externalSessionId: string | null } | undefined;
        expect(followUpSession?.externalSessionId).toBe(externalSessionId);

        await adapter.dispose();
      },
    );
  },
);
