// agents 服务 × codex mock 引擎 × 组装根集成（P1-01 双线合流验收口径）：
// 经 providerKindOverride 注入缝把默认种子 profile 的 claude-sdk 路由覆盖为
// codex-app-server，agentCliPath 指 fixtures/aether-mock-cli 的 codex-server 平台
// 包装器（win32=codex-server.cmd / POSIX=codex-server.sh），AETHER_MOCK_SCRIPT 选
// protocol=codex-app-server 的 fixture（有状态 app-server 协议模拟器）。
// 断言全链（协议定案 docs/research/codex/app-server-protocol.md）：
// spawn → thread/start（session 事件 externalSessionId=threadId）→ turn/started
// （running）→ item 事件流 → 审批服务端请求（permission_request）→ respondPermission
// approve → {id,result:{decision:"accept"}} 应答（§4）→ 回放续跑 → turn/completed →
// followUp（thread/resume 重载 + 新 turn）→ cancel（stdin EOF → 退出证明 → stopped）。
// 与 claude 线的关键差异（长活服务端）：turn/completed 不发终态，会话终态由
// cancel 后的进程退出证明物化（adapter 排序契约）。
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { STATIC_TOPIC, sessionEventsTopic } from "@aether/contracts";
import type { ProviderEvent } from "@aether/contracts";
import { ProjectRepository, TaskRepository } from "@aether/storage";
import { createDaemonAssembly, type DaemonAssembly } from "../src/assembly/assembly.js";

const MOCK_CLI_DIR = fileURLToPath(new URL("../../../fixtures/aether-mock-cli/", import.meta.url));
const WRAPPER = join(
  MOCK_CLI_DIR,
  process.platform === "win32" ? "codex-server.cmd" : "codex-server.sh",
);
const FIXTURES_DIR = join(MOCK_CLI_DIR, "fixtures");

interface Envelope {
  readonly topic: string;
  readonly payload: Record<string, unknown>;
  readonly seq: number;
}

