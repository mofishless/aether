// P0-11 新方法组路由测试：subscribe cursor 重放（按 topic 过滤 + 有序回推 + 水位正确）、
// projects/tasks RPC（真实 CatalogService + 内存库）、diff.workspaceDiff（注入比对假件）、
// 未装配 deps → METHOD_NOT_FOUND（照 terminals.* 骨架定案）。
// 响应帧均以 contracts strict schema 断言（wire 边界 fail-closed）。
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  JSON_RPC_ERROR_CODES,
  JsonRpcErrorResponseSchema,
  JsonRpcSuccessResponseSchema,
  PROTOCOL_VERSION,
  STATIC_TOPIC,
  TaskUpdatedPayloadSchema,
  terminalOutputTopic,
} from "@aether/contracts";
import type { DiffFile, Project, Task } from "@aether/contracts";
import { ExecutionLogSink, WorktreeLifecycleService } from "@aether/core";
import {
  AgentProfileRepository,
  ExecutionProcessLogRepository,
  ExecutionProcessRepository,
  ProjectRepository,
  ProviderConfigRepository,
  SessionRepository,
  TaskRepository,
  WorkspaceRepository,
  closeDatabase,
  openStorage,
} from "@aether/storage";
import { AgentService } from "../src/agents/agents-service.js";
import { CatalogService } from "../src/catalog/catalog-service.js";
import { DiffService } from "../src/diff/diff-service.js";
import { createEventBus } from "../src/events/event-bus.js";
import { AgentsSpawnParamsSchema, AgentsPermissionRespondParamsSchema } from "../src/rpc/agents.js";
import { routeMessage, type RouterDeps } from "../src/rpc/router.js";

function request(method: string, params?: unknown, id: number | string = 1): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  });
}

function successOf(outcome: { kind: string; frame?: string }): unknown {
  expect(outcome.kind).toBe("response");
  if (outcome.kind !== "response") throw new Error("unreachable");
  return JsonRpcSuccessResponseSchema.parse(JSON.parse(outcome.frame ?? "")).result;
}

function errorCodeOf(outcome: { kind: string; frame?: string }): number {
  expect(outcome.kind).toBe("response");
  if (outcome.kind !== "response") throw new Error("unreachable");
  return JsonRpcErrorResponseSchema.parse(JSON.parse(outcome.frame ?? "")).error.code;
}

describe("subscribe cursor 重放（P0-11）", () => {
  const payloadSchema = z.object({ type: z.literal("output"), data: z.string() });

  function makeDeps() {
    const bus = createEventBus({ now: () => "2026-11-15T00:00:00.000Z" });
    bus.publish(terminalOutputTopic("t1"), { type: "output", data: "a" }, payloadSchema); // seq 1
    bus.publish(STATIC_TOPIC.taskUpdated, { type: "output", data: "x" }, payloadSchema); // seq 2（schema 仅测试用途）
    bus.publish(terminalOutputTopic("t1"), { type: "output", data: "b" }, payloadSchema); // seq 3
    const deps: RouterDeps = {
      daemonVersion: "0.0.1",
      protocolVersion: PROTOCOL_VERSION,
      events: bus,
    };
    return { bus, deps };
  }

  it("无 cursor：应答当前水位，无重放帧（P0-10 定案保持）", async () => {
    const { deps } = makeDeps();
    const outcome = await routeMessage(request("subscribe", { topics: ["task.updated"] }), deps);
    expect(outcome.kind).toBe("response");
    if (outcome.kind !== "response") return;
    expect(outcome.replayFrames).toBeUndefined();
    expect(successOf(outcome)).toEqual({ cursor: 3 });
  });

  it("带 cursor：replayFrames 按 seq 序只回匹配 topic，应答帧随后（水位 = 当前）", async () => {
    const { deps } = makeDeps();
    const outcome = await routeMessage(
      request("subscribe", { topics: [terminalOutputTopic("t1")], cursor: 0 }),
      deps,
    );
    expect(outcome.kind).toBe("response");
    if (outcome.kind !== "response") return;
    const frames = outcome.replayFrames ?? [];
    // 只回 t1 的两帧（seq 1、3），topic 不匹配的 seq 2 被过滤
    const seqs = frames.map(
      (frame) => (JSON.parse(frame) as { params: { seq: number } }).params.seq,
    );
    expect(seqs).toEqual([1, 3]);
    // 重放帧本身是合法 event notification（envelope 校验）
    for (const frame of frames) {
      expect((JSON.parse(frame) as { method: string }).method).toBe("event");
    }
    // 应答水位 = 当前水位（客户端自此续增量）
    expect(successOf(outcome)).toEqual({ cursor: 3 });
  });

  it("cursor 等于当前水位：无重放帧，应答不变", async () => {
    const { deps } = makeDeps();
    const outcome = await routeMessage(
      request("subscribe", { topics: [terminalOutputTopic("t1")], cursor: 3 }),
      deps,
    );
    expect(outcome.kind).toBe("response");
    if (outcome.kind !== "response") return;
    expect(outcome.replayFrames).toEqual([]);
    expect(successOf(outcome)).toEqual({ cursor: 3 });
  });
});

