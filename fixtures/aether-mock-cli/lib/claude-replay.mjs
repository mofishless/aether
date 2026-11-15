// ===== Claude stream-json 回放引擎 =====
// 行为契约（与 @anthropic-ai/claude-agent-sdk 0.3.325 的 stdio 传输对齐）：
// - stdin 门控：SDK 以 --input-format stream-json 先写 initialize 控制请求与
//   prompt，默认等第一条 stdin 行（或 stdin 关闭）再开始回放；
//   AETHER_MOCK_STDIN_GATE=0 关闭门控（手工调试直接回放）。
// - SDK→CLI control_request（initialize 等）：一律自动回 success control_response
//   （request_id 原样回显）——不应答会让 SDK 的初始化承诺挂死。
// - CLI→SDK control_request(can_use_tool)（脚本帧）：写出后阻塞等 stdin 上匹配
//   request_id 的 control_response；超时 AETHER_MOCK_PERM_TIMEOUT_MS（默认 30s），
//   超时按 "timeout" 继续，不中断回放。
// - token 替换（发出时求值）：$MOCK_ARGV=收到的 argv 空格连接；$MOCK_LAST_PERM=
//   最近一次权限决策 behavior（无则 "none"）。
import { createInterface } from "node:readline";
import { envInt, parseJsonObject, sleep, substitute, writeLine } from "./runtime.mjs";

const DEFAULT_PERM_TIMEOUT_MS = 30_000;

/** 等待某个 request_id 的权限决策（stdin control_response 或超时） */
function awaitPermissionDecision(waiters, requestId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(requestId);
      resolve("timeout");
    }, timeoutMs);
    waiters.set(requestId, (response) => {
      clearTimeout(timer);
      const behavior = response?.response?.behavior;
      resolve(typeof behavior === "string" ? behavior : "unknown");
    });
  });
}

/**
 * 回放 claude-stream-json fixture：按序写 stdout JSONL，写完 resolve（退出码由 cli.mjs 落）。
 * io = { stdin, stdout, argv }（cli.mjs 注入 process 流与收到的 argv）。
 */
export async function replayClaudeStream(fixture, io) {
  const { stdin, stdout, argv } = io;
  const argvText = argv.join(" ");
  let lastPerm = null;
  const waiters = new Map();

  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  const gateReleased = new Promise((resolve) => {
    lines.once("line", () => resolve("line"));
    lines.once("close", () => resolve("close"));
  });
  lines.on("line", (line) => {
    const message = parseJsonObject(line);
    if (message === null) return; // 未知/非 JSON 行：宽容丢弃
    if (message.type === "control_request") {
      const requestId = typeof message.request_id === "string" ? message.request_id : "unknown";
      void writeLine(stdout, {
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response: {} },
      });
      return;
    }
    if (message.type === "control_response") {
      const response = message.response;
      const requestId = typeof response?.request_id === "string" ? response.request_id : null;
      const waiter = requestId !== null ? waiters.get(requestId) : undefined;
      if (waiter !== undefined) {
        waiters.delete(requestId);
        waiter(response);
      }
    }
  });

  if (process.env.AETHER_MOCK_STDIN_GATE !== "0") {
    await gateReleased;
  }

  const permTimeoutMs = envInt("AETHER_MOCK_PERM_TIMEOUT_MS", DEFAULT_PERM_TIMEOUT_MS);
  for (const entry of fixture.entries) {
    if (entry.delayMs > 0) {
      await sleep(entry.delayMs);
    }
    const frame = substitute(entry.frame, {
      $MOCK_ARGV: argvText,
      $MOCK_LAST_PERM: lastPerm ?? "none",
    });
    await writeLine(stdout, frame);
    const isPermissionAsk =
      frame.type === "control_request" && frame.request?.subtype === "can_use_tool";
    if (isPermissionAsk) {
      lastPerm = await awaitPermissionDecision(waiters, frame.request_id, permTimeoutMs);
    }
  }
}