describe("agents 全链集成（codex mock 引擎 × 组装根 providerKindOverride）", () => {
  let assembly: DaemonAssembly;
  let baseDir: string;
  let projectRoot: string;
  let envelopes: Envelope[];
  let previousMockScript: string | undefined;

  const git = (args: readonly string[]): string =>
    execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", windowsHide: true }).trim();

  beforeAll(() => {
    if (process.platform !== "win32") {
      chmodSync(WRAPPER, 0o755);
    }
    // codex 引擎经 process.env 传播到子进程（adapter spawn env = {...process.env, ...ctx.env}）
    previousMockScript = process.env["AETHER_MOCK_SCRIPT"];
    process.env["AETHER_MOCK_SCRIPT"] = join(FIXTURES_DIR, "codex-happy-path.json");

    baseDir = mkdtempSync(join(tmpdir(), `aether-codex-it-${randomUUID().slice(0, 8)}-`));
    projectRoot = join(baseDir, "project");
    mkdirSync(projectRoot);
    git(["init"]);
    git(["config", "user.email", "aether@test.local"]);
    git(["config", "user.name", "Aether Test"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(projectRoot, "README.md"), "# codex integration fixture\n");
    git(["add", "-A"]);
    git(["commit", "-m", "init"]);
    git(["branch", "-m", "main"]);

    assembly = createDaemonAssembly({
      dbPath: ":memory:",
      agentCliPath: WRAPPER,
      providerKindOverride: "codex-app-server",
      worktreeFallbackDir: join(baseDir, "fallback"),
    });
    envelopes = [];
    assembly.eventBus.addListener((frame) => {
      const notification = JSON.parse(frame) as {
        method: string;
        params: { topic: string; payload: Record<string, unknown>; seq: number };
      };
      if (notification.method === "event") {
        envelopes.push(notification.params);
      }
    });
  });

  afterAll(async () => {
    await assembly.close().catch(() => undefined);
    if (previousMockScript === undefined) {
      delete process.env["AETHER_MOCK_SCRIPT"];
    } else {
      process.env["AETHER_MOCK_SCRIPT"] = previousMockScript;
    }
    rmSync(baseDir, { recursive: true, force: true });
  });

  /** 项目 rootPath 是唯一身份：整文件一个共享项目（真 git 根），每用例只建任务行。 */
  function seedTask(): string {
    const projects = new ProjectRepository(assembly.db);
    const tasks = new TaskRepository(assembly.db);
    const existing = projects.findAll()[0];
    const project = existing ?? projects.create({ name: "codex 集成项目", rootPath: projectRoot });
    return tasks.create({ projectId: project.id, title: "codex 集成任务" }).id;
  }

  const statusesOf = (sessionId: string): string[] =>
    envelopes
      .filter((e) => e.topic === STATIC_TOPIC.agentStatus && e.payload["sessionId"] === sessionId)
      .map((e) => String(e.payload["status"]));

  const eventsOf = (sessionId: string): ProviderEvent[] =>
    envelopes
      .filter((e) => e.topic === sessionEventsTopic(sessionId))
      .map((e) => e.payload as unknown as ProviderEvent);

  const commandJsonKinds = (target: DaemonAssembly, sessionId: string): string[] =>
    (
      target.db
        .prepare("SELECT command_json FROM execution_process WHERE session_id = ? ORDER BY rowid")
        .all(sessionId) as { command_json: string }[]
    ).map((row) => (JSON.parse(row.command_json) as { kind: string }).kind);

  const processRowCount = (target: DaemonAssembly, sessionId: string): number =>
    (
      target.db
        .prepare("SELECT COUNT(*) AS n FROM execution_process WHERE session_id = ?")
        .get(sessionId) as { n: number }
    ).n;

  it(
    "codex 全链：spawn → thread/turn 事件流 → 审批 approve（{decision:accept}）→ followUp 同 thread 新 turn → cancel 退出证明终态",
    { timeout: 120_000 },
    async () => {
      const taskId = seedTask();
      const handle = await assembly.agents.spawn({
        taskId,
        prompt: "跑一遍 codex 完整旅程",
        autonomy: "workspace_write",
      });
      const sessionId = handle.sessionId;

      // ① 审批服务端请求 → permission_request（requestId=itemId；摘要来自 params.call）
      await vi.waitFor(
        () =>
          expect(eventsOf(sessionId).some((event) => event.type === "permission_request")).toBe(
            true,
          ),
        { timeout: 60_000 },
      );
      const request = eventsOf(sessionId).find((event) => event.type === "permission_request");
      expect(request).toMatchObject({
        toolName: "commandExecution",
        summary: "命令：echo aether",
      });
      await vi.waitFor(() => expect(statusesOf(sessionId)).toContain("waiting"), {
        timeout: 30_000,
      });

      // ② session 事件携带 threadId（externalSessionId=thread-1：恢复素材锚点）
      const sessionEvent = eventsOf(sessionId).find(
        (event): event is Extract<ProviderEvent, { type: "session" }> => event.type === "session",
      );
      expect(sessionEvent?.externalSessionId).toBe("thread-1");

      // ③ approve → {id,result:{decision:"accept"}} 应答（§4，双线对账口径）→ 回放续跑
      //    → commandExecution tool_result + 完成 message + turn/completed（不发终态）
      await assembly.agents.respondPermission({
        requestId: String((request as { requestId?: unknown } | undefined)?.requestId ?? "item-2"),
        decision: "approve",
      });
      await vi.waitFor(
        () =>
          expect(
            eventsOf(sessionId).some(
              (event) => event.type === "message" && event.content === "mock：任务完成",
            ),
          ).toBe(true),
        { timeout: 60_000 },
      );
      const toolResult = eventsOf(sessionId).find((event) => event.type === "tool_result");
      expect(toolResult).toMatchObject({ isError: false });

      // ④ 状态轨迹：starting → ready（session）→ running（turn/started+message）→
      //    waiting（审批）→ running（应答后续流）；codex 长活服务端：无 stopped（终态归退出证明）
      const statuses = statusesOf(sessionId);
      expect(statuses[0]).toBe("starting");
      expect(statuses).toContain("ready");
      expect(statuses).toContain("running");
      expect(statuses).toContain("waiting");
      expect(statuses.at(-1)).toBe("running");

      // ⑤ followUp：同 thread 新 turn（unload 即 resume 重载；fixture turns 耗尽 → 缺省
      //    turn 回放 "mock：turn 完成"）→ message 续流；进程行两行均归 codex kind
      await assembly.agents.followUp({ sessionId, message: "继续下一步" });
      await vi.waitFor(
        () =>
          expect(
            eventsOf(sessionId).some(
              (event) => event.type === "message" && event.content === "mock：turn 完成",
            ),
          ).toBe(true),
        { timeout: 60_000 },
      );
      expect(commandJsonKinds(assembly, sessionId)).toEqual([
        "codex-app-server",
        "codex-app-server",
      ]);

      // ⑥ cancel：stdin EOF → 引擎干净退出（exitCode 0）→ 退出证明物化 session 终态
      //    → stopped；进程行 killed（取消口径）
      await assembly.agents.cancel({ sessionId });
      await vi.waitFor(() => expect(statusesOf(sessionId).at(-1)).toBe("stopped"), {
        timeout: 60_000,
      });
      await vi.waitFor(
        () => {
          const rows = assembly.db
            .prepare("SELECT status FROM execution_process WHERE session_id = ?")
            .all(sessionId) as { status: string }[];
          expect(rows[0]?.status).toBe("killed");
        },
        { timeout: 15_000 },
      );

      // ⑦ sessions.listEvents：执行日志重放归并（归一化事件透传路径 + kind 分发不回归）
      const replayed = assembly.agents.listSessionEvents(sessionId);
      expect(replayed.length).toBeGreaterThan(0);
      expect(replayed.every((event) => event.sessionId === sessionId)).toBe(true);
      expect(replayed.map((event) => event.type)).toContain("permission_request");
    },
  );

  it(
    "providerKind 显式入参路由（P1-01 评审 F2）：无 env 覆盖缝时 spawn 载荷真拉起 codex 引擎",
    { timeout: 120_000 },
    async () => {
      // 独立组装根：不设 providerKindOverride（默认种子 profile 是 claude-sdk）——
      // codex 引擎被拉起只能归因于 agents.spawn 显式 providerKind 入参
      const local = createDaemonAssembly({
        dbPath: ":memory:",
        agentCliPath: WRAPPER,
        worktreeFallbackDir: join(baseDir, "fallback-f2"),
      });
      const localEnvelopes: Envelope[] = [];
      local.eventBus.addListener((frame) => {
        const notification = JSON.parse(frame) as {
          method: string;
          params: { topic: string; payload: Record<string, unknown>; seq: number };
        };
        if (notification.method === "event") {
          localEnvelopes.push(notification.params);
        }
      });
      try {
        const projects = new ProjectRepository(local.db);
        const tasks = new TaskRepository(local.db);
        const project = projects.create({ name: "codex F2 路由项目", rootPath: projectRoot });
        const taskId = tasks.create({ projectId: project.id, title: "codex F2 路由任务" }).id;

        // 非法 kind（值域内但未注册）：invalidParams 且不建会话行
        const sessionsBefore = localEnvelopes.length;
        await expect(
          local.agents.spawn({ taskId, prompt: "x", providerKind: "acp" }),
        ).rejects.toThrow(/未注册的 provider kind/);
        expect(localEnvelopes.length).toBe(sessionsBefore);

        // 显式 providerKind=codex-app-server：session 事件 externalSessionId=thread-1
        // （codex 引擎的 thread 命名）= codex 适配器真被路由的直接证据
        const handle = await local.agents.spawn({
          taskId,
          prompt: "显式路由到 codex",
          providerKind: "codex-app-server",
          autonomy: "workspace_write",
        });
        const sessionId = handle.sessionId;
        await vi.waitFor(
          () => {
            const sessionEvent = localEnvelopes
              .filter((e) => e.topic === sessionEventsTopic(sessionId))
              .map((e) => e.payload as unknown as ProviderEvent)
              .find((event) => event.type === "session");
            expect(sessionEvent).toMatchObject({ externalSessionId: "thread-1" });
          },
          { timeout: 60_000 },
        );
        expect(commandJsonKinds(local, sessionId)).toEqual(["codex-app-server"]);

        await local.agents.cancel({ sessionId });
      } finally {
        await local.close().catch(() => undefined);
      }
    },
  );

  it(
    "waiting 态 followUp 立即拒绝（P1-01 评审 F4）：可行动文案 + 不建 follow_up 进程行",
    { timeout: 120_000 },
    async () => {
      const taskId = seedTask();
      const handle = await assembly.agents.spawn({
        taskId,
        prompt: "触发审批挂起后追问",
        autonomy: "workspace_write",
      });
      const sessionId = handle.sessionId;
      try {
        await vi.waitFor(() => expect(statusesOf(sessionId)).toContain("waiting"), {
          timeout: 60_000,
        });
        const rowsBefore = processRowCount(assembly, sessionId);
        await expect(
          assembly.agents.followUp({ sessionId, message: "趁审批挂着追问" }),
        ).rejects.toThrow(/请先应答权限请求/);
        expect(processRowCount(assembly, sessionId)).toBe(rowsBefore); // 无 follow_up 行

        // 解锁收尾：approve → 完成 → cancel（会话不留 waiting 挂起）
        const request = eventsOf(sessionId).find((event) => event.type === "permission_request");
        const requestId = String((request as { requestId?: unknown } | undefined)?.requestId ?? "");
        await assembly.agents.respondPermission({ requestId, decision: "approve" });
        await assembly.agents.cancel({ sessionId });
      } catch (error) {
        await assembly.agents.cancel({ sessionId }).catch(() => undefined);
        throw error;
      }
    },
  );
});
