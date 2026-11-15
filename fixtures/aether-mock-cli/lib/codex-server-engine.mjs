// ===== codex app-server 协议模拟引擎（P1-01 支撑件）=====
// 按 docs/research/codex/app-server-protocol.md（三源定案）回放，供 daemon/E2E 在
// 无真机 codex、无网络的条件下跑完整 thread/turn/item 旅程。与 lib/codex-replay.mjs
// （形状中性 method 匹配管道，claude 测试在用，帧带 jsonrpc 键）刻意分离：本引擎是
// **有状态协议模拟器**，写出侧全部帧一律无 jsonrpc 键（协议 §1）；通知帧带
// emittedAtMs（发出时刻），请求/响应帧不带（§1 四形状只通知实测带）。
//
// 生命周期语义（对照协议定案）：
// - initialize 唯一免检：完成前任何带 id 请求 → -32600 "Not initialized"（§2.2）。
//   capabilities.experimentalApi 未声明时 initialize 仍成功，但 thread/start 携带
//   approvalPolicy/sandbox/permissions 实验字段 → -32600 "<field> requires
//   experimentalApi capability"（§9 陷阱 2：错误码是 -32600 非 -32602，如实复刻）。
// - thread/start → thread-<n> 自增 id；turn/start → 先应答 {turn: Turn(inProgress)}，
//   再开独立回放任务发通知流 turn/started → item/started → (delta…) → item/completed
//   → … → turn/completed（§3）。
// - 审批节点（fixture 条目声明 approval）：发服务端带 id 请求
//   item/commandExecution/requestApproval，等客户端 {id,result:{decision}} 应答
//   （§4）：accept 系/修订案对象→继续；decline→拒绝该 item 但 turn 继续；
//   cancel→拒绝并 turn/completed(status=interrupted)；超时按 decline（§4 TimedOut）。
// - turn/interrupt → {id,result:{}} 应答；活动回放任务随后发 turn/completed
//   (status=interrupted)（中断结果经 turn/completed 体现，§3）；无活动 turn 时仅应答。
// - thread/resume → 优先同进程已完成 turn 的内存记录；无记录时回退 fixture.resume
//   声明的历史（跨进程恢复素材）；两者皆无 → 空 turns（§5）。
// - stdin EOF：客户端已不可读——中止挂起审批等待与回放任务（不再写帧），由入口按
//   脚本 exitCode 干净退出（§7 单客户端语义的 mock 映射）。
// 平台注意：纯 Node 无平台分支；platformFamily/platformOs 从 process.platform 推导
// （fixture.initialize 可覆盖）；CRLF 由 readline crlfDelay 容错。
import { createInterface } from "node:readline";
import { envInt, parseJsonObject, sleep, writeLine } from "./runtime.mjs";

const DEFAULT_PERM_TIMEOUT_MS = 30_000;
/** thread/start 的实验门控字段（§2.2/§6：sandbox 与 permissions 互斥，此处只做门控枚举） */
const EXPERIMENTAL_FIELDS = ["approvalPolicy", "sandbox", "permissions"];
/** fixture.turns 耗尽后每个 turn/start 的缺省回放脚本（最小单条 agentMessage） */
const DEFAULT_TURN_SCRIPT = Object.freeze({
  delayMs: 0,
  items: Object.freeze([{ type: "agentMessage", text: "mock：turn 完成", deltas: 1 }]),
});

/** 串行化 stdout 写出：背压等待期间并发写会乱序，统一经 promise 链保帧序 */
function createWriter(stdout) {
  let chain = Promise.resolve();
  const write = (frame) => {
    const task = chain.then(() => writeLine(stdout, frame));
    // 前帧失败不卡死后续帧（EPIPE 等：客户端已关管道，写失败静默——EOF 路径另收口）
    chain = task.catch(() => {});
    return task;
  };
  return write;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function log(message) {
  process.stderr.write(`[aether-mock-codex] ${message}\n`);
}

/** 回放停因：EOF → "eof"（静默停）；turn/interrupt 已置旗 → "interrupted"；否则 null 继续 */
function stopReason(state) {
  if (state.eofAborted) return "eof";
  if (state.activeTurn !== null && state.activeTurn.interrupted) return "interrupted";
  return null;
}

/** 审批 decision 分类（§4 值域）：accept 系/修订案对象→accept；decline/timeout→decline；cancel→cancel */
function classifyDecision(decision) {
  if (decision === "cancel") return "cancel";
  if (decision === "decline" || decision === "timeout") return "decline";
  if (decision === "accept" || decision === "acceptForSession") return "accept";
  if (isPlainObject(decision)) return "accept"; // acceptWithExecpolicyAmendment 等修订案对象
  return "decline"; // 未知值宽容按 decline（真实客户端不该发）
}

/** 等一次审批应答：客户端 {id,result} 唤醒 / 超时按 "timeout" / EOF 中止按 "aborted" */
function waitForApproval(state, approvalId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.approvalWaiters.delete(approvalId);
      log(`审批 ${approvalId} 等待超时（${timeoutMs}ms），按 decline 处理（协议 §4 TimedOut）`);
      resolve("timeout");
    }, timeoutMs);
    state.approvalWaiters.set(approvalId, (decision) => {
      clearTimeout(timer);
      state.approvalWaiters.delete(approvalId);
      resolve(decision);
    });
  });
}

