import { beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { spawnCommand } from "@aether/process-host";
import type { ExitProof, ProcessHandle } from "@aether/process-host";
import { normalizeStream } from "../src/normalize.js";

// ===== aether-mock-cli 回放断言（P0-07b TDD：fixture 脚本 → 期望 stdout 事件序列）=====
// mock CLI 位于仓库根 fixtures/aether-mock-cli：零依赖纯 Node ESM，读 fixture 脚本
// 按序回放 Claude stream-json 事件流 / Codex JSON-RPC 响应（形状中性）。
// 本文件直接经 process-host spawnCommand 驱动平台包装器：win32=cli.cmd（.cmd 安全
// 转义路径端到端复验 P0-06），POSIX=cli.sh（git 不记录执行位，测试前运行时 chmod +x）。

const MOCK_CLI_DIR = fileURLToPath(
  new URL("../../../../fixtures/aether-mock-cli/", import.meta.url),
);
const WRAPPER = join(MOCK_CLI_DIR, process.platform === "win32" ? "cli.cmd" : "cli.sh");
const FIXTURES_DIR = join(MOCK_CLI_DIR, "fixtures");

/** SDK 首帧控制请求形状（--input-format stream-json 下的 initialize 握手） */
const initRequestLine = (requestId: string): string =>
  JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "initialize" },
  });

const fixturePath = (name: string): string => join(FIXTURES_DIR, name);

// ---- stdout JSONL 收集器（完整行才解析；end 时冲刷无换行尾行）----
interface LineCollector {
  readonly stdout: Readable;
  readonly frames: unknown[];
  stderrText(): string;
  stdoutEnded(): boolean;
}

function collectLines(handle: ProcessHandle): LineCollector {
  const { stdout, stderr } = handle;
  if (stdout === null || stderr === null) {
    throw new Error("mock CLI spawn stdio 必须为 pipe（spawnCommand 默认全管道）");
  }
  stdout.setEncoding("utf8");
  stderr.setEncoding("utf8");
  const frames: unknown[] = [];
  let buffer = "";
  let stderrTail = "";
  const takeLines = (chunk: string): void => {
    buffer = buffer + chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (text.length > 0) frames.push(JSON.parse(text) as unknown);
    }
  };
  stdout.on("data", takeLines);
  stdout.once("end", () => {
    const text = buffer.trim();
    if (text.length > 0) frames.push(JSON.parse(text) as unknown);
    buffer = "";
  });
  stderr.on("data", (chunk: string) => {
    stderrTail += chunk;
  });
  return {
    stdout,
    frames,
    stderrText: () => stderrTail,
    stdoutEnded: () => stdout.readableEnded,
  };
}

/** 一次性运行：写完全部 stdin 行即关 stdin，等进程退出与输出排空 */
async function runMock(
  scriptPath: string,
  stdinLines: readonly string[],
): Promise<{ frames: unknown[]; stderr: string; proof: ExitProof }> {
  const handle = spawnCommand(WRAPPER, [], {
    env: { ...process.env, AETHER_MOCK_SCRIPT: scriptPath },
  });
  const collector = collectLines(handle);
  const stdin = handle.stdin;
  if (stdin === null) throw new Error("mock CLI stdin 必须为 pipe");
  for (const line of stdinLines) {
    stdin.write(`${line}\n`);
  }
  stdin.end();
  const proof = await handle.exited;
  await vi.waitFor(() => expect(collector.stdoutEnded()).toBe(true), { timeout: 10_000 });
  return { frames: collector.frames, stderr: collector.stderrText(), proof };
}

/** 交互式运行：先启动、边读边写（权限往返等需要应答后继续的场景） */
function launchMock(scriptPath: string): LineCollector & {
  readonly exited: Promise<ExitProof>;
  writeLine(line: string): void;
  endInput(): void;
} {
  const handle = spawnCommand(WRAPPER, [], {
    env: { ...process.env, AETHER_MOCK_SCRIPT: scriptPath },
  });
  const collector = collectLines(handle);
  const stdin = handle.stdin;
  if (stdin === null) throw new Error("mock CLI stdin 必须为 pipe");
  return {
    ...collector,
    exited: handle.exited,
    writeLine: (line: string) => {
      stdin.write(`${line}\n`);
    },
    endInput: () => {
      stdin.end();
    },
  };
}

// ---- 帧形状窄化助手（unknown → 具体字段，全运行时检查）----
function fieldOf(frame: unknown, key: string): unknown {
  return typeof frame === "object" && frame !== null && key in frame
    ? (frame as Record<string, unknown>)[key]
    : undefined;
}

const frameType = (frame: unknown): unknown => fieldOf(frame, "type");

function isCanUseToolAsk(frame: unknown): boolean {
  if (frameType(frame) !== "control_request") return false;
  const request = fieldOf(frame, "request");
  return fieldOf(request, "subtype") === "can_use_tool";
}

function assistantText(frame: unknown): string | null {
  if (frameType(frame) !== "assistant") return null;
  const message = fieldOf(frame, "message");
  const content = fieldOf(message, "content");
  if (!Array.isArray(content)) return null;
  const textBlock = content.find(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>).type === "text",
  );
  const text = fieldOf(textBlock, "text");
  return typeof text === "string" ? text : null;
}

