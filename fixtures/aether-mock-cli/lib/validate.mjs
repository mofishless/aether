// ===== fixture 脚本手工校验（零依赖：fixtures 目录不 import zod）=====
// 形状检查 + 中文报错（指名到字段路径）；规范化为引擎直接可用的形状后冻结返回。
// 脚本格式（顶层）：
//   { protocol: "claude-stream-json" | "codex-json-rpc" | "codex-app-server",
//     exitCode?: 0..255（默认 0）,
//     description?: string,
//     events?:      [entry, ...]   // claude-stream-json
//     responses?:   [entry, ...]   // codex-json-rpc
//     initialize?:  {...},          // codex-app-server：initialize 应答覆盖
//     turns?:       [turn, ...],   // codex-app-server：turn 回放脚本（按序消费）
//     resume?:      {...}          // codex-app-server：thread/resume 历史声明 }
// claude entry：裸帧对象（原样回放），或 { delayMs?: number, emit: 帧对象 } 包装。
// codex entry：{ method?: string, result?: unknown, error?: {code,message}, delayMs?: number }。
// codex-app-server turn/item/approval 形状见下方各校验函数头注释
// （帧形状唯一规范：docs/research/codex/app-server-protocol.md）。

const PROTOCOLS = ["claude-stream-json", "codex-json-rpc", "codex-app-server"];
const MAX_DELAY_MS = 60_000;
/** 各协议允许的顶层字段（protocol 自身计入；跨协议字段混用即报错） */
const TOP_KEYS_BY_PROTOCOL = {
  "claude-stream-json": ["protocol", "exitCode", "description", "events"],
  "codex-json-rpc": ["protocol", "exitCode", "description", "responses"],
  "codex-app-server": ["protocol", "exitCode", "description", "initialize", "turns", "resume"],
};

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

/** 校验 codex-app-server 的 initialize 覆盖段（四字段均可选字符串，未知键拒绝） */
function validateCodexInitialize(value) {
  const ALLOWED = ["userAgent", "codexHome", "platformFamily", "platformOs"];
  if (value === undefined) return null;
  if (!isPlainObject(value)) {
    bad(`initialize 必须是对象（initialize 应答四字段的覆盖），当前类型：${typeof value}`);
  }
  const unknownKeys = Object.keys(value).filter((key) => !ALLOWED.includes(key));
  if (unknownKeys.length > 0) {
    bad(
      `initialize 含未知字段 ${unknownKeys.map((k) => `'${k}'`).join("、")}（允许：${ALLOWED.join("/")}）`,
    );
  }
  for (const key of Object.keys(value)) {
    if (typeof value[key] !== "string") {
      bad(`initialize.${key} 必须是字符串（当前值：${JSON.stringify(value[key])}）`);
    }
  }
  return Object.freeze({ ...value });
}

/** 校验 codex-app-server 单个回放 item：agentMessage（文本增量）或 commandExecution（含可选审批节点） */
function validateCodexItem(entry, index) {
  const label = `turns[${index.turn}].items[${index.item}]`;
  if (!isPlainObject(entry)) {
    bad(`${label} 必须是对象，当前类型：${typeof entry}`);
  }
  if (entry.type === "agentMessage") {
    const ALLOWED = ["type", "text", "deltas", "delayMs"];
    const unknownKeys = Object.keys(entry).filter((key) => !ALLOWED.includes(key));
    if (unknownKeys.length > 0) {
      bad(
        `${label} 含未知字段 ${unknownKeys.map((k) => `'${k}'`).join("、")}（允许：${ALLOWED.join("/")}）`,
      );
    }
    if (typeof entry.text !== "string" || entry.text.length === 0) {
      bad(`${label}.text 必须是非空字符串`);
    }
    let deltas = 1;
    if (entry.deltas !== undefined) {
      if (!Number.isInteger(entry.deltas) || entry.deltas < 1 || entry.deltas > 64) {
        bad(
          `${label}.deltas 必须是 1..64 的整数（text 均分段数，当前值：${JSON.stringify(entry.deltas)}）`,
        );
      }
      deltas = entry.deltas;
    }
    return Object.freeze({
      type: "agentMessage",
      text: entry.text,
      deltas,
      delayMs: checkDelayMs(label, entry.delayMs),
    });
  }
  if (entry.type === "commandExecution") {
    const ALLOWED = ["type", "command", "cwd", "exitCode", "output", "approval", "delayMs"];
    const unknownKeys = Object.keys(entry).filter((key) => !ALLOWED.includes(key));
    if (unknownKeys.length > 0) {
      bad(
        `${label} 含未知字段 ${unknownKeys.map((k) => `'${k}'`).join("、")}（允许：${ALLOWED.join("/")}）`,
      );
    }
    if (typeof entry.command !== "string" || entry.command.length === 0) {
      bad(`${label}.command 必须是非空字符串`);
    }
    if (entry.cwd !== undefined && typeof entry.cwd !== "string") {
      bad(`${label}.cwd 必须是字符串`);
    }
    if (entry.exitCode !== undefined && !Number.isInteger(entry.exitCode)) {
      bad(`${label}.exitCode 必须是整数（当前值：${JSON.stringify(entry.exitCode)}）`);
    }
    if (entry.output !== undefined && typeof entry.output !== "string") {
      bad(`${label}.output 必须是字符串（审批通过后 item/completed 的 aggregatedOutput）`);
    }
    let approval = null;
    if (entry.approval !== undefined) {
      if (!isPlainObject(entry.approval)) {
        bad(`${label}.approval 必须是对象（声明即在该 item 前发服务端审批请求）`);
      }
      const approvalKeys = Object.keys(entry.approval);
      if (approvalKeys.some((key) => key !== "reason")) {
        bad(`${label}.approval 只允许 reason 字段（当前：${approvalKeys.join("/")}）`);
      }
      if (entry.approval.reason !== undefined && typeof entry.approval.reason !== "string") {
        bad(`${label}.approval.reason 必须是字符串`);
      }
      approval =
        entry.approval.reason !== undefined
          ? Object.freeze({ reason: entry.approval.reason })
          : Object.freeze({});
    }
    return Object.freeze({
      type: "commandExecution",
      command: entry.command,
      cwd: entry.cwd ?? null,
      exitCode: entry.exitCode ?? 0,
      output: entry.output ?? `${entry.command} 完成`,
      approval,
      delayMs: checkDelayMs(label, entry.delayMs),
    });
  }
  bad(
    `${label}.type 必须是 'agentMessage' 或 'commandExecution'（当前值：${JSON.stringify(entry.type)}）`,
  );
}

