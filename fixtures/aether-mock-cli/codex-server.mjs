#!/usr/bin/env node
// ===== aether-mock-cli codex 引擎：codex app-server 协议模拟器入口（P1-01 支撑件）=====
// 与 cli.mjs（Claude stream-json / 形状中性 codex-json-rpc）平行的第二入口：读
// AETHER_MOCK_SCRIPT 指向的 codex-app-server fixture，按协议定案有状态回放
// （帧形状唯一规范：docs/research/codex/app-server-protocol.md）。
// 适配器侧用法：config.cliPath 指向本目录平台包装器（win32=codex-server.cmd /
// POSIX=codex-server.sh），环境变量 AETHER_MOCK_SCRIPT 指向 fixture。
// 退出码约定与 cli.mjs 一致：64=环境变量缺失/脚本不可读；65=fixture 校验失败；
// 其余=脚本声明值（EOF 干净退出按脚本，默认 0）。
import { readFileSync } from "node:fs";
import { validateFixture } from "./lib/validate.mjs";
import { runCodexAppServer } from "./lib/codex-server-engine.mjs";

const EXIT_USAGE = 64;
const EXIT_DATA = 65;

function fail(code, message) {
  process.stderr.write(`[aether-mock-codex] ${message}\n`);
  process.exit(code);
}

// 与 cli.mjs 同因：Windows 管道下 stdout 是异步句柄，直接 process.exit 可能丢弃
// 仍在内部队列的写入（最后一帧截断）。先 end() 等 finish 再按声明退出码退出。
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
  if (fixture.protocol !== "codex-app-server") {
    fail(EXIT_DATA, `fixture protocol 必须是 codex-app-server（当前：${fixture.protocol}）`);
  }

  const io = { stdin: process.stdin, stdout: process.stdout };
  runCodexAppServer(fixture, io).then(
    () => {
      void flushAndExit(fixture.exitCode);
    },
    (error) => {
      fail(EXIT_DATA, `回放失败：${textOfError(error)}`);
    },
  );
}

main();
