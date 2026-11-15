// spawn 协议测试（阶段 2 主进程 supervisor 依赖的稳定契约）：
// 1) 缺 AETHER_DAEMON_TOKEN → stderr 报错 + 退出码 1；
// 2) 正常路径 → stdout 单行 {"type":"listening","port":N} → WS 握手 → system.version → system.shutdown → 退出码 0。
// dist 由 tsup 构建脚本产出（首个用例触发 buildDaemon()，模块级 promise 记忆化，整个文件只构建一次；显式超时）。
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@aether/contracts";
import { connect, helloFrame, nextMessage, rpcRequest, TEST_TOKEN } from "./helpers.js";

const daemonDist = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

let buildPromise: Promise<void> | undefined;

function buildDaemon(): Promise<void> {
  buildPromise ??= new Promise((resolve, reject) => {
    // Windows 下 pnpm 为 .cmd，需 shell: true（参数均为固定字面量，无注入面）
    const child = spawn("pnpm", ["--filter", "@aether/daemon", "build"], {
      cwd: repoRoot,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`daemon build 失败（exit ${code}）：${stderr}`));
    });
  });
  return buildPromise;
}

interface SpawnedDaemon {
  child: ChildProcess;
  stdoutLines: string[];
  stderrText: string;
  /** 等待 stdout 出现 listening 行；子进程提前退出则带 stderr 拒绝 */
  waitListening(timeoutMs?: number): Promise<number>;
  /** 等待子进程退出，返回退出码 */
  waitExit(timeoutMs?: number): Promise<number | null>;
}

function spawnDaemon(args: string[], env: NodeJS.ProcessEnv): SpawnedDaemon {
  const child = spawn(process.execPath, [daemonDist, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutLines: string[] = [];
  let stderrText = "";
  let stdoutText = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutText += chunk.toString();
    let newlineIndex = stdoutText.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = stdoutText.slice(0, newlineIndex).trim();
      if (line.length > 0) stdoutLines.push(line);
      stdoutText = stdoutText.slice(newlineIndex + 1);
      newlineIndex = stdoutText.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString();
  });

  const waitExit = (timeoutMs = 10_000): Promise<number | null> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`daemon 未在 ${timeoutMs}ms 内退出`)),
        timeoutMs,
      );
      // 'close'（而非 'exit'）：Windows 上 stdio 可能在 exit 之后才刷完，close 保证 stderr 已收齐
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

  const waitListening = (timeoutMs = 15_000): Promise<number> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`daemon 未在 ${timeoutMs}ms 内输出 listening 行；stderr=${stderrText}`));
      }, timeoutMs);
      const poll = () => {
        const listeningLine = stdoutLines.find((line) => line.startsWith('{"type":"listening"'));
        if (listeningLine !== undefined) {
          clearTimeout(timer);
          try {
            const parsed = JSON.parse(listeningLine) as { type?: unknown; port?: unknown };
            if (parsed.type !== "listening" || typeof parsed.port !== "number") {
              throw new Error(`listening 行格式不符：${listeningLine}`);
            }
            resolve(parsed.port);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
          return;
        }
        if (child.exitCode !== null) {
          clearTimeout(timer);
          reject(new Error(`daemon 提前退出（exit ${child.exitCode}）：${stderrText}`));
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    });

  // stderrText 必须用 getter：string 是按值快照，直接放对象里会永远停留在创建时的 ""
  return {
    child,
    stdoutLines,
    get stderrText() {
      return stderrText;
    },
    waitListening,
    waitExit,
  };
}

function tokenEnv(token?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AETHER_DAEMON_TOKEN;
  if (token !== undefined) env.AETHER_DAEMON_TOKEN = token;
  return env;
}

describe("daemon spawn 协议", () => {
  it("缺 AETHER_DAEMON_TOKEN → stderr 报错 + 退出码 1", async () => {
    await buildDaemon();
    const daemon = spawnDaemon([], tokenEnv());
    const code = await daemon.waitExit(10_000);
    expect(code).toBe(1);
    expect(daemon.stderrText).toContain("AETHER_DAEMON_TOKEN");
    expect(daemon.stdoutLines).toEqual([]);
  }, 30_000);

  it("正常路径：listening 行 → 握手 → version → shutdown → 退出码 0", async () => {
    await buildDaemon();
    const daemon = spawnDaemon([], tokenEnv(TEST_TOKEN));
    const port = await daemon.waitListening(15_000);

    const ws = await connect(port);
    try {
      ws.send(helloFrame(TEST_TOKEN, PROTOCOL_VERSION));
      const welcome = JSON.parse(await nextMessage(ws)) as { type?: string };
      expect(welcome.type).toBe("welcome");

      const versionResponse = (await rpcRequest(ws, 1, "system.version")) as { result?: unknown };
      expect(versionResponse.result).toEqual({
        daemonVersion: "0.0.1",
        protocolVersion: PROTOCOL_VERSION,
      });

      const shutdownResponse = (await rpcRequest(ws, 2, "system.shutdown")) as { result?: unknown };
      expect(shutdownResponse.result).toBeNull();
    } finally {
      ws.close(1000);
    }

    expect(await daemon.waitExit(10_000)).toBe(0);
    // stdout 除 listening 行外不得有其他输出（父进程按行解析 stdout）
    expect(daemon.stdoutLines).toEqual([`{"type":"listening","port":${port}}`]);
  }, 45_000);
});
