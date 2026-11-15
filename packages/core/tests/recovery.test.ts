import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Workspace } from "@aether/contracts";
import {
  WorktreeLifecycleService,
  type RecoveryEntry,
  type WorkspaceStorePatch,
} from "../src/index.js";
import {
  createGitProject,
  createGitProjectWithEnvAndPnpm,
  expectMainClean,
} from "./helpers/git-fixture.js";
import type { GitProjectFixture } from "./helpers/git-fixture.js";
import { InMemoryWorkspaceStore } from "./helpers/fake-store.js";

// 验收（任务卡 P0-05）：崩溃中途（已写库行未动 Git / 已动 Git 未回写）重启后能清理或补建，主 checkout 永远干净。

function actionsOf(report: readonly RecoveryEntry[]): string[] {
  return report.map((entry) => entry.action);
}

/** 恢复失败注入：对指定行的下一次 update 抛错（模拟恢复期间 store 瞬时故障，如 DB 锁；
 *  fs 层注入（只读目录/占用句柄）在 Windows 上不确定，故选确定性接缝）。 */
class FlakyUpdateStore extends InMemoryWorkspaceStore {
  private failNextUpdateFor: string | null = null;

  failNextUpdate(id: string): void {
    this.failNextUpdateFor = id;
  }

  override update(id: string, patch: WorkspaceStorePatch): Workspace | null {
    if (this.failNextUpdateFor === id) {
      this.failNextUpdateFor = null;
      throw new Error("模拟 store 写入失败");
    }
    return super.update(id, patch);
  }
}

describe("崩溃恢复：阶段 A —— 已写库行未动 Git", () => {
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

  it("reserved / creating 行未动 Git → 清行收敛（选清理）", async () => {
    store.create({
      projectId: "p1",
      name: "stuck-reserved",
      branch: "aether/stuck-reserved",
      worktreePath: resolve(join(fixture.baseDir, ".aether-worktrees", "stuck-reserved")),
      storageKey: "stuck-reserved",
      status: "reserved",
    });
    store.create({
      projectId: "p1",
      name: "stuck-creating",
      branch: "aether/stuck-creating",
      worktreePath: resolve(join(fixture.baseDir, ".aether-worktrees", "stuck-creating")),
      storageKey: "stuck-creating",
      status: "creating",
    });

    const report = await service.recoverOrphans(fixture.projectRoot, "p1");

    expect(store.snapshot()).toHaveLength(0);
    expect(actionsOf(report)).toEqual(["deleted-stale-row", "deleted-stale-row"]);
    // 未动 Git：不留分支
    expect(fixture.git(["branch", "--list", "aether/stuck-*"])).toBe("");
    expectMainClean(fixture);
  });
});

describe("崩溃恢复：阶段 B —— 已动 Git 未回写库", () => {
  let fixture: GitProjectFixture;
  let store: InMemoryWorkspaceStore;
  let service: WorktreeLifecycleService;

  beforeAll(() => {
    fixture = createGitProjectWithEnvAndPnpm();
    store = new InMemoryWorkspaceStore();
    service = new WorktreeLifecycleService({
      store,
      fallbackDir: join(fixture.baseDir, "fallback"),
    });
  });

  afterAll(() => {
    fixture.dispose();
  });

  it("行停 creating + 磁盘 worktree 完整 → 补走后续收敛 ready，主 checkout 始终干净", async () => {
    const worktreePath = resolve(join(fixture.baseDir, ".aether-worktrees", "half-done"));
    const row = store.create({
      projectId: "p1",
      name: "half-done",
      branch: "aether/half-done",
      worktreePath,
      storageKey: "half-done",
      status: "creating",
    });
    // 手工模拟"已动 Git 未回写库"：git 成功、库停在 creating
    fixture.git(["worktree", "add", "-b", "aether/half-done", worktreePath]);
    expectMainClean(fixture);

    const report = await service.recoverOrphans(fixture.projectRoot, "p1");

    const recovered = store.findById(row.id);
    expect(recovered?.status).toBe("ready");
    expect(actionsOf(report)).toEqual(["resumed-ready"]);
    expect(report[0]?.packageManager).toBe("pnpm");
    // 补走后续：.env 拷贝到位
    expect(existsSync(join(worktreePath, ".env"))).toBe(true);
    expectMainClean(fixture);
  });
});