/** initialize 应答四字段（§2.2）：平台相关两项从 process.platform 推导，fixture 可覆盖 */
function initializeResult(fixture) {
  const defaults = {
    userAgent: "aether-mock-codex/0.1.0",
    codexHome: "~/.codex",
    platformFamily: process.platform === "win32" ? "windows" : "unix",
    platformOs: process.platform,
  };
  return { ...defaults, ...fixture.initialize };
}

/** 单个 turn 的通知流回放（detached 运行，永不 reject；EOF/中断随时可停） */
async function replayTurn(state, fixture, write, context) {
  const { threadId, turnId, script, startedAt, permTimeoutMs } = context;
  const baseTurn = {
    id: turnId,
    rootTurnId: turnId,
    items: [],
    status: "inProgress",
    error: null,
    startedAt,
    completedAt: null,
    durationMs: null,
  };
  await write({
    method: "turn/started",
    params: { threadId, turn: baseTurn },
    emittedAtMs: Date.now(),
  });

  const completedItems = [];
  let status = "completed";
  for (const item of script.items) {
    // 停因检查在 delay 前后各一次：delay 期间收到的 interrupt/EOF 必须生效
    let stop = stopReason(state);
    if (stop === "eof") return;
    if (stop === "interrupted") {
      status = "interrupted";
      break;
    }
    if (item.delayMs > 0) await sleep(item.delayMs);
    stop = stopReason(state);
    if (stop === "eof") return;
    if (stop === "interrupted") {
      status = "interrupted";
      break;
    }
    const outcome = await replayItem(state, fixture, write, {
      threadId,
      turnId,
      item,
      permTimeoutMs,
    });
    if (outcome.aborted) return;
    completedItems.push(outcome.item);
    if (outcome.interruptTurn) {
      status = "interrupted";
      break;
    }
  }
  if (state.eofAborted) return;

  const completedAt = new Date().toISOString();
  const turn = {
    id: turnId,
    rootTurnId: turnId,
    items: completedItems,
    status,
    error: null,
    startedAt,
    completedAt,
    durationMs: Date.parse(completedAt) - Date.parse(startedAt),
  };
  await write({
    method: "turn/completed",
    params: { threadId, turn },
    emittedAtMs: Date.now(),
  });
  const history = state.historyByThread.get(threadId);
  if (history !== undefined) history.push(turn);
  if (state.activeTurn !== null && state.activeTurn.turnId === turnId) {
    state.activeTurn = null;
  }
}

/** 回放单个 item：started →（审批往返 / delta 流）→ completed；返回完成态 item 与分支 */
async function replayItem(state, fixture, write, context) {
  const { threadId, turnId, item, permTimeoutMs } = context;
  state.itemCounter += 1;
  const itemId = `item-${state.itemCounter}`;

  if (item.type === "agentMessage") {
    await write({
      method: "item/started",
      params: { threadId, turnId, item: { id: itemId, type: "agentMessage", text: "" } },
      emittedAtMs: Date.now(),
    });
    const chunks = splitText(item.text, item.deltas);
    for (const chunk of chunks) {
      if (state.eofAborted) return { aborted: true };
      await write({
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId, delta: chunk },
        emittedAtMs: Date.now(),
      });
    }
    const completed = { id: itemId, type: "agentMessage", text: item.text };
    await write({
      method: "item/completed",
      params: { threadId, turnId, item: completed },
      emittedAtMs: Date.now(),
    });
    return { item: completed, interruptTurn: false };
  }

  // commandExecution：可选审批节点（fixture 声明 approval 即发服务端审批请求）
  const startedItem = { id: itemId, type: "commandExecution", command: item.command };
  if (item.cwd !== null) startedItem.cwd = item.cwd;
  await write({
    method: "item/started",
    params: { threadId, turnId, item: startedItem },
    emittedAtMs: Date.now(),
  });

  let decisionKind = "accept";
  if (item.approval !== null) {
    state.approvalCounter += 1;
    const approvalId = `req-${state.approvalCounter}`;
    await write({
      id: approvalId,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId,
        turnId,
        itemId,
        call: { command: item.command, ...(item.cwd !== null ? { cwd: item.cwd } : {}) },
        reason: item.approval.reason,
      },
    });
    const decision = await waitForApproval(state, approvalId, permTimeoutMs);
    if (decision === "aborted") return { aborted: true };
    decisionKind = classifyDecision(decision);
  }

  const completed = commandExecutionCompleted(itemId, item, decisionKind);
  await write({
    method: "item/completed",
    params: { threadId, turnId, item: completed },
    emittedAtMs: Date.now(),
  });
  return { item: completed, interruptTurn: decisionKind === "cancel" };
}