describe("projects/tasks RPC（真实 CatalogService + 内存库）", () => {
  function makeCatalog() {
    const db = openStorage(":memory:");
    const eventBus = createEventBus();
    const catalog = new CatalogService({
      eventBus,
      projects: new ProjectRepository(db),
      tasks: new TaskRepository(db),
    });
    const deps: RouterDeps = {
      daemonVersion: "0.0.1",
      protocolVersion: PROTOCOL_VERSION,
      events: eventBus,
      catalog,
    };
    return { db, eventBus, catalog, deps };
  }

  it("projects.create → Project；projects.list 汇总（P0 返回全部）", async () => {
    const { db, deps } = makeCatalog();
    try {
      const created = successOf(
        await routeMessage(
          request("projects.create", { name: "驾驶舱项目", rootPath: "D:\\proj" }),
          deps,
        ),
      ) as Project;
      expect(created.name).toBe("驾驶舱项目");
      expect(created.gitDefaultBranch).toBe("main");
      expect(created.archivedAt).toBeNull();

      const listed = successOf(await routeMessage(request("projects.list"), deps)) as {
        items: { id: string; archivedAt: string | null }[];
      };
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]?.id).toBe(created.id);
      // projects.list 带 params → fail-closed
      expect(errorCodeOf(await routeMessage(request("projects.list", { any: 1 }), deps))).toBe(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
      );
    } finally {
      closeDatabase(db);
    }
  });

  it("projects.archive：未知 id → INVALID_PARAMS 中文；合法 id → archivedAt 置位且幂等", async () => {
    const { db, deps } = makeCatalog();
    try {
      const unknown = await routeMessage(
        request("projects.archive", { projectId: "no-such" }),
        deps,
      );
      expect(errorCodeOf(unknown)).toBe(JSON_RPC_ERROR_CODES.INVALID_PARAMS);

      const created = successOf(
        await routeMessage(request("projects.create", { name: "P", rootPath: "/p" }), deps),
      ) as Project;
      const first = successOf(
        await routeMessage(request("projects.archive", { projectId: created.id }), deps),
      ) as Project;
      expect(first.archivedAt).not.toBeNull();
      const again = successOf(
        await routeMessage(request("projects.archive", { projectId: created.id }), deps),
      ) as Project;
      expect(again.archivedAt).toBe(first.archivedAt); // 幂等：不刷新时间戳
    } finally {
      closeDatabase(db);
    }
  });

  it("tasks.create/move → Task；变更发 task.updated 投影（payload 过 schema）", async () => {
    const { db, eventBus, deps } = makeCatalog();
    try {
      const envelopes: { topic: string; payload: unknown }[] = [];
      eventBus.addListener((frame) => {
        const notification = JSON.parse(frame) as { method: string; params: unknown };
        if (notification.method === "event") {
          const envelope = notification.params as { topic: string; payload: unknown };
          envelopes.push({ topic: envelope.topic, payload: envelope.payload });
        }
      });
      const project = successOf(
        await routeMessage(request("projects.create", { name: "P", rootPath: "/p" }), deps),
      ) as Project;

      const task = successOf(
        await routeMessage(
          request("tasks.create", { projectId: project.id, title: "接线任务" }),
          deps,
        ),
      ) as Task;
      expect(task.status).toBe("todo");

      const moved = successOf(
        await routeMessage(
          request("tasks.move", { taskId: task.id, status: "in_progress", position: 2 }),
          deps,
        ),
      ) as Task;
      expect(moved.status).toBe("in_progress");
      expect(moved.position).toBe(2);

      const updates = envelopes.filter((entry) => entry.topic === STATIC_TOPIC.taskUpdated);
      expect(updates).toHaveLength(2); // create 一次 + move 一次
      for (const entry of updates) {
        const payload = TaskUpdatedPayloadSchema.parse(entry.payload);
        expect(payload.task.id).toBe(task.id);
      }
      // tasks.move 未知 id / 非法 status → INVALID_PARAMS
      expect(
        errorCodeOf(
          await routeMessage(request("tasks.move", { taskId: "x", status: "done" }), deps),
        ),
      ).toBe(JSON_RPC_ERROR_CODES.INVALID_PARAMS);
      expect(
        errorCodeOf(
          await routeMessage(request("tasks.move", { taskId: task.id, status: "bad" }), deps),
        ),
      ).toBe(JSON_RPC_ERROR_CODES.INVALID_PARAMS);
    } finally {
      closeDatabase(db);
    }
  });

  it("未知字段 / 缺 params → INVALID_PARAMS（strict fail-closed）", async () => {
    const { db, deps } = makeCatalog();
    try {
      expect(
        errorCodeOf(
          await routeMessage(
            request("tasks.create", { projectId: "p", title: "t", extra: 1 }),
            deps,
          ),
        ),
      ).toBe(JSON_RPC_ERROR_CODES.INVALID_PARAMS);
      expect(errorCodeOf(await routeMessage(request("projects.create"), deps))).toBe(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
      );
    } finally {
      closeDatabase(db);
    }
  });
});