/** 校验 codex-app-server 的 turns 回放脚本（每个 turn/start 按序消费一项） */
function validateCodexTurns(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    bad(`turns 必须是数组（turn 回放脚本序列），当前类型：${typeof value}`);
  }
  return Object.freeze(
    value.map((entry, turnIndex) => {
      const label = `turns[${turnIndex}]`;
      if (!isPlainObject(entry)) {
        bad(`${label} 必须是对象，当前类型：${typeof entry}`);
      }
      const unknownKeys = Object.keys(entry).filter((key) => key !== "delayMs" && key !== "items");
      if (unknownKeys.length > 0) {
        bad(
          `${label} 含未知字段 ${unknownKeys.map((k) => `'${k}'`).join("、")}（允许：delayMs/items）`,
        );
      }
      if (!Array.isArray(entry.items)) {
        bad(`${label}.items 必须是数组（逐项回放的 item 脚本）`);
      }
      const items = Object.freeze(
        entry.items.map((item, itemIndex) =>
          validateCodexItem(item, { turn: turnIndex, item: itemIndex }),
        ),
      );
      return Object.freeze({ delayMs: checkDelayMs(label, entry.delayMs), items });
    }),
  );
}

/** 校验 codex-app-server 的 resume 历史声明（thread/resume 无内存记录时的回退素材） */
function validateCodexResume(value) {
  if (value === undefined) return null;
  if (!isPlainObject(value)) {
    bad(`resume 必须是对象 { threadId?, turns }，当前类型：${typeof value}`);
  }
  const unknownKeys = Object.keys(value).filter((key) => key !== "threadId" && key !== "turns");
  if (unknownKeys.length > 0) {
    bad(`resume 含未知字段 ${unknownKeys.map((k) => `'${k}'`).join("、")}（允许：threadId/turns）`);
  }
  if (value.threadId !== undefined && typeof value.threadId !== "string") {
    bad("resume.threadId 必须是字符串（限定可回退的 thread；缺省=任意）");
  }
  if (!Array.isArray(value.turns)) {
    bad("resume.turns 必须是数组（thread/resume 内嵌的全量历史 Turn）");
  }
  const turns = Object.freeze(
    value.turns.map((turn, index) => {
      const label = `resume.turns[${index}]`;
      if (!isPlainObject(turn)) {
        bad(`${label} 必须是对象（Turn 形状），当前类型：${typeof turn}`);
      }
      if (typeof turn.id !== "string") bad(`${label}.id 必须是字符串`);
      if (typeof turn.status !== "string") bad(`${label}.status 必须是字符串`);
      if (!Array.isArray(turn.items)) bad(`${label}.items 必须是数组`);
      return Object.freeze({ ...turn, items: Object.freeze([...turn.items]) });
    }),
  );
  return Object.freeze({
    threadId: value.threadId ?? null,
    turns,
  });
}

/**
 * 校验 fixture 根对象 → 规范化形状：
 *   claude-stream-json：{ protocol, exitCode, description, entries: [{delayMs, frame}] }
 *   codex-json-rpc：    { protocol, exitCode, description, responses: [{method,result,error,delayMs}] }
 *   codex-app-server：  { protocol, exitCode, description, initialize, turns, resume }
 * 校验失败抛 Error（中文消息），由 cli.mjs / codex-server.mjs 统一转退出码 65。
 */
export function validateFixture(raw) {
  if (!isPlainObject(raw)) {
    bad(`fixture 顶层必须是对象，当前类型：${Array.isArray(raw) ? "数组" : typeof raw}`);
  }
  if (typeof raw.protocol !== "string" || !PROTOCOLS.includes(raw.protocol)) {
    bad(
      `protocol 必须是 ${PROTOCOLS.map((p) => `'${p}'`).join(" 或 ")}（当前值：${JSON.stringify(raw.protocol)}）`,
    );
  }
  const allowedTopKeys = TOP_KEYS_BY_PROTOCOL[raw.protocol];
  const unknownKeys = Object.keys(raw).filter((key) => !allowedTopKeys.includes(key));
  if (unknownKeys.length > 0) {
    bad(
      `fixture 含未知顶层字段 ${unknownKeys.map((k) => `'${k}'`).join("、")}（protocol '${raw.protocol}' 允许：${allowedTopKeys.join("/")}）`,
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

  if (raw.protocol === "codex-json-rpc") {
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

  // codex-app-server：initialize 覆盖 + turns 回放脚本 + resume 历史声明（均可缺省）
  return Object.freeze({
    protocol: raw.protocol,
    exitCode,
    description: raw.description ?? null,
    initialize: validateCodexInitialize(raw.initialize),
    turns: validateCodexTurns(raw.turns),
    resume: validateCodexResume(raw.resume),
  });
}
