import { afterAll, describe, expect, it } from "vitest";
import { ProjectRepository, TaskRepository, openDatabase, openStorage } from "../src/index.js";
import { countRows, createDbTestContext } from "./helpers.js";

// 局限说明（spec-review finding 6）：node:sqlite 是同步驱动，同一线程内两连接只能
// 交错执行、不可能产生真争用（SQLITE_BUSY）。本用例锁定的是 WAL 双连接可见性与
// busy_timeout PRAGMA 生效值；真并发争用防护留待 daemon 多进程场景（P0-03）验证。

describe("并发写（WAL + busy_timeout）", () => {
  const ctx = createDbTestContext();
  afterAll(() => ctx.dispose());

  it("同一文件库两连接交错各写 100 行 task：无 SQLITE_BUSY、行数完整", () => {
    const path = ctx.nextDbPath();
    const dbA = ctx.track(openStorage(path)); // A 负责迁移 + 种子
    const dbB = ctx.track(openDatabase(path)); // B 直接复用已迁移库

    const projects = new ProjectRepository(dbA);
    const project = projects.create({ name: "P", rootPath: "D:\\concurrent" });
    const tasksA = new TaskRepository(dbA);
    const tasksB = new TaskRepository(dbB);

    for (let i = 0; i < 100; i++) {
      tasksA.create({ projectId: project.id, title: `A-${i}` });
      tasksB.create({ projectId: project.id, title: `B-${i}` });
    }

    expect(countRows(dbA, "task")).toBe(200);
    expect(countRows(dbB, "task")).toBe(200);

    // 两连接的 busy_timeout 均已生效（openDatabase PRAGMA 三连；结果列名为 timeout）
    const timeoutA = dbA.prepare("PRAGMA busy_timeout").get();
    const timeoutB = dbB.prepare("PRAGMA busy_timeout").get();
    expect(Number(timeoutA?.timeout)).toBe(5000);
    expect(Number(timeoutB?.timeout)).toBe(5000);
  });
});
