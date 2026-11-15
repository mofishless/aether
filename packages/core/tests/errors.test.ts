import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorktreeError, WorktreeLifecycleService } from "../src/index.js";
import { createGitProject } from "./helpers/git-fixture.js";
import type { GitProjectFixture } from "./helpers/git-fixture.js";
import { InMemoryWorkspaceStore } from "./helpers/fake-store.js";

describe("WorktreeError 上下文", () => {
  let fixture: GitProjectFixture;
  let store: InMemoryWorkspaceStore;
  let service: WorktreeLifecycleService;
  let plainDir: string;

  beforeAll(() => {
    fixture = createGitProject();
    plainDir = mkdtempSync(join(tmpdir(), "aether-not-git-"));
    store = new InMemoryWorkspaceStore();
    service = new WorktreeLifecycleService({
      store,
      fallbackDir: join(fixture.baseDir, "fallback"),
    });
  });

  afterAll(() => {
    fixture.dispose();
  });

  it("非 git 项目：operation/workspaceId/cause 完整，行标 failed", async () => {
    const attempt = service.createForTask(plainDir, { projectId: "p1", name: "no-git" });
    await expect(attempt).rejects.toBeInstanceOf(WorktreeError);

    const rows = store.snapshot();
    expect(rows).toHaveLength(1);
    const failedRow = rows[0];
    expect(failedRow?.status).toBe("failed");

    let caught: unknown;
    try {
      await service.createForTask(plainDir, { projectId: "p1", name: "no-git-2" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorktreeError);
    const err = caught as WorktreeError;
    expect(typeof err.operation).toBe("string");
    expect(err.operation.length).toBeGreaterThan(0);
    expect(err.workspaceId).toBeDefined();
    expect(err.cause).toBeDefined();
    expect(err.message.length).toBeGreaterThan(0);
  });

  it("非法 name（路径穿越 / 空名）在预留前被拒：不留行不留目录", async () => {
    await expect(
      service.createForTask(fixture.projectRoot, { projectId: "p1", name: "../evil" }),
    ).rejects.toBeInstanceOf(WorktreeError);
    await expect(
      service.createForTask(fixture.projectRoot, { projectId: "p1", name: "" }),
    ).rejects.toBeInstanceOf(WorktreeError);
    await expect(
      service.createForTask(fixture.projectRoot, { projectId: "p1", name: "has space" }),
    ).rejects.toBeInstanceOf(WorktreeError);
    const names = store.snapshot().map((row) => row.name);
    expect(names).toHaveLength(2); // 仅前一个用例的 no-git / no-git-2 两行
    expect(names).not.toContain("../evil");
  });
});
