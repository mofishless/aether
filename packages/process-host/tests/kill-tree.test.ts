// P0-06 核心验收：三层进程树（A→B→C）+ B/C 各带一个长驻哨兵孙进程，
// killTree(A) 后 Windows 与 POSIX 均无孤儿存活（轮询 ESRCH 判消失：100ms 间隔 / 5s 预算），
// 且 A 的 ExitProof 字段正确。
// fixture 全部内联（spawn(execPath, ["-e", script])，不新增 fixture 文件）；
// 每层启动即向 stdout 打单行 JSON {layer,pid,parentPid}，逐层 pipe 上浮到 A 的 stdout 供测试收集。
import { afterAll, describe, expect, it } from "vitest";
import type { Readable } from "node:stream";
import { killTree, spawnTracked } from "../src/index.js";
import { isPidAlive, waitForPidsGone } from "./helpers/process.js";

const IS_WIN = process.platform === "win32";
const LAYERS = ["a", "b", "c", "sentinel-b", "sentinel-c"] as const;
type Layer = (typeof LAYERS)[number];

// ---------- fixture 脚本（自底向上内联嵌入） ----------

/** 长驻哨兵：上报自身 pid 后进入保活循环 */
function sentinelScript(layer: Layer): string {
  return [
    `console.log(JSON.stringify({ layer: ${JSON.stringify(layer)}, pid: process.pid, parentPid: process.ppid }));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
}

/** C：上报自身，再 spawn 哨兵（stdout 接力上浮），保活 */
const C_SCRIPT = [
  'const { spawn } = require("node:child_process");',
  'console.log(JSON.stringify({ layer: "c", pid: process.pid, parentPid: process.ppid }));',
  `const sentinel = spawn(process.execPath, ["-e", ${JSON.stringify(sentinelScript("sentinel-c"))}], { stdio: ["ignore", "pipe", "ignore"] });`,
  "sentinel.stdout.pipe(process.stdout);",
  "setInterval(() => {}, 1000);",
].join("\n");

/** B：上报自身，spawn C 与自己的哨兵（均 pipe 上浮），保活 */
const B_SCRIPT = [
  'const { spawn } = require("node:child_process");',
  'console.log(JSON.stringify({ layer: "b", pid: process.pid, parentPid: process.ppid }));',
  `const child = spawn(process.execPath, ["-e", ${JSON.stringify(C_SCRIPT)}], { stdio: ["ignore", "pipe", "ignore"] });`,
  "child.stdout.pipe(process.stdout);",
  `const sentinel = spawn(process.execPath, ["-e", ${JSON.stringify(sentinelScript("sentinel-b"))}], { stdio: ["ignore", "pipe", "ignore"] });`,
  "sentinel.stdout.pipe(process.stdout);",
  "setInterval(() => {}, 1000);",
].join("\n");

/** A（树根，被测树杀目标）：上报自身，spawn B，保活 */
const A_SCRIPT = [
  'const { spawn } = require("node:child_process");',
  'console.log(JSON.stringify({ layer: "a", pid: process.pid, parentPid: process.ppid }));',
  `const child = spawn(process.execPath, ["-e", ${JSON.stringify(B_SCRIPT)}], { stdio: ["ignore", "pipe", "ignore"] });`,
  "child.stdout.pipe(process.stdout);",
  "setInterval(() => {}, 1000);",
].join("\n");

// ---------- 收集器与兜底清理 ----------

/** 从 A 的 stdout 收齐 5 个 layer 的 pid（10s 未收齐则失败并列出缺口） */
function collectLayerPids(stdout: Readable): Promise<Map<Layer, number>> {
  return new Promise((resolve, reject) => {
    const found = new Map<Layer, number>();
    let buffer = "";
    const timer = setTimeout(() => {
      const seen = [...found.entries()].map(([layer, pid]) => `${layer}=${pid}`).join(" ") || "无";
      reject(new Error(`10s 内未收齐层 pid 上报（已收到: ${seen}）`));
    }, 10_000);
    const consume = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return; // 非 JSON 行忽略
      }
      if (typeof parsed !== "object" || parsed === null) return;
      const record = parsed as { layer?: unknown; pid?: unknown };
      if (
        typeof record.layer === "string" &&
        (LAYERS as readonly string[]).includes(record.layer) &&
        typeof record.pid === "number"
      ) {
        found.set(record.layer as Layer, record.pid);
        if (LAYERS.every((layer) => found.has(layer))) {
          clearTimeout(timer);
          resolve(found);
        }
      }
    };
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        consume(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    });
    stdout.on("end", () => {
      clearTimeout(timer);
      reject(new Error("A 的 stdout 提前关闭，未收齐层 pid 上报"));
    });
  });
}

/** 全部已知 pid 的兜底清杀：afterAll 防孤儿（绝不抛） */
const trackedPids = new Set<number>();

afterAll(async () => {
  for (const pid of trackedPids) {
    if (!isPidAlive(pid)) continue;
    try {
      if (IS_WIN) {
        const { spawn } = await import("node:child_process");
        await new Promise<void>((resolve) => {
          const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
          killer.on("close", () => resolve());
          killer.on("error", () => resolve());
        });
      } else {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // 已消失
          }
        }
      }
    } catch {
      // 兜底绝不抛
    }
  }
}, 20_000);

// ---------- 测试 ----------

describe("killTree：进程树击杀（P0-06 核心验收）", () => {
  it("三层树 + 双哨兵：killTree(A) 后全部 PID 消失无孤儿，A 的 ExitProof 字段正确", async () => {
    // POSIX 需 detached 进程组模式（pgid=A.pid，后代同组）；Windows 走 taskkill /T /F（组概念不适用）
    const handle = spawnTracked(
      process.execPath,
      ["-e", A_SCRIPT],
      IS_WIN ? {} : { detached: true },
    );
    const pidA = handle.pid;
    expect(pidA).not.toBeNull();
    if (pidA === null) throw new Error("A 未创建");
    trackedPids.add(pidA);

    const stdout = handle.stdout;
    if (stdout === null) throw new Error("A 的 stdout 应默认可读");
    const seen = await collectLayerPids(stdout);
    const pidB = seen.get("b");
    const pidC = seen.get("c");
    const pidS1 = seen.get("sentinel-b");
    const pidS2 = seen.get("sentinel-c");
    if (pidB === undefined || pidC === undefined || pidS1 === undefined || pidS2 === undefined) {
      throw new Error("收齐守卫失效：layer pid 缺失");
    }
    // 层间 pid 互异（确实是 5 个独立进程）
    expect(new Set([pidA, pidB, pidC, pidS1, pidS2]).size).toBe(5);
    for (const pid of [pidB, pidC, pidS1, pidS2]) trackedPids.add(pid);

    const result = await killTree(handle);
    expect(result.method).toBe(IS_WIN ? "taskkill" : "process-group");
    expect(result.alreadyGone).toBe(false);

    // 验收主体：轮询断言 5 个 PID 全部消失（无孤儿）
    await waitForPidsGone([pidA, pidB, pidC, pidS1, pidS2]);

    // PID 级退出证明
    const proof = await handle.exited;
    expect(proof.pid).toBe(pidA);
    expect(proof.killedByUs).toBe(true);
    if (IS_WIN) {
      // taskkill /F → TerminateProcess：有退出码、无信号
      expect(proof.signal).toBeNull();
      expect(proof.code).toBe(1);
    } else {
      expect(proof.signal).toBe("SIGKILL");
      expect(proof.code).toBeNull();
    }

    for (const pid of [pidA, pidB, pidC, pidS1, pidS2]) trackedPids.delete(pid);
  }, 20_000);

  it.skipIf(IS_WIN)(
    "POSIX 进程组模式：detached 句柄 pgid=pid，非 detached 为 null（win32 恒 null）",
    async () => {
      const detachedHandle = spawnTracked(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000);"],
        {
          detached: true,
        },
      );
      const attachedHandle = spawnTracked(process.execPath, ["-e", "process.exit(0)"]);
      const detachedPid = detachedHandle.pid;
      if (detachedPid === null) throw new Error("detached 进程未创建");
      trackedPids.add(detachedPid);
      try {
        const pgid = detachedHandle.pgid;
        expect(pgid).toBe(detachedPid);
        expect(attachedHandle.pgid).toBeNull();
        // 进程组真实存在：kill(-pgid, 0) 探活不抛
        if (pgid !== null) {
          expect(() => process.kill(-pgid, 0)).not.toThrow();
        }
      } finally {
        await killTree(detachedHandle);
        const proof = await detachedHandle.exited;
        expect(proof.killedByUs).toBe(true);
        trackedPids.delete(detachedPid);
      }
    },
    20_000,
  );

  it("对已退出的进程树杀：alreadyGone=true 不抛（幂等收尾）", async () => {
    const handle = spawnTracked(process.execPath, ["-e", "process.exit(0)"]);
    const firstProof = await handle.exited;
    expect(firstProof.code).toBe(0);
    const result = await killTree(handle);
    expect(result.alreadyGone).toBe(true);
    // 裸 pid 入参同样收敛不抛
    if (handle.pid !== null) {
      const byPid = await killTree(handle.pid);
      expect(byPid.alreadyGone).toBe(true);
    }
  }, 20_000);
});
