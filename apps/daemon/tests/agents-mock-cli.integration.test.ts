// agents 服务 × mock CLI × 真实 SDK 集成（P0-11 验收口径）：
// 经组装根 agentCliPath 注入缝指 fixtures/aether-mock-cli 平台包装器（win32=cli.cmd /
// POSIX=cli.sh），AETHER_MOCK_SCRIPT 选 fixture；adapter 用真实 claude-sdk（spawn/控制协议全真）。
// 断言全链：spawn → session.<id>.events 归一化事件 → 状态机到 stopped → agent.status 推送 →
// 进程行终局 → sessions.listEvents 重放 → followUp 第二轮 → permission_request 应答贯通。
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { STATIC_TOPIC, sessionEventsTopic, sessionStateTopic } from "@aether/contracts";
import type { ProviderEvent } from "@aether/contracts";
import { AgentProfileRepository, ProjectRepository, TaskRepository } from "@aether/storage";
import { createDaemonAssembly, type DaemonAssembly } from "../src/assembly/assembly.js";

const MOCK_CLI_DIR = fileURLToPath(new URL("../../../fixtures/aether-mock-cli/", import.meta.url));
const WRAPPER = join(MOCK_CLI_DIR, process.platform === "win32" ? "cli.cmd" : "cli.sh");
const FIXTURES_DIR = join(MOCK_CLI_DIR, "fixtures");

interface Envelope {
  readonly topic: string;
  readonly payload: Record<string, unknown>;
  readonly seq: number;
}

