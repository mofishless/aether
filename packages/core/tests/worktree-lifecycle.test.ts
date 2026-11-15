import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorktreeError, WorktreeLifecycleService } from "../src/index.js";
import {
  createGitProject,
  createGitProjectWithEnvAndPnpm,
  expectMainClean,
} from "./helpers/git-fixture.js";
import type { GitProjectFixture } from "./helpers/git-fixture.js";
import { InMemoryWorkspaceStore } from "./helpers/fake-store.js";

describe("createForTask 全旅程", () => {
  let fixture: GitProjectFixture;
  let store: InMemoryWorkspaceStore;
  let service: WorktreeLifecycleService;
  const warnings: string[] = [];

  beforeAll(() => {
    fixture = createGitProjectWithEnvAndPnpm();
    store = new InMemoryWorkspaceStore();
    service = new WorktreeLifecycleService({
      store,
      fallbackDir: join(fixture.baseDir, "fallback"),
      onWarning: (message) => {
        warnings.push(message);
      },
    });
  });

  afterAll(() => {
    fixture.dispose();
  });

  it("reserved→creating→ready 落库、磁盘 worktree/分支存在、.env 拷贝、包管理器探测", async () => {
    const result = await service.createForTask(fixture.projectRoot, {
      projectId: "p1",
      name: "auth",
      taskId: "t1",
    });
    const workspace = result.workspace;

    // 落库终态
    expect(workspace.status).toBe("ready");
    expect(workspace.projectId).toBe("p1");
    expect(workspace.taskId).toBe("t1");
    expect(workspace.name).toBe("auth");
    expect(workspace.branch).toBe("aether/auth");
    expect(workspace.worktreePath).toBe(
      resolve(join(fixture.baseDir, ".aether-worktrees", "auth")),
    );
    expect(result.usedFallback).toBe(false);
    expect(result.packageManager).toBe("pnpm");
    expect(result.warnings).toEqual([]);
    expect(warnings).toEqual([]);

    // 状态机序列：create(reserved) → update(creating) → update(ready)
    const created = store.createLog.at(-1);
    expect(created?.status).toBe("reserved");
    const statuses = store.updateLog
      .filter((entry) => entry.id === workspace.id)
      .map((entry) => entry.patch.status);
    expect(statuses).toEqual(["creating", "ready"]);

    // 磁盘：worktree 目录 + .git 文件（linked worktree 标记）
    expect(existsSync(workspace.worktreePath)).toBe(true);
    expect(existsSync(join(workspace.worktreePath, ".git"))).toBe(true);

    // .env 拷贝内容一致
    const envSource = readFileSync(join(fixture.projectRoot, ".env"), "utf8");
    const envCopied = readFileSync(join(workspace.worktreePath, ".env"), "utf8");
    expect(envCopied).toBe(envSource);

    // 分支存在
    expect(fixture.git(["branch", "--list", "aether/auth"])).toContain("aether/auth");

    // 主 checkout 永远干净
    expectMainClean(fixture);
  });

  it("裸项目（无 .env / 无 lockfile）：packageManager 为 null，不拷 .env", async () => {
    const bareFixture = createGitProject();
    const bareStore = new InMemoryWorkspaceStore();
    const bareService = new WorktreeLifecycleService({
      store: bareStore,
      fallbackDir: join(bareFixture.baseDir, "fallback"),
    });
    try {
      const result = await bareService.createForTask(bareFixture.projectRoot, {
        projectId: "p2",
        name: "bare",
      });
      expect(result.packageManager).toBeNull();
      expect(result.workspace.taskId).toBeNull();
      expect(existsSync(join(result.workspace.worktreePath, ".env"))).toBe(false);
      expectMainClean(bareFixture);
    } finally {
      bareFixture.dispose();
    }
  });

  it("主 checkout 带未提交变更：不阻拦创建，脏文件逐字保留且不进新 worktree", async () => {
    const dirtyFixture = createGitProject();
    const dirtyStore = new InMemoryWorkspaceStore();
    const dirtyService = new WorktreeLifecycleService({
      store: dirtyStore,
      fallbackDir: join(dirtyFixture.baseDir, "fallback"),
    });
    try {
      // 主 checkout 写入未提交变更（对照：本文件其余测试的主 checkout 恒干净）
      writeFileSync(join(dirtyFixture.projectRoot, "dirty-note.txt"), "本地未提交内容 v1\n");
      expect(dirtyFixture.git(["status", "--porcelain"])).toContain("dirty-note.txt");

      const result = await dirtyService.createForTask(dirtyFixture.projectRoot, {
        projectId: "p1",
        name: "amid-dirt",
      });

      expect(result.workspace.status).toBe("ready");
      // 脏文件逐字保留在主 checkout
      expect(readFileSync(join(dirtyFixture.projectRoot, "dirty-note.txt"), "utf8")).toBe(
        "本地未提交内容 v1\n",
      );
      // 新 worktree 从 HEAD 建出：不含该未提交变更
      expect(existsSync(join(result.workspace.worktreePath, "dirty-note.txt"))).toBe(false);
    } finally {
      dirtyFixture.dispose();
    }
  });
});

describe("残留分支回收与目录残留失败", () => {
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

  it("同名残留分支（未被 worktree 占用）→ 删后重建，创建成功", async () => {
    // 模拟历史 release 的 -D 失败遗留分支（未 checkout、未被任何 worktree 占用）：
    // 不回收的话 worktree add -b 必败 → 行 failed → 该 name 永久不可用
    fixture.git(["branch", "aether/reclaim-demo"]);

    const result = await service.createForTask(fixture.projectRoot, {
      projectId: "p1",
      name: "reclaim-demo",
    });

    expect(result.workspace.status).toBe("ready");
    expect(existsSync(result.workspace.worktreePath)).toBe(true);
    expect(fixture.git(["branch", "--list", "aether/reclaim-demo"])).toContain(
      "aether/reclaim-demo",
    );
    expectMainClean(fixture);
  });

  it("worktree 路径被非空目录占用 → 明确 WorktreeError，行标 failed", async () => {
    const occupiedDir = join(fixture.baseDir, ".aether-worktrees", "dir-residual");
    mkdirSync(occupiedDir, { recursive: true });
    writeFileSync(join(occupiedDir, "blocker.txt"), "占位");

    let caught: unknown;
    try {
      await service.createForTask(fixture.projectRoot, {
        projectId: "p1",
        name: "dir-residual",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WorktreeError);
    expect(caught instanceof WorktreeError ? caught.operation : "").toBe("worktree.add");
    const row = store.snapshot().find((candidate) => candidate.name === "dir-residual");
    expect(row?.status).toBe("failed");
    expectMainClean(fixture);
  });
});