/** 按 decision 分支合成 commandExecution 完成态（decline/cancel：拒绝但 item 落完成帧） */
function commandExecutionCompleted(itemId, item, decisionKind) {
  const completed = { id: itemId, type: "commandExecution", command: item.command };
  if (item.cwd !== null) completed.cwd = item.cwd;
  if (decisionKind === "accept") {
    completed.exitCode = item.exitCode;
    completed.aggregatedOutput = item.output;
    return completed;
  }
  completed.exitCode = null;
  completed.aggregatedOutput =
    decisionKind === "cancel" ? "已拒绝（cancel）——turn 中断" : "已拒绝（decline）——turn 继续";
  return completed;
}

/** 把 text 均分为 count 段 delta（最后一段吸收余数；count 至少 1） */
function splitText(text, count) {
  const total = typeof count === "number" && count >= 1 ? count : 1;
  if (total === 1) return [text];
  const size = Math.ceil(text.length / total);
  const chunks = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

/** 处理客户端请求（method + id）：initialize 免检门、实验门控、生命周期方法路由 */
async function handleRequest(state, fixture, write, request, permTimeoutMs) {
  const { id, method } = request;
  const params = isPlainObject(request.params) ? request.params : {};

  if (method === "initialize") {
    state.initialized = true;
    const capabilities = isPlainObject(params.capabilities) ? params.capabilities : {};
    state.experimentalApi = capabilities.experimentalApi === true;
    if (!state.experimentalApi) {
      log("initialize 未声明 experimentalApi:true——实验字段将被 -32600 拒（协议 §9 陷阱 2）");
    }
    await write({ id, result: initializeResult(fixture) });
    return;
  }
  if (!state.initialized) {
    await write({ id, error: { code: -32600, message: "Not initialized" } });
    return;
  }

  switch (method) {
    case "thread/start": {
      const experimentalUsed = EXPERIMENTAL_FIELDS.filter((field) => Object.hasOwn(params, field));
      if (experimentalUsed.length > 0 && !state.experimentalApi) {
        const field = experimentalUsed[0];
        await write({
          id,
          error: {
            code: -32600,
            message: `thread/start.${field} requires experimentalApi capability`,
          },
        });
        return;
      }
      state.threadCounter += 1;
      const threadId = `thread-${state.threadCounter}`;
      state.historyByThread.set(threadId, []);
      const result = {
        thread: { id: threadId },
        model: typeof params.model === "string" ? params.model : "mock-model",
      };
      if (params.sandbox !== undefined) result.sandbox = params.sandbox;
      if (params.approvalPolicy !== undefined) result.approvalPolicy = params.approvalPolicy;
      await write({ id, result });
      return;
    }
    case "turn/start": {
      const threadId = params.threadId;
      if (typeof threadId !== "string" || threadId.length === 0) {
        await write({ id, error: { code: -32602, message: "turn/start 需要 params.threadId" } });
        return;
      }
      if (state.activeTurn !== null) {
        await write({
          id,
          error: {
            code: -32602,
            message:
              "turn already in progress（mock 不实现 steer——等 turn/completed 后再发新 turn，协议 §9 陷阱 5）",
          },
        });
        return;
      }
      const script = fixture.turns[state.turnScriptIndex] ?? DEFAULT_TURN_SCRIPT;
      state.turnScriptIndex += 1;
      state.turnCounter += 1;
      const turnId = `turn-${state.turnCounter}`;
      state.activeTurn = { threadId, turnId, interrupted: false };
      const startedAt = new Date().toISOString();
      // 响应先行（适配器 await 应答），通知流随后（协议 §3：turn/start → {turn: Turn}）
      await write({
        id,
        result: {
          turn: {
            id: turnId,
            rootTurnId: turnId,
            items: [],
            status: "inProgress",
            error: null,
            startedAt,
            completedAt: null,
            durationMs: null,
          },
        },
      });
      state.replay = replayTurn(state, fixture, write, {
        threadId,
        turnId,
        script,
        startedAt,
        permTimeoutMs,
      });
      return;
    }
    case "turn/interrupt": {
      await write({ id, result: {} });
      if (state.activeTurn === null) {
        log("turn/interrupt：无活动 turn，仅应答（无 turn/completed 可发）");
        return;
      }
      state.activeTurn.interrupted = true;
      // 审批等待中的 turn 被中断：唤醒挂起审批按 cancel 走（真实服务端中断即弃审批）
      for (const wake of state.approvalWaiters.values()) wake("cancel");
      return;
    }
    case "thread/resume": {
      const threadId = params.threadId;
      if (typeof threadId !== "string" || threadId.length === 0) {
        await write({ id, error: { code: -32602, message: "thread/resume 需要 params.threadId" } });
        return;
      }
      const inMemory = state.historyByThread.get(threadId);
      const resume = fixture.resume;
      const fixtureMatched =
        resume !== null && (resume.threadId === null || resume.threadId === threadId);
      const turns =
        inMemory !== undefined && inMemory.length > 0
          ? inMemory
          : fixtureMatched
            ? resume.turns
            : [];
      await write({ id, result: { thread: { id: threadId, turns } } });
      return;
    }
    default: {
      await write({ id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  }
}

/** 客户端通知（method 无 id）：initialized 仅日志，其余宽容容忍（§8 未知方法容忍） */
function handleNotification(method) {
  if (method === "initialized") {
    log("initialized 通知收到（服务端仅记日志，协议 §2.2）");
    return;
  }
  log(`未知客户端通知（容忍忽略）：${method}`);
}

/** 客户端应答（id 无 method，即审批决策）：唤醒对应审批等待；未知应答宽容丢弃 */
function handleClientResponse(state, frame) {
  const id = String(frame.id);
  const wake = state.approvalWaiters.get(id);
  if (wake === undefined) {
    log(`未知客户端应答（容忍忽略）：id=${id}`);
    return;
  }
  if (frame.error !== undefined) {
    log(`审批应答携带 error（按 decline 处理）：id=${id}`);
    wake("decline");
    return;
  }
  const decision = isPlainObject(frame.result) ? frame.result.decision : undefined;
  wake(decision);
}

/**
 * 运行 codex app-server 模拟器：消费 stdin JSONL 直到 EOF，写出侧帧全部无 jsonrpc 键。
 * io = { stdin, stdout }；退出码由入口 codex-server.mjs 按脚本落。
 */
export async function runCodexAppServer(fixture, io) {
  const { stdin, stdout } = io;
  const write = createWriter(stdout);
  const state = {
    initialized: false,
    experimentalApi: false,
    threadCounter: 0,
    turnCounter: 0,
    itemCounter: 0,
    approvalCounter: 0,
    turnScriptIndex: 0,
    activeTurn: null,
    historyByThread: new Map(),
    approvalWaiters: new Map(),
    eofAborted: false,
    replay: null,
  };
  const permTimeoutMs = envInt("AETHER_MOCK_CODEX_PERM_TIMEOUT_MS", DEFAULT_PERM_TIMEOUT_MS);

  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  const closed = new Promise((resolve) => {
    lines.once("close", resolve);
  });
  // 请求处理串行化（readline 不等 async 监听器）；turn 回放任务 detached 并发跑
  let tail = Promise.resolve();
  lines.on("line", (line) => {
    tail = tail.then(async () => {
      const frame = parseJsonObject(line);
      if (frame === null) return; // 非 JSON/非对象行：宽容丢弃
      if (typeof frame.method === "string") {
        if (Object.hasOwn(frame, "id")) {
          await handleRequest(state, fixture, write, frame, permTimeoutMs);
        } else {
          handleNotification(frame.method);
        }
        return;
      }
      if (Object.hasOwn(frame, "id")) {
        handleClientResponse(state, frame); // 审批应答等客户端响应帧
      }
      // 其余形状（既无 method 又无 id）：宽容丢弃
    });
  });

  await closed;
  // EOF：客户端已不可读——中止挂起审批与回放任务（不再写帧），干净退出
  state.eofAborted = true;
  for (const wake of state.approvalWaiters.values()) wake("aborted");
  await tail;
  if (state.replay !== null) await state.replay;
}
