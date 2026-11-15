import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { statSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
  ProjectRepository,
  TaskRepository,
  closeDatabase,
  openDatabase,
  openStorage,
} from "../src/index.js";
import { createDbTestContext, expectNotNull } from "./helpers.js";

describe("WAL 模式", () => {
  const ctx = createDbTestContext();
  afterAll(() => ctx.dispose());

  it("文件库 journal_mode 为 wal", () => {
    const db = ctx.track(openStorage(ctx.nextDbPath()));
    const mode = db.prepare("PRAGMA journal_mode").get();
    expect(String(mode?.journal_mode).toLowerCase()).toBe("wal");
  });

  it("写数据后不 close 原连接，另开新连接能读到（WAL 可见性）", () => {
    const path = ctx.nextDbPath();
    const writer = ctx.track(openStorage(path)); // 故意不 close，保持到 afterAll
    const projects = new ProjectRepository(writer);
    projects.create({ name: "WAL", rootPath: "D:\\wal-visibility" });

    const reader = ctx.track(openDatabase(path)); // 同一文件、独立新连接
    const readerProjects = new ProjectRepository(reader);
    expect(readerProjects.findAll()).toHaveLength(1);
  });
});

// 崩溃恢复（TASK_LIST P0-04 验收第 3 条"崩溃后 WAL 恢复"，spec-review finding 4）：
// 子进程直接 SQL 写入并提交后，被 TerminateProcess 等效强杀（不 close、不 checkpoint），
// 留下未 checkpoint 的 WAL 文件。重新打开连接时 SQLite 必须能恢复出已提交帧。

/** 子进程脚本（纯 JS 字符串；-e 默认 CommonJS，node:sqlite 是 Node 24 内置模块）。 */
const CRASH_CHILD_SCRIPT = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.AETHER_CRASH_DB);
db.exec("PRAGMA busy_timeout=5000");
const now = new Date().toISOString();
// 照抄 task 表列结构直插 SQL（列序同 task.repository 的 INSERT_SQL）
db.prepare(
  "INSERT INTO task (id, project_id, parent_task_id, title, description, status, assignee_agent_profile_id, position, created_at, updated_at) VALUES (?, ?, NULL, ?, '', 'todo', NULL, 0, ?, ?)"
).run(
  process.env.AETHER_CRASH_TASK_ID,
  process.env.AETHER_CRASH_PROJECT_ID,
  "子进程崩溃前已提交",
  now,
  now
);
process.stdout.write("READY\\n");
setInterval(() => {}, 1000); // 挂起等待被强杀：绝不 close、绝不 checkpoint
`;

describe("崩溃后 WAL 恢复", () => {
  const ctx = createDbTestContext();
  afterAll(() => ctx.dispose());

  it(
    "子进程写库后被强杀（无 close/checkpoint）：重开连接恢复出已提交行、integrity ok、仍为 wal",
    { timeout: 20_000 },
    async () => {
      // 1) 父进程建库（迁移 + 种子）并写入基准行，随后正常关闭
      const path = ctx.nextDbPath();
      const setup = openStorage(path);
      const projects = new ProjectRepository(setup);
      const tasks = new TaskRepository(setup);
      const project = projects.create({ name: "Crash", rootPath: "D:\\crash-recovery" });
      const baselineTask = tasks.create({ projectId: project.id, title: "崩溃前基准行" });
      closeDatabase(setup);

      // 2) spawn 子进程：同一文件库直插一行已知 task，stdout 报 READY 后挂起
      const childTaskId = randomUUID();
      const child = spawn(process.execPath, ["-e", CRASH_CHILD_SCRIPT], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          AETHER_CRASH_DB: path,
          AETHER_CRASH_PROJECT_ID: project.id,
          AETHER_CRASH_TASK_ID: childTaskId,
        },
      });
      const stdout = child.stdout;
      const stderr = child.stderr;
      if (stdout === null || stderr === null) {
        child.kill();
        throw new Error("不可达：stdio pipe 下 stdout/stderr 必存在");
      }
      let childStderr = "";
      stderr.setEncoding("utf8");
      stderr.on("data", (chunk: string) => {
        childStderr += chunk;
      });

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("等待子进程 READY 超时（10s）"));
        }, 10_000);
        let received = "";
        const onExit = (code: number | null, signal: string | null): void => {
          clearTimeout(timer);
          reject(new Error(`子进程在 READY 前退出：code=${code} signal=${signal} ${childStderr}`));
        };
        child.on("exit", onExit);
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        stdout.setEncoding("utf8");
        stdout.on("data", (chunk: string) => {
          received += chunk;
          if (received.includes("READY")) {
            clearTimeout(timer);
            child.off("exit", onExit);
            resolve();
          }
        });
      });

      // 3) 读到 READY 即强杀（Windows 映射 TerminateProcess，等效崩溃），等 exit 事件再断言
      child.kill();
      await once(child, "exit");

      // 强杀后 -wal 边车文件仍在且非空（子进程未 close/checkpoint，单行远低于
      // auto-checkpoint 阈值）：第 4 步的恢复必然来自未 checkpoint 的 WAL 帧
      const walStat = statSync(`${path}-wal`);
      expect(walStat.size).toBeGreaterThan(0);

      // 4) 重新打开：已提交的基准行与子进程行都存活、库完整、journal_mode 仍为 wal
      const db = ctx.track(openDatabase(path));
      const integrity = db.prepare("PRAGMA integrity_check").get();
      expect(String(integrity?.integrity_check)).toBe("ok");
      const mode = db.prepare("PRAGMA journal_mode").get();
      expect(String(mode?.journal_mode).toLowerCase()).toBe("wal");

      const recoveredTasks = new TaskRepository(db);
      expect(recoveredTasks.findById(baselineTask.id)?.title).toBe("崩溃前基准行");
      const recoveredChildRow = expectNotNull(recoveredTasks.findById(childTaskId));
      expect(recoveredChildRow.title).toBe("子进程崩溃前已提交");
      expect(recoveredChildRow.projectId).toBe(project.id);
      expect(recoveredChildRow.status).toBe("todo");
    },
  );
});
