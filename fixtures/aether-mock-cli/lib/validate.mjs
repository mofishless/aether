// ===== fixture 脚本手工校验（零依赖：fixtures 目录不 import zod）=====
// 形状检查 + 中文报错（指名到字段路径）；规范化为引擎直接可用的形状后冻结返回。
// 脚本格式（顶层）：
//   { protocol: "claude-stream-json" | "codex-json-rpc",
//     exitCode?: 0..255（默认 0）,
//     description?: string,
//     events?:   [entry, ...]   // claude-stream-json
//     responses?: [entry, ...]  // codex-json-rpc }
// claude entry：裸帧对象（原样回放），或 { delayMs?: number, emit: 帧对象 } 包装。
// codex entry：{ method?: string, result?: unknown, error?: {code,message}, delayMs?: number }。

const PROTOCOLS = ["claude-stream-json", "codex-json-rpc"];
const MAX_DELAY_MS = 60_000;
const ALLOWED_TOP_KEYS = ["protocol", "exitCode", "description", "events", "responses"];

function bad(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkDelayMs(entryLabel, value) {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_DELAY_MS) {
    bad(
      `${entryLabel}.delayMs 必须是 0..${MAX_DELAY_MS} 的整数毫秒数（当前值：${JSON.stringify(value)}）`,
    );
  }
  return value;
}

/** 校验并规范化 claude-stream-json 的单个事件条目 */
function validateClaudeEntry(entry, index) {
  const label = `events[${index}]`;
  if (!isPlainObject(entry)) {
    bad(`${label} 必须是对象（裸帧或 { delayMs, emit } 包装），当前类型：${typeof entry}`);
  }
  if ("emit" in entry) {
    const frame = entry.emit;
    if (!isPlainObject(frame)) {
      bad(`${label}.emit 必须是帧对象，当前类型：${typeof frame}`);
    }
    if ("delayMs" in frame) {
      bad(`${label}.emit 内出现 delayMs 字段——delayMs 属于包装层，应写作 { delayMs, emit }`);
    }
    return Object.freeze({ delayMs: checkDelayMs(label, entry.delayMs), frame });
  }
  if ("delayMs" in entry) {
    bad(`${label} 携带 delayMs 但不是 { delayMs, emit } 包装（裸帧内写 delayMs 会污染回放帧）`);
  }
  return Object.freeze({ delayMs: 0, frame: entry });
}

/** 校验并规范化 codex-json-rpc 的单个响应条目 */
function validateCodexEntry(entry, index) {
  const label = `responses[${index}]`;
  if (!isPlainObject(entry)) {
    bad(`${label} 必须是对象，当前类型：${typeof entry}`);
  }
  if (entry.method !== undefined && typeof entry.method !== "string") {
    bad(`${label}.method 必须是字符串（JSON-RPC method 名，缺省=按序兜底）`);
  }
  if (entry.error !== undefined) {
    const error = entry.error;
    if (
      !isPlainObject(error) ||
      !Number.isInteger(error.code) ||
      typeof error.message !== "string"
    ) {
      bad(`${label}.error 必须是 { code: 整数, message: 字符串 }`);
    }
  }
  return Object.freeze({
    method: entry.method ?? null,
    result: entry.result ?? null,
    error: entry.error,
    delayMs: checkDelayMs(label, entry.delayMs),
  });
}

/**
 * 校验 fixture 根对象 → 规范化形状：
 *   claude-stream-json：{ protocol, exitCode, description, entries: [{delayMs, frame}] }
 *   codex-json-rpc：    { protocol, exitCode, description, responses: [{method,result,error,delayMs}] }
 * 校验失败抛 Error（中文消息），由 cli.mjs 统一转退出码 65。
 */
export function validateFixture(raw) {
  if (!isPlainObject(raw)) {
    bad(`fixture 顶层必须是对象，当前类型：${Array.isArray(raw) ? "数组" : typeof raw}`);
  }
  const unknownKeys = Object.keys(raw).filter((key) => !ALLOWED_TOP_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    bad(
      `fixture 含未知顶层字段 ${unknownKeys.map((k) => `'${k}'`).join("、")}（允许：${ALLOWED_TOP_KEYS.join("/")}）`,
    );
  }
  if (typeof raw.protocol !== "string" || !PROTOCOLS.includes(raw.protocol)) {
    bad(
      `protocol 必须是 ${PROTOCOLS.map((p) => `'${p}'`).join(" 或 ")}（当前值：${JSON.stringify(raw.protocol)}）`,
    );
  }
  let exitCode = 0;
  if (raw.exitCode !== undefined) {
    if (!Number.isInteger(raw.exitCode) || raw.exitCode < 0 || raw.exitCode > 255) {
      bad(`exitCode 必须是 0..255 的整数（当前值：${JSON.stringify(raw.exitCode)}）`);
    }
    exitCode = raw.exitCode;
  }
  if (raw.description !== undefined && typeof raw.description !== "string") {
    bad("description 必须是字符串");
  }

  if (raw.protocol === "claude-stream-json") {
    if (raw.responses !== undefined) {
      bad("protocol=claude-stream-json 时顶层字段应为 events（不接受 responses）");
    }
    if (!Array.isArray(raw.events)) {
      bad("events 必须是数组（要回放的帧序列）");
    }
    const entries = Object.freeze(
      raw.events.map((entry, index) => validateClaudeEntry(entry, index)),
    );
    return Object.freeze({
      protocol: raw.protocol,
      exitCode,
      description: raw.description ?? null,
      entries,
    });
  }

  if (raw.events !== undefined) {
    bad("protocol=codex-json-rpc 时顶层字段应为 responses（不接受 events）");
  }
  if (!Array.isArray(raw.responses)) {
    bad("responses 必须是数组（脚本化 JSON-RPC 响应序列）");
  }
  const responses = Object.freeze(
    raw.responses.map((entry, index) => validateCodexEntry(entry, index)),
  );
  return Object.freeze({
    protocol: raw.protocol,
    exitCode,
    description: raw.description ?? null,
    responses,
  });
}
