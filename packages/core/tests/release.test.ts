import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorktreeLifecycleService } from "../src/index.js";
import { createGitProject, expectMainClean } from "./helpers/git-fixture.js";
import type { GitProjectFixture } from "./helpers/git-fixture.js";
import { InMemoryWorkspaceStore } from "./helpers/fake-store.js";

describe("release 全旅程与幂等", () => {
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

  it("release：行删、目录删、分支删，主 checkout 干净", async () => {
    const created = await service.createForTask(fixture.projectRoot, {
      projectId: "p1",
      name: "ephemeral",
    });
    const workspaceId = created.workspace.id;
    const worktreePath = created.workspace.worktreePath;
    const branch = created.workspace.branch;

    await service.release(workspaceId, fixture.projectRoot);

    expect(store.snapshot()).toHaveLength(0);
    expect(existsSync(worktreePath)).toBe(false);
    expect(fixture.git(["branch", "--list", branch])).toBe("");
    expectMainClean(fixture);
  });

  it("二次 release 幂等不炸", async () => {
    const created = await service.createForTask(fixture.projectRoot, {
      projectId: "p1",
      name: "twice",
    });
    const workspaceId = created.workspace.id;
    await service.release(workspaceId, fixture.projectRoot);
    await expect(service.release(workspaceId, fixture.projectRoot)).resolves.toBeUndefined();
    expect(store.snapshot()).toHaveLength(0);
  });

  it("worktree 目录被手动删除后 release：幂等继续删行删分支", async () => {
    const created = await service.createForTask(fixture.projectRoot, {
      projectId: "p1",
      name: "manual-rm",
    });
    rmSync(created.workspace.worktreePath, { recursive: true, force: true });
    expect(existsSync(created.workspace.worktreePath)).toBe(false);

    await expect(
      service.release(created.workspace.id, fixture.projectRoot),
    ).resolves.toBeUndefined();

    expect(store.snapshot()).toHaveLength(0);
    // 分支虽在（worktree 没了但 ref 还在），release 仍应补删
    expect(fixture.git(["branch", "--list", created.workspace.branch])).toBe("");
    expectMainClean(fixture);
  });

  it("release 落库轨迹含 deleting（updateLog 可见 releasedAt 写入）", async () => {
    const created = await service.createForTask(fixture.projectRoot, {
      projectId: "p1",
      name: "deleting-log",
    });
    const workspaceId = created.workspace.id;

    await service.release(workspaceId, fixture.projectRoot);

    const statuses = store.updateLog
      .filter((entry) => entry.id === workspaceId)
      .map((entry) => entry.patch.status);
    expect(statuses).toEqual(["creating", "ready", "deleting"]);
    const deletingPatch = store.updateLog.find(
      (entry) => entry.id === workspaceId && entry.patch.status === "deleting",
    )?.patch;
    expect(typeof deletingPatch?.releasedAt).toBe("string");
  });

  it("未 provision 的 reserved 崩溃行 release：零警告零错误、删行、幂等", async () => {
    const warnings: string[] = [];
    const warnService = new WorktreeLifecycleService({
      store,
      fallbackDir: join(fixture.baseDir, "fallback"),
      onWarning: (message) => {
        warnings.push(message);
      },
    });
    // 模拟崩溃残留：只落了 reserved 行，从未动 Git（分支不存在、目录不存在）
    const row = store.create({
      projectId: "p1",
      name: "reserved-crash",
      branch: "aether/reserved-crash",
      worktreePath: resolve(join(fixture.baseDir, ".aether-worktrees", "reserved-crash")),
      storageKey: "reserved-crash",
      status: "reserved",
    });

    await warnService.release(row.id, fixture.projectRoot);

    expect(store.findById(row.id)).toBeNull();
    expect(fixture.git(["branch", "--list", "aether/reserved-crash"])).toBe("");
    // 分支本就不存在不算删除失败：不得发"分支删除未成功"警告（幂等无噪）
    expect(warnings).toEqual([]);
    // 幂等：二次 release 不炸、不再警告
    await expect(warnService.release(row.id, fixture.projectRoot)).resolves.toBeUndefined();
    expect(warnings).toEqual([]);
    expectMainClean(fixture);
  });
});
