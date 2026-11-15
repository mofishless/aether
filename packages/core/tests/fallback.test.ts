import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorktreeLifecycleService } from "../src/index.js";
import { createGitProject, expectMainClean } from "./helpers/git-fixture.js";
import type { GitProjectFixture } from "./helpers/git-fixture.js";
import { InMemoryWorkspaceStore } from "./helpers/fake-store.js";

describe("不可写主基座回退 fallbackDir", () => {
  let fixture: GitProjectFixture;
  let store: InMemoryWorkspaceStore;
  let service: WorktreeLifecycleService;
  let fallbackDir: string;

  beforeAll(() => {
    fixture = createGitProject();
    // 主基座位置被同名文件占据 → 不可创建目录 → 必须回退
    writeFileSync(join(fixture.baseDir, ".aether-worktrees"), "not a directory");
    fallbackDir = join(fixture.baseDir, "fallback");
    store = new InMemoryWorkspaceStore();
    service = new WorktreeLifecycleService({ store, fallbackDir });
  });

  afterAll(() => {
    fixture.dispose();
  });

  it("主基座不可用时 worktree 落位 fallbackDir/<name> 并正常 ready", async () => {
    const result = await service.createForTask(fixture.projectRoot, {
      projectId: "p1",
      name: "fallback-ws",
    });
    expect(result.usedFallback).toBe(true);
    expect(result.workspace.worktreePath).toBe(resolve(join(fallbackDir, "fallback-ws")));
    expect(result.workspace.status).toBe("ready");
    expect(existsSync(result.workspace.worktreePath)).toBe(true);
    expectMainClean(fixture);
  });
});
