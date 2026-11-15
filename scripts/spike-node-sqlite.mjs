#!/usr/bin/env node
// P0-01 spike：验证 node:sqlite 在 ELECTRON_RUN_AS_NODE 模式（daemon 未来运行时）下可用。
//
// 背景（TECH_STACK §1.4 D2）：daemon 由主进程用 process.execPath + ELECTRON_RUN_AS_NODE=1 拉起，
// SQLite 驱动定案 node:sqlite，前提是 Electron 内置 Node ≥ 22.5 且该模块在其运行时可用。
//
// 判定：退出码 0 = spike 通过（D2 定案成立）；非 0 = 触发唯一回退条件（改 better-sqlite3，需登记 ADR）。
//
// 用法：node scripts/spike-node-sqlite.mjs（或 pnpm spike:node-sqlite）

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

async function runChecks(dbDir) {
  const assert = (await import("node:assert/strict")).default;
  const { DatabaseSync } = await import("node:sqlite");

  console.log(`[spike] Electron ${process.versions.electron} / 内置 Node ${process.versions.node}`);

  // 1) 内存库：建表 + prepared statements CRUD
  const mem = new DatabaseSync(":memory:");
  mem.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  mem.prepare("INSERT INTO t (name) VALUES (?)").run("aether");
  const row = mem.prepare("SELECT name FROM t WHERE id = ?").get(1);
  assert.equal(row?.name, "aether", "内存库写入/读回应一致");
  mem.close();

  // 2) 文件库：WAL 生效 + 关闭重开后数据持久
  const dbPath = join(dbDir, "spike.db");
  const db = new DatabaseSync(dbPath);
  const mode = db.prepare("PRAGMA journal_mode=WAL").get();
  assert.equal(String(mode?.journal_mode).toLowerCase(), "wal", "journal_mode 应为 wal");
  db.exec("CREATE TABLE checkpoint (k TEXT PRIMARY KEY, v TEXT)");
  db.prepare("INSERT INTO checkpoint (k, v) VALUES (?, ?)").run("driver", "node:sqlite");
  db.close();

  const reopened = new DatabaseSync(dbPath);
  const got = reopened.prepare("SELECT v FROM checkpoint WHERE k = ?").get("driver");
  assert.equal(got?.v, "node:sqlite", "重开后数据应持久");
  reopened.close();

  console.log(
    "[spike] SPIKE OK：node:sqlite 在 ELECTRON_RUN_AS_NODE 模式可用（内存 CRUD / 文件 WAL / prepared statements / 重开持久化）",
  );
}

function main() {
  const electronBinary = require("electron");
  const dbDir = mkdtempSync(join(tmpdir(), "aether-spike-"));
  try {
    const result = spawnSync(electronBinary, [process.argv[1]], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        AETHER_SPIKE_CHILD: "1",
        AETHER_SPIKE_DB_DIR: dbDir,
      },
      stdio: "inherit",
    });
    if (result.error) {
      console.error(`[spike] 启动 Electron 失败：${result.error.message}`);
      process.exit(1);
    }
    process.exit(result.status ?? 1);
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
}

if (process.env.AETHER_SPIKE_CHILD === "1") {
  await runChecks(process.env.AETHER_SPIKE_DB_DIR ?? tmpdir());
} else {
  main();
}
