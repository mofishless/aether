#!/usr/bin/env node
// ===== aether-mock-cli：scripted 回放 mock CLI（P0-07b）=====
// 零 npm 依赖的纯 Node ESM：读 fixture 脚本，按序向 stdout 回放
// Claude stream-json 事件流或 Codex JSON-RPC 响应（形状中性），写完按脚本
// 声明的退出码退出。适配器侧用法：config.cliPath 指向本目录平台包装器
// （win32=cli.cmd / POSIX=cli.sh），环境变量 AETHER_MOCK_SCRIPT 指向 fixture。
// 未知 argv 一律宽容忽略（真实 CLI 的 --print/--output-format 等全不需要认识）。
// 退出码约定：64=环境变量缺失/脚本不可读；65=fixture 校验失败；其余=脚本声明值。
import { readFileSync } from "node:fs";
import { validateFixture } from "./lib/validate.mjs";
import { replayClaudeStream } from "./lib/claude-replay.mjs";
import { replayCodexRpc } from "./lib/codex-replay.mjs";

const EXIT_USAGE = 64;
const EXIT_DATA = 65;

function fail(code, message) {
  process.stderr.write(`[aether-mock-cli] ${message}\n`);
  process.exit(code);
}

// 回放完成后的退出：Windows 管道下 stdout 是异步句柄，直接 process.exit 可能
// 丢弃仍在内部队列的写入（最后一帧截断 → SDK 挂死且难复现）。先 end() 等
// finish（全部缓冲已交付给 OS）再按声明退出码退出——确定性回放引擎的硬要求。
async function flushAndExit(code) {
  await new Promise((resolve) => process.stdout.end(resolve));
  process.exit(code);
}

function textOfError(error) {
  return error instanceof Error ? error.message : String(error);
}

function main() {
  const scriptPath = process.env.AETHER_MOCK_SCRIPT;
  if (typeof scriptPath !== "string" || scriptPath.length === 0) {
    fail(EXIT_USAGE, "缺少环境变量 AETHER_MOCK_SCRIPT（fixture 脚本文件路径）");
  }
  let raw;
  try {
    raw = readFileSync(scriptPath, "utf8");
  } catch (error) {
    fail(EXIT_USAGE, `fixture 脚本不可读：${scriptPath}（${textOfError(error)}）`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(EXIT_DATA, `fixture 不是合法 JSON：${scriptPath}（${textOfError(error)}）`);
  }
  let fixture;
  try {
    fixture = validateFixture(parsed);
  } catch (error) {
    fail(EXIT_DATA, `fixture 校验失败：${scriptPath}（${textOfError(error)}）`);
  }

  const io = { stdin: process.stdin, stdout: process.stdout, argv: process.argv.slice(2) };
  const runner = fixture.protocol === "claude-stream-json" ? replayClaudeStream : replayCodexRpc;
  runner(fixture, io).then(
    () => {
      void flushAndExit(fixture.exitCode);
    },
    (error) => {
      fail(EXIT_DATA, `回放失败：${textOfError(error)}`);
    },
  );
}

main();
