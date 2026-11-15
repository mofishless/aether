import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WorktreeError,
  WorktreeLifecycleService,
  type CreateWorkspaceResult,
} from "../src/index.js";
import { createGitProject, expectMainClean } from "./helpers/git-fixture.js";
import type { GitProjectFixture } from "./helpers/git-fixture.js";
import { InMemoryWorkspaceStore } from "./helpers/fake-store.js";

// TDD 首测试（任务卡 P0-05 验收）：并发创建两个同 task 同名 workspace 只成功一个。

describe("并发创建互斥（锁 + 持久预留唯一性）", () => {
  let fixture: GitProjectFixture;
  let store: InMemoryWorkspaceStore;
  let service: WorktreeLifecycleService;

  beforeAll(() => {
    fixture = createGitProject();
    store = new InMemoryWorkspaceStore();
    service = new WorktreeLifecycleService({
      store,
      fallbackDir: join(fixture.baseDir, "fallback"),
    });
  });

  afterAll(() => {
    fixture.dispose();
  });

  it("同 task 同名并发：恰好一个成功，失败方拿到 WorktreeError，落库仅一行且为 ready", async () => {
    const results = await Promise.allSettled([
      service.createForTask(fixture.projectRoot, {
        projectId: "p1",
        name: "dup",
        taskId: "t-shared",
      }),
      service.createForTask(fixture.projectRoot, {
        projectId: "p1",
        name: "dup",
        taskId: "t-shared",
      }),
    ]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<CreateWorkspaceResult> => r.status === "fulfilled",
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const reason = rejected[0]?.reason;
    expect(reason).toBeInstanceOf(WorktreeError);
    expect(reason.operation).toBe("reserve");
    expect(reason.message).toContain("dup");

    const rows = store.snapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("ready");
    expectMainClean(fixture);
  });

  it("同项目不同名并发：两者都成功（锁串行但不互斥不同 workspace）", async () => {
    const results = await Promise.allSettled([
      service.createForTask(fixture.projectRoot, { projectId: "p1", name: "alpha" }),
      service.createForTask(fixture.projectRoot, { projectId: "p1", name: "beta" }),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const readyRows = store.snapshot().filter((row) => row.name === "alpha" || row.name === "beta");
    expect(readyRows).toHaveLength(2);
    expect(readyRows.every((row) => row.status === "ready")).toBe(true);
  });

  it("周期 recoverOrphans 撞上在途创建：预留入锁后创建仍成功、不被恢复击碎", async () => {
    // 先入队恢复（历史 bug 窗口：恢复持锁时，锁外已落库的 reserved 行会被当崩溃行清掉 → 伪失败）
    const recovery = service.recoverOrphans(fixture.projectRoot, "p1");
    const creating = service.createForTask(fixture.projectRoot, {
      projectId: "p1",
      name: "race-guard",
    });

    const [report, result] = await Promise.all([recovery, creating]);

    expect(result.workspace.status).toBe("ready");
    expect(store.findById(result.workspace.id)?.status).toBe("ready");
    expect(existsSync(result.workspace.worktreePath)).toBe(true);
    expect(report.some((entry) => entry.workspaceId === result.workspace.id)).toBe(false);
    expectMainClean(fixture);
  });
});