describe("agents 全链集成（mock CLI × 真实 SDK × 组装根）", () => {
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
    // mock CLI 经 process.env 传播到子进程（adapter env = {...process.env, ...ctx.env}）
    previousMockScript = process.env["AETHER_MOCK_SCRIPT"];
    process.env["AETHER_MOCK_SCRIPT"] = join(FIXTURES_DIR, "happy-path.json");

    baseDir = mkdtempSync(join(tmpdir(), `aether-agents-it-${randomUUID().slice(0, 8)}-`));
    projectRoot = join(baseDir, "project");
    mkdirSync(projectRoot);
    git(["init"]);
    git(["config", "user.email", "aether@test.local"]);
    git(["config", "user.name", "Aether Test"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(projectRoot, "README.md"), "# agents integration fixture\n");
    git(["add", "-A"]);
    git(["commit", "-m", "init"]);
    git(["branch", "-m", "main"]);

    assembly = createDaemonAssembly({
      dbPath: ":memory:",
      agentCliPath: WRAPPER,
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
  function seedTask(): { taskId: string; profileId: string } {
    const projects = new ProjectRepository(assembly.db);
    const tasks = new TaskRepository(assembly.db);
    const profiles = new AgentProfileRepository(assembly.db);
    const existing = projects.findAll()[0];
    const project = existing ?? projects.create({ name: "集成项目", rootPath: projectRoot });
    const task = tasks.create({ projectId: project.id, title: "集成任务" });
    const profileId = profiles.findAll()[0]?.id ?? "";
    return { taskId: task.id, profileId };
  }

  const statusesOf = (sessionId: string): string[] =>
    envelopes
      .filter((e) => e.topic === STATIC_TOPIC.agentStatus && e.payload["sessionId"] === sessionId)
      .map((e) => String(e.payload["status"]));

  const eventsOf = (sessionId: string): ProviderEvent[] =>
    envelopes
      .filter((e) => e.topic === sessionEventsTopic(sessionId))
      .map((e) => e.payload as unknown as ProviderEvent);

  it(
    "spawn 全链：worktree 缺省创建 → 事件流/状态机/投影 → stopped → 进程行 exited",
    { timeout: 120_000 },
    async () => {
      const seeded = seedTask();
      const handle = await assembly.agents.spawn({
        taskId: seeded.taskId,
        agentProfileId: seeded.profileId,
        prompt: "跑一遍完整旅程",
        autonomy: "workspace_write",
      });
      const sessionId = handle.sessionId;

      await vi.waitFor(() => expect(statusesOf(sessionId).at(-1)).toBe("stopped"), {
        timeout: 60_000,
      });

      // 归一化事件流（happy-path：session/status/message/tool_use/tool_result/session）
      expect(eventsOf(sessionId).map((event) => event.type)).toEqual([
        "session",
        "status",
        "message",
        "tool_use",
        "tool_result",
        "session",
      ]);

      // 状态机轨迹（§8.1）：starting（初始点）→ ready → running → stopped
      expect(statusesOf(sessionId)).toEqual(["starting", "ready", "running", "stopped"]);
      const states = envelopes
        .filter((e) => e.topic === sessionStateTopic(sessionId))
        .map((e) => {
          const payload = e.payload as { previous: string; status: string };
          return `${payload.previous}→${payload.status}`;
        });
      expect(states).toEqual(["starting→ready", "ready→running", "running→stopped"]);

      // session 行与进程行终局（退出证明：exitCode 0 → exited）
      // 注：进程行回写经微任务，终态事件后一拍到达——waitFor 覆盖
      await vi.waitFor(
        () => {
          const rows = assembly.db
            .prepare("SELECT status, exit_code FROM execution_process WHERE session_id = ?")
            .all(sessionId) as { status: string; exit_code: number | null }[];
          expect(rows).toHaveLength(1);
          expect(rows[0]?.status).toBe("exited");
          expect(rows[0]?.exit_code).toBe(0);
        },
        { timeout: 15_000 },
      );

      // workspace 缺省创建投影 + task.updated 投影（payload 指向本任务）
      expect(
        envelopes.some(
          (e) =>
            e.topic === STATIC_TOPIC.workspaceStatus &&
            e.payload["workspaceId"] === handle.workspaceId,
        ),
      ).toBe(true);
      expect(
        envelopes.some(
          (e) =>
            e.topic === STATIC_TOPIC.taskUpdated &&
            (e.payload["task"] as { id?: string } | undefined)?.id === seeded.taskId,
        ),
      ).toBe(true);

      // sessions.listEvents：执行日志重放归并（含归属修正）
      const replayed = assembly.agents.listSessionEvents(sessionId);
      expect(replayed.map((event) => event.type)).toEqual([
        "session",
        "status",
        "message",
        "tool_use",
        "tool_result",
        "session",
      ]);
      expect(replayed.every((event) => event.sessionId === sessionId)).toBe(true);
    },
  );

  it(
    "followUp 第二轮：换 follow-up.json 回放 → 新 follow_up 进程行 + 事件续流",
    { timeout: 120_000 },
    async () => {
      const seeded = seedTask();
      const handle = await assembly.agents.spawn({
        taskId: seeded.taskId,
        agentProfileId: seeded.profileId,
        prompt: "第一轮",
        autonomy: "workspace_write",
      });
      const sessionId = handle.sessionId;
      await vi.waitFor(() => expect(statusesOf(sessionId).at(-1)).toBe("stopped"), {
        timeout: 60_000,
      });

      // 自然完成后注册表保留：追问可达（任务卡定案）
      process.env["AETHER_MOCK_SCRIPT"] = join(FIXTURES_DIR, "follow-up.json");
      const second = await assembly.agents.followUp({ sessionId, message: "接着说" });
      expect(second.sessionId).toBe(sessionId);
      await vi.waitFor(
        () => {
          const stream = eventsOf(sessionId);
          // 第二轮 6+3 事件后再到终态
          expect(stream.at(-1)?.type).toBe("session");
          expect(stream.length).toBeGreaterThanOrEqual(9);
        },
        { timeout: 60_000 },
      );

      // 进程行：coding_agent + follow_up 各一行，均归 kind claude-sdk
      const rows = assembly.db
        .prepare(
          "SELECT run_reason, command_json FROM execution_process WHERE session_id = ? ORDER BY rowid",
        )
        .all(sessionId) as { run_reason: string; command_json: string }[];
      expect(rows.map((row) => row.run_reason)).toEqual(["coding_agent", "follow_up"]);
      expect(rows.every((row) => JSON.parse(row.command_json).kind === "claude-sdk")).toBe(true);

      // listEvents 跨两轮合并（时间序）
      const replayed = assembly.agents.listSessionEvents(sessionId);
      expect(replayed.length).toBeGreaterThanOrEqual(9);
    },
  );

  it(
    "permission-ask：waiting → respondPermission(approve) → running → stopped（行 id 口径）",
    { timeout: 120_000 },
    async () => {
      process.env["AETHER_MOCK_SCRIPT"] = join(FIXTURES_DIR, "permission-ask.json");
      const seeded = seedTask();
      const handle = await assembly.agents.spawn({
        taskId: seeded.taskId,
        agentProfileId: seeded.profileId,
        prompt: "触发权限请求",
        autonomy: "read_only",
      });
      const sessionId = handle.sessionId;

      await vi.waitFor(
        () => expect(eventsOf(sessionId).some((event) => event.type === "permission_request")),
        { timeout: 60_000 },
      );
      // 事件帧（②）与状态投影（③）同栈发布；waitFor 口径直接对齐目标状态，消除轮询时序毛刺
      await vi.waitFor(() => expect(statusesOf(sessionId)).toContain("waiting"), {
        timeout: 30_000,
      });

      // UI 侧 processId = execution_process 行 id（注册表双口径命中）
      const rowId = (
        assembly.db
          .prepare("SELECT id FROM execution_process WHERE session_id = ?")
          .all(sessionId) as { id: string }[]
      )[0]?.id;
      expect(rowId).toBeDefined();
      await assembly.agents.respondPermission({
        processId: rowId ?? "",
        requestId: "req-mock-perm",
        decision: "approve",
      });

      await vi.waitFor(() => expect(statusesOf(sessionId).at(-1)).toBe("stopped"), {
        timeout: 60_000,
      });
      // 批准后回到 running 并收到决策回显消息
      expect(statusesOf(sessionId)).toContain("running");
      expect(
        eventsOf(sessionId).some(
          (event) => event.type === "message" && event.content === "决策:allow",
        ),
      ).toBe(true);
    },
  );

  it("cancel/错误路径：未知 taskId → ServiceError invalid_params 中文", async () => {
    process.env["AETHER_MOCK_SCRIPT"] = join(FIXTURES_DIR, "happy-path.json");
    const seeded = seedTask();
    await expect(
      assembly.agents.spawn({
        taskId: "no-such-task",
        agentProfileId: seeded.profileId,
        prompt: "x",
      }),
    ).rejects.toThrow(/未知任务/);
  });
});