describe("diff.workspaceDiff RPC（注入比对假件）", () => {
  it("workspaceId 未知 → INVALID_PARAMS；合法 → DiffResult 透传（缺省 base main）", async () => {
    const db = openStorage(":memory:");
    try {
      const workspaces = new WorkspaceRepository(db);
      const projects = new ProjectRepository(db);
      const project = projects.create({ name: "P", rootPath: "D:\\p" });
      const workspace = workspaces.create({
        projectId: project.id,
        name: "w-diff",
        branch: "aether/w-diff",
        worktreePath: "D:\\wt\\w-diff",
        storageKey: "w-diff",
      });
      const fakeFiles: DiffFile[] = [
        { path: "src/a.ts", status: "modified", patch: "diff --git a/src/a.ts b/src/a.ts" },
      ];
      const diff = new DiffService({
        workspaces,
        projects,
        computeDiff: async (input) => {
          expect(input.branch).toBe("aether/w-diff");
          expect(input.cwd).toBe("D:\\wt\\w-diff");
          return fakeFiles;
        },
      });
      const deps: RouterDeps = {
        daemonVersion: "0.0.1",
        protocolVersion: PROTOCOL_VERSION,
        diff,
      };

      const unknown = await routeMessage(
        request("diff.workspaceDiff", { workspaceId: "no-such" }),
        deps,
      );
      expect(errorCodeOf(unknown)).toBe(JSON_RPC_ERROR_CODES.INVALID_PARAMS);

      const result = successOf(
        await routeMessage(request("diff.workspaceDiff", { workspaceId: workspace.id }), deps),
      );
      expect(result).toEqual({
        workspaceId: workspace.id,
        baseBranch: "main",
        files: fakeFiles,
      });
    } finally {
      closeDatabase(db);
    }
  });
});

describe("P0-11 方法组未装配（骨架 deps）", () => {
  const bareDeps: RouterDeps = { daemonVersion: "0.0.1", protocolVersion: PROTOCOL_VERSION };

  it("catalog/agents/diff 缺省 → METHOD_NOT_FOUND（照 terminals 骨架定案）", async () => {
    for (const method of [
      "projects.list",
      "tasks.list",
      "tasks.create",
      "agents.spawn",
      "agents.cancel",
      "sessions.listEvents",
      "sessions.list",
      "diff.workspaceDiff",
    ]) {
      expect(errorCodeOf(await routeMessage(request(method, { x: 1 }), bareDeps))).toBe(
        JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
      );
    }
  });
});