describe("崩溃恢复：deleting 行与孤儿目录", () => {
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

  it("行停 deleting（worktree 已建）→ 补完删除", async () => {
    const worktreePath = resolve(join(fixture.baseDir, ".aether-worktrees", "half-deleted"));
    const row = store.create({
      projectId: "p1",
      name: "half-deleted",
      branch: "aether/half-deleted",
      worktreePath,
      storageKey: "half-deleted",
      status: "creating",
    });
    fixture.git(["worktree", "add", "-b", "aether/half-deleted", worktreePath]);
    store.update(row.id, { status: "deleting", releasedAt: new Date().toISOString() });

    const report = await service.recoverOrphans(fixture.projectRoot, "p1");

    expect(store.findById(row.id)).toBeNull();
    expect(existsSync(worktreePath)).toBe(false);
    expect(fixture.git(["branch", "--list", "aether/half-deleted"])).toBe("");
    expect(actionsOf(report)).toEqual(["completed-deletion"]);
    expectMainClean(fixture);
  });

  it("磁盘目录无行认领 / 行 reserved 的目录 → 清目录；健康 workspace 不被误删", async () => {
    // 健康 workspace（不应被恢复触碰）
    const healthy = await service.createForTask(fixture.projectRoot, {
      projectId: "p1",
      name: "healthy",
    });
    const base = join(fixture.baseDir, ".aether-worktrees");
    // 无行认领的孤儿目录
    const orphanDir = join(base, "rowless-orphan");
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, "junk.txt"), "stale");
    // 行 reserved + 目录已存在（矛盾态）：行被清后目录无主
    const reservedDir = join(base, "reserved-with-dir");
    mkdirSync(reservedDir, { recursive: true });
    store.create({
      projectId: "p1",
      name: "reserved-with-dir",
      branch: "aether/reserved-with-dir",
      worktreePath: resolve(reservedDir),
      storageKey: "reserved-with-dir",
      status: "reserved",
    });

    const report = await service.recoverOrphans(fixture.projectRoot, "p1");

    expect(existsSync(orphanDir)).toBe(false);
    expect(existsSync(reservedDir)).toBe(false);
    expect(existsSync(healthy.workspace.worktreePath)).toBe(true);
    expect(store.findById(healthy.workspace.id)?.status).toBe("ready");
    const orphanActions = report
      .filter((entry) => entry.action !== "deleted-stale-row")
      .map((e) => e.action);
    expect(orphanActions).toEqual(["removed-orphan-dir", "removed-orphan-dir"]);
    expectMainClean(fixture);
  });

  // Windows 主平台回归：库行 worktreePath 与磁盘目录名仅大小写不一致（不敏感 FS 上同一目录），
  // 阶段 2 认领必须归一比较，否则健康 worktree 被判无主目录直接删除（丢数据）。
  // 大小写敏感文件系统（Linux）上两路径是不同目录、行为本就不同，故仅 win32 运行。
  it.skipIf(process.platform !== "win32")(
    "库行路径与磁盘目录名仅大小写不同 → 健康 worktree 不被误删",
    async () => {
      const healthy = await service.createForTask(fixture.projectRoot, {
        projectId: "p1",
        name: "case-guard",
      });
      const realPath = healthy.workspace.worktreePath;
      // 模拟：落库行路径仅末段目录名与磁盘大小写不同（win32 文件系统不区分，二者同一目录）
      const casedPath = join(dirname(realPath), "CASE-GUARD");
      store.update(healthy.workspace.id, { worktreePath: casedPath });

      const report = await service.recoverOrphans(fixture.projectRoot, "p1");

      expect(existsSync(realPath)).toBe(true);
      expect(store.findById(healthy.workspace.id)?.status).toBe("ready");
      expect(actionsOf(report)).toEqual([]);
      expectMainClean(fixture);
    },
  );
});

describe("崩溃恢复：ready 对账与恢复失败标记", () => {
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

  it("ready 行目录被外部删除 → 先标 orphaned 再 completed-deletion（分支一并清理）", async () => {
    const created = await service.createForTask(fixture.projectRoot, {
      projectId: "p1",
      name: "vanished",
    });
    const workspaceId = created.workspace.id;
    // 外部删除 worktree 目录（对账洞：目录没了但行仍是 ready）
    rmSync(created.workspace.worktreePath, { recursive: true, force: true });
    expect(existsSync(created.workspace.worktreePath)).toBe(false);

    const report = await service.recoverOrphans(fixture.projectRoot, "p1");

    expect(actionsOf(report)).toEqual(["completed-deletion"]);
    expect(store.findById(workspaceId)).toBeNull();
    expect(fixture.git(["branch", "--list", "aether/vanished"])).toBe("");
    // orphaned 有了生产写入路径：收敛前先落痕
    const orphanWrites = store.updateLog.filter(
      (entry) => entry.id === workspaceId && entry.patch.status === "orphaned",
    );
    expect(orphanWrites).toHaveLength(1);
    expectMainClean(fixture);
  });

  it("恢复单项内部失败 → 行标 failed 且报告记录 marked-failed", async () => {
    const flakyStore = new FlakyUpdateStore();
    const flakyService = new WorktreeLifecycleService({
      store: flakyStore,
      fallbackDir: join(fixture.baseDir, "fallback"),
    });
    const created = await flakyService.createForTask(fixture.projectRoot, {
      projectId: "p1",
      name: "mark-failed",
    });
    const workspaceId = created.workspace.id;
    rmSync(created.workspace.worktreePath, { recursive: true, force: true });
    flakyStore.failNextUpdate(workspaceId); // 对账标 orphaned 时注入 store 瞬时故障

    const report = await flakyService.recoverOrphans(fixture.projectRoot, "p1");

    expect(actionsOf(report)).toEqual(["marked-failed"]);
    expect(report[0]?.detail).toContain("模拟 store 写入失败");
    expect(flakyStore.findById(workspaceId)?.status).toBe("failed");
    expectMainClean(fixture);
  });
});