beforeAll(() => {
  // POSIX：git 检出不带执行位，测试运行时补上（只改 mode，不改内容）
  if (process.platform !== "win32") {
    chmodSync(WRAPPER, 0o755);
  }
});

describe("aether-mock-cli：claude-stream-json 回放", () => {
  it(
    "happy-path.json → initialize 自动应答 + init/assistant/user/result 帧序 + 退出码 0",
    { timeout: 30_000 },
    async () => {
      const { frames, proof } = await runMock(fixturePath("happy-path.json"), [
        initRequestLine("req-init-1"),
      ]);

      // 首帧 = 对 SDK initialize 控制请求的 success 应答（request_id 原样回显）
      expect(frames[0]).toMatchObject({
        type: "control_response",
        response: { subtype: "success", request_id: "req-init-1" },
      });

      const scriptFrames = frames.slice(1);
      expect(scriptFrames.map((frame) => frameType(frame))).toEqual([
        "system",
        "assistant",
        "assistant",
        "user",
        "result",
      ]);
      const init = scriptFrames[0];
      expect(fieldOf(init, "subtype")).toBe("init");
      expect(fieldOf(init, "session_id")).toBe("ext-mock-happy");
      const result = scriptFrames.at(-1);
      expect(fieldOf(result, "subtype")).toBe("success");
      expect(fieldOf(result, "session_id")).toBe("ext-mock-happy");
      expect(proof.code).toBe(0);

      // 同一批帧经归一化器 → ProviderEvent 序列（P0-09/P0-12 复用同一口径）
      const { events } = normalizeStream({ sessionId: "mock-replay", messages: scriptFrames });
      expect(events.map((event) => event.type)).toEqual([
        "session",
        "status",
        "message",
        "tool_use",
        "tool_result",
        "session",
      ]);
    },
  );

  it(
    "error-exit.json → 声明退出码原样透传（ExitProof 排序契约的 mock 侧输入）",
    { timeout: 30_000 },
    async () => {
      const { frames, proof } = await runMock(fixturePath("error-exit.json"), [
        initRequestLine("req-init-2"),
      ]);
      expect(frames.map((frame) => frameType(frame))).toContain("result");
      expect(proof.code).toBe(3);
    },
  );

  it(
    "permission-ask.json → can_use_tool 控制请求 → 应答 allow 后继续回放（决策回填 $MOCK_LAST_PERM）",
    { timeout: 30_000 },
    async () => {
      const mock = launchMock(fixturePath("permission-ask.json"));
      mock.writeLine(initRequestLine("req-init-3"));
      await vi.waitFor(() => expect(mock.frames.some(isCanUseToolAsk)).toBe(true), {
        timeout: 10_000,
      });

      const ask = mock.frames.find(isCanUseToolAsk);
      const requestId = fieldOf(ask, "request_id");
      expect(requestId).toBe("req-mock-perm");
      mock.writeLine(
        JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: requestId,
            response: { behavior: "allow", toolUseID: "toolu_mock_perm" },
          },
        }),
      );
      mock.endInput();

      const proof = await mock.exited;
      await vi.waitFor(() => expect(mock.stdoutEnded()).toBe(true), { timeout: 10_000 });
      expect(proof.code).toBe(0);
      const decisions = mock.frames
        .map(assistantText)
        .filter((text): text is string => text !== null);
      expect(decisions).toEqual(["决策:allow"]);
      expect(mock.frames.map((frame) => frameType(frame))).toContain("result");
    },
  );
});

describe("aether-mock-cli：codex-json-rpc 回放（形状中性）", () => {
  it(
    "codex-neutral.json → 按 method 匹配回放响应（乱序请求也按各自 method 应答）",
    { timeout: 30_000 },
    async () => {
      const requests = [
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "turn", params: { prompt: "x" } }),
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      ];
      const { frames, proof } = await runMock(fixturePath("codex-neutral.json"), requests);
      expect(frames).toEqual([
        { jsonrpc: "2.0", id: 2, result: { mock: "turn-ok" } },
        { jsonrpc: "2.0", id: 1, result: { mock: "init-ok" } },
      ]);
      expect(proof.code).toBe(0);
    },
  );
});

describe("aether-mock-cli：fixture 手工校验（零依赖，中文报错）", () => {
  it("非法 protocol → 退出码 65 + stderr 指名字段", { timeout: 30_000 }, async () => {
    const workdir = await mkdtemp(join(tmpdir(), "aether-mock-cli-invalid-"));
    try {
      const scriptPath = join(workdir, "invalid.json");
      await writeFile(scriptPath, JSON.stringify({ protocol: "bogus", events: [] }), "utf8");
      const { stderr, proof } = await runMock(scriptPath, []);
      expect(proof.code).toBe(65);
      expect(stderr).toContain("protocol");
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  });

  it("缺 AETHER_MOCK_SCRIPT → 退出码 64 + stderr 提示环境变量", { timeout: 30_000 }, async () => {
    const handle = spawnCommand(WRAPPER, [], { env: { ...process.env, AETHER_MOCK_SCRIPT: "" } });
    const collector = collectLines(handle);
    const proof = await handle.exited;
    await vi.waitFor(() => expect(collector.stdoutEnded()).toBe(true), { timeout: 10_000 });
    expect(proof.code).toBe(64);
    expect(collector.stderrText()).toContain("AETHER_MOCK_SCRIPT");
  });
});