// ===== P0-11 gate 补：tasks.list / sessions.list（渲染线契约合流）=====
describe("tasks.list / sessions.list RPC", () => {
  /** 真实 AgentService（全真件组装；spawn 不在测路径——adapter 工厂不可达即抛） */
  function makeAgents(db: DatabaseSync): AgentService {
    const workspaces = new WorkspaceRepository(db);
    const eventBus = createEventBus();
    return new AgentService({
      eventBus,
      projects: new ProjectRepository(db),
      tasks: new TaskRepository(db),
      workspaces,
      profiles: new AgentProfileRepository(db),
      providerConfigs: new ProviderConfigRepository(db),
      sessions: new SessionRepository(db),
      processes: new ExecutionProcessRepository(db),
      worktrees: new WorktreeLifecycleService({
        store: workspaces,
        fallbackDir: join(tmpdir(), `rpc-p011-fallback-${randomUUID().slice(0, 8)}`),
      }),
      createEventContext: (input) => ({
        worktreePath: input.worktreePath,
        env: input.env ?? {},
        loadEvents: input.loadEvents,
        emit: () => undefined,
      }),
      replayProcessLogs: () => ({ events: [], backfilledRowCount: 0 }),
      logSink: new ExecutionLogSink({
        store: new ExecutionProcessLogRepository(db),
        onError: () => undefined,
      }),
      createAdapterInstance: () => {
        throw new Error("tasks.list/sessions.list 测试不经 spawn 路径");
      },
    });
  }

  function makeDeps() {
    const db = openStorage(":memory:");
    const eventBus = createEventBus();
    const catalog = new CatalogService({
      eventBus,
      projects: new ProjectRepository(db),
      tasks: new TaskRepository(db),
    });
    const deps: RouterDeps = {
      daemonVersion: "0.0.1",
      protocolVersion: PROTOCOL_VERSION,
      events: eventBus,
      catalog,
      agents: makeAgents(db),
    };
    return { db, deps };
  }

  it("tasks.list：项目内任务清单；未知项目/缺 params/未知字段 → INVALID_PARAMS", async () => {
    const { db, deps } = makeDeps();
    try {
      const project = successOf(
        await routeMessage(request("projects.create", { name: "P", rootPath: "/p" }), deps),
      ) as Project;
      const other = successOf(
        await routeMessage(request("projects.create", { name: "Q", rootPath: "/q" }), deps),
      ) as Project;
      const t1 = successOf(
        await routeMessage(request("tasks.create", { projectId: project.id, title: "T1" }), deps),
      ) as Task;
      await routeMessage(request("tasks.create", { projectId: project.id, title: "T2" }), deps);
      await routeMessage(request("tasks.create", { projectId: other.id, title: "别家的" }), deps);

      const listed = successOf(
        await routeMessage(request("tasks.list", { projectId: project.id }), deps),
      ) as { items: Task[] };
      expect(listed.items.map((task) => task.title)).toEqual(["T1", "T2"]);
      expect(listed.items[0]?.id).toBe(t1.id);

      expect(
        errorCodeOf(await routeMessage(request("tasks.list", { projectId: "no-such" }), deps)),
      ).toBe(JSON_RPC_ERROR_CODES.INVALID_PARAMS);
      expect(errorCodeOf(await routeMessage(request("tasks.list"), deps))).toBe(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
      );
      expect(
        errorCodeOf(
          await routeMessage(request("tasks.list", { projectId: project.id, extra: 1 }), deps),
        ),
      ).toBe(JSON_RPC_ERROR_CODES.INVALID_PARAMS);
    } finally {
      closeDatabase(db);
    }
  });

  it("sessions.list：任务名下会话（workspace.taskId 联表）；未知任务/缺 params → INVALID_PARAMS", async () => {
    const { db, deps } = makeDeps();
    try {
      const workspaces = new WorkspaceRepository(db);
      const sessions = new SessionRepository(db);
      const profileId = new AgentProfileRepository(db).findAll()[0]?.id ?? "";
      const project = successOf(
        await routeMessage(request("projects.create", { name: "P", rootPath: "/p2" }), deps),
      ) as Project;
      const task = successOf(
        await routeMessage(request("tasks.create", { projectId: project.id, title: "T" }), deps),
      ) as Task;
      const workspace = workspaces.create({
        projectId: project.id,
        taskId: task.id,
        name: "w-sl",
        branch: "aether/w-sl",
        worktreePath: "D:\\wt\\w-sl",
        storageKey: "w-sl",
      });
      const session = sessions.create({ workspaceId: workspace.id, agentProfileId: profileId });

      const listed = successOf(
        await routeMessage(request("sessions.list", { taskId: task.id }), deps),
      ) as { items: { id: string }[] };
      expect(listed.items.map((item) => item.id)).toEqual([session.id]);

      expect(errorCodeOf(await routeMessage(request("sessions.list", { taskId: "x" }), deps))).toBe(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
      );
      expect(errorCodeOf(await routeMessage(request("sessions.list"), deps))).toBe(
        JSON_RPC_ERROR_CODES.INVALID_PARAMS,
      );
    } finally {
      closeDatabase(db);
    }
  });
});

describe("agents 参数 schema 可选字段（gate 契约对账）", () => {
  it("agents.spawn：agentProfileId 可缺省（渲染线无 profile 选择器）；未知字段拒绝", () => {
    expect(AgentsSpawnParamsSchema.safeParse({ taskId: "t1", prompt: "hi" }).success).toBe(true);
    expect(
      AgentsSpawnParamsSchema.safeParse({ taskId: "t1", agentProfileId: "p1", prompt: "hi" })
        .success,
    ).toBe(true);
    expect(
      AgentsSpawnParamsSchema.safeParse({ taskId: "t1", prompt: "hi", extra: 1 }).success,
    ).toBe(false);
  });

  it("agents.permission.respond：processId 可缺省（permission_request 不携带）；未知字段拒绝", () => {
    expect(
      AgentsPermissionRespondParamsSchema.safeParse({ requestId: "r1", decision: "approve" })
        .success,
    ).toBe(true);
    expect(
      AgentsPermissionRespondParamsSchema.safeParse({
        processId: "p1",
        requestId: "r1",
        decision: "deny",
      }).success,
    ).toBe(true);
    expect(
      AgentsPermissionRespondParamsSchema.safeParse({ requestId: "r1", decision: "approve", x: 1 })
        .success,
    ).toBe(false);
  });
});
