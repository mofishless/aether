// ===== Codex JSON-RPC 形状中性回放引擎 =====
// stdin 逐行读 JSON-RPC 请求，按脚本回放响应到 stdout：
// - method 匹配优先：取第一个未消费且 method 相同的条目；
// - 无匹配时按序兜底：取第一个未消费且未声明 method 的条目；
// - 两者皆无：静默跳过（宽容，不炸）。
// 不实现真实 Codex app-server 语义——P1-01 实测协议后在 fixtures 与本文件扩展
// （见 README 的扩展位说明）。stdin EOF（或 AETHER_MOCK_STDIN_GATE=0 且脚本耗尽）
// 后结束，退出码由 cli.mjs 按脚本落。
import { createInterface } from "node:readline";
import { parseJsonObject, sleep, substitute, writeLine } from "./runtime.mjs";

/** 选出本次请求该用的响应条目（method 匹配优先，按序兜底）；返回条目或 null */
function pickResponse(entries, usedIndexes, method) {
  let fallbackIndex = -1;
  for (let index = 0; index < entries.length; index += 1) {
    if (usedIndexes.has(index)) continue;
    const entry = entries[index];
    if (entry.method !== null && entry.method === method) {
      usedIndexes.add(index);
      return entry;
    }
    if (entry.method === null && fallbackIndex === -1) {
      fallbackIndex = index;
    }
  }
  if (fallbackIndex !== -1) {
    usedIndexes.add(fallbackIndex);
    return entries[fallbackIndex];
  }
  return null;
}

/**
 * 回放 codex-json-rpc fixture：消费 stdin 请求流直到 EOF，响应写 stdout JSONL。
 * io = { stdin, stdout, argv }（token $MOCK_ARGV 可用于回显收到的 argv）。
 */
export async function replayCodexRpc(fixture, io) {
  const { stdin, stdout, argv } = io;
  const tokens = { $MOCK_ARGV: argv.join(" ") };
  const usedIndexes = new Set();

  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  const closed = new Promise((resolve) => {
    lines.once("close", resolve);
  });
  // 顺序化处理：readline 不等 async 监听器，用 promise 链保请求处理串行
  let tail = Promise.resolve();
  lines.on("line", (line) => {
    tail = tail.then(async () => {
      const request = parseJsonObject(line);
      if (request === null) return;
      if (typeof request.method !== "string") return; // JSON-RPC 请求必须有 method
      const entry = pickResponse(fixture.responses, usedIndexes, request.method);
      if (entry === null) return;
      if (entry.delayMs > 0) {
        await sleep(entry.delayMs);
      }
      const hasId = Object.hasOwn(request, "id");
      const payload =
        entry.error !== undefined
          ? {
              jsonrpc: "2.0",
              id: hasId ? request.id : null,
              error: substitute(entry.error, tokens),
            }
          : {
              jsonrpc: "2.0",
              id: hasId ? request.id : null,
              result: substitute(entry.result, tokens),
            };
      await writeLine(stdout, payload);
    });
  });

  await closed;
  await tail;
}
