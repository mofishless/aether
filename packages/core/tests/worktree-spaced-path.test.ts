// P0-12 含空格路径冒烟（①worktree 全链）：项目根、.aether-worktrees/、fallback 目录
// 全部落位含空格目录之下，createForTask→release 全链不炸、终态正确。
// 双平台语义：Windows 上路径含空格是引号/转义重灾区（git 子进程参数、路径比较）；
// POSIX 上无 shell 包装层、argv 边界由内核保证，空格路径风险低但同样值得同测——
// 故不 skipIf，两平台都跑（断言不分支，双平台语义一致）。
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorktreeLifecycleService } from "../src/index.js";
import { createGitProject, expectMainClean } from "./helpers/git-fixture.js";
import type { GitProjectFixture } from "./helpers/git-fixture.js";
import { InMemoryWorkspaceStore } from "./helpers/fake-store.js";

describe("worktree 全链 × 含空格路径（P0-12 冒烟）", () => {
  let fixture: GitProjectFixture;
  let store: InMemoryWorkspaceStore;
  let service: WorktreeLifecycleService;
  const spacedDir = join(mkdtempSync(join(tmpdir(), "aether-space-")), "dir with space");

  beforeAll(() => {
    // mkdtemp 保证唯一；子目录名固定含空格，"路径含空格"由目录名直接保证
    mkdirSync(spacedDir, { recursive: true });
    fixture = createGitProject({ parentDir: spacedDir });
    store = new InMemoryWorkspaceStore();
    service = new WorktreeLifecycleService({
      store,
      fallbackDir: join(spacedDir, "fallback also spaced"),
    });
  });

  afterAll(() => {
    fixture.dispose();
  });

  it("含空格目录下：建 worktree/分支 → 删除，全链不炸且终态正确", async () => {
    const projectRoot = fixture.projectRoot;

    // 建：reserved→creating→ready，worktree 落位含空格路径，分支存在，主 checkout 干净
    const created = await service.createForTask(projectRoot, {
      projectId: "p1",
      name: "spaced-demo",
      taskId: "t1",
    });
    const workspace = created.workspace;
    expect(workspace.status).toBe("ready");
    expect(workspace.worktreePath).toContain("dir with space");
    expect(existsSync(workspace.worktreePath)).toBe(true);
    expect(existsSync(join(workspace.worktreePath, ".git"))).toBe(true);
    expect(fixture.git(["branch", "--list", workspace.branch])).toContain(workspace.branch);
    expectMainClean(fixture);

    // 删：行删、目录删、分支删，主 checkout 仍干净
    await service.release(workspace.id, projectRoot);
    expect(store.snapshot()).toHaveLength(0);
    expect(existsSync(workspace.worktreePath)).toBe(false);
    expect(fixture.git(["branch", "--list", workspace.branch])).toBe("");
    expectMainClean(fixture);
  }, 30_000);
});
