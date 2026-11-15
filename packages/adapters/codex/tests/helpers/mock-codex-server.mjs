#!/usr/bin/env node
// ===== 内联 mock codex app-server（P1-01 集成测试专用，帧形状严格按协议定案）=====
// 零依赖纯 Node ESM：stdin 读 LDJSON、stdout 回 LDJSON（无 jsonrpc 键）。
// 场景经 env 选择：AETHER_CODEX_SCENARIO = 场景 JSON 路径；
// 线路观测：AETHER_CODEX_WIRE_LOG = 落盘文件（每行 {dir,in/out,frame}，断言
// experimentalApi:true / 无 text_elements 键 / 审批 decision 用）。
// argv 任意容忍（-c thread_unload_delay_secs=0 app-server / --version）。

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("codex-mock 0.169.0 (aether inline mock)\n");
  process.exit(0);
}

const scenarioPath = process.env["AETHER_CODEX_SCENARIO"];
const wireLogPath = process.env["AETHER_CODEX_WIRE_LOG"];
const scenario = scenarioPath
  ? JSON.parse(readFileSync(scenarioPath, "utf8"))
  : { turnScripts: [] };

// 跨进程持久 turn 计数（场景 turnCountFile:true 时启用，F3 respawn 用例）：
// 真实 codex 的 thread 状态在服务端持久，进程重启不丢——mock 以 wireLog 旁挂
// 计数文件等价模拟（同一 wireLog 的 respawn 进程续接 turn 脚本序号）
const turnCountFile =
  scenario.turnCountFile === true && wireLogPath ? `${wireLogPath}.turns` : null;
let durableTurns = 0;
if (turnCountFile !== null) {
  try {
    durableTurns = Number(readFileSync(turnCountFile, "utf8")) || 0;
  } catch {
    durableTurns = 0; // 首进程无计数文件
  }
}

const emitAt = () => Date.now();
const write = (frame) => {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
  logWire("out", frame);
};
const logWire = (dir, frame) => {
  if (wireLogPath === undefined || wireLogPath.length === 0) return;
  try {
    appendFileSync(wireLogPath, `${JSON.stringify({ dir, frame })}\n`);
  } catch {
    // 观测日志失败不影响协议
  }
};

let serverRequestId = 0;
const approvalWaiters = new Map(); // serverRequestId -> resolve
let turnCounter = 0;
let playing = null; // { turnId, interrupted }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 通知统一带 emittedAtMs（协议 §1：本机实测通知携带毫秒时间戳）
function send(method, params) {
  const { emittedAtMs, ...rest } = params;
  write({ method, params: { ...rest, emittedAtMs: emittedAtMs ?? emitAt() } });
}

function respond(id, result) {
  write({ id, result });
}

function respondError(id, code, message) {
  write({ id, error: { code, message } });
}

async function playTurn(threadId, requestId, script) {
  const turnId = `turn-${++turnCounter}`;
  const state = { turnId, interrupted: false };
  playing = state;
  respond(requestId, {
    turn: {
      id: turnId,
      rootTurnId: turnId,
      items: [],
      status: "inProgress",
      error: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      durationMs: null,
    },
  });
  send("turn/started", { threadId, turn: { id: turnId, status: "inProgress", items: [] } });
  const steps = script.steps ?? [];
  for (const step of steps) {
    if (state.interrupted && (scenario.onInterrupt ?? "interruptible") === "interruptible") break;
    await doStep(threadId, turnId, step);
    await sleep(step.sleepMs ?? 10);
  }
  const interrupted =
    state.interrupted && (scenario.onInterrupt ?? "interruptible") === "interruptible";
  const status = interrupted ? "interrupted" : (script.completedStatus ?? "completed");
  playing = null;
  send("turn/completed", {
    threadId,
    turn: {
      id: turnId,
      status,
      error:
        status === "failed" ? { message: script.turnErrorMessage ?? "mock turn failure" } : null,
      items: [],
    },
  });
  // §7 场景：thread_unload_delay_secs=0 —— turn 完成即卸载 thread（follow-up 须 resume）
  if (scenario.unloadAfterTurn !== false) {
    send("thread/closed", { threadId });
  }
}

async function doStep(threadId, turnId, step) {
  if (step.do === "item") {
    send(step.phase === "started" ? "item/started" : "item/completed", {
      threadId,
      turnId,
      item: step.item,
    });
    return;
  }
  if (step.do === "delta") {
    send(step.method ?? "item/agentMessage/delta", {
      threadId,
      turnId,
      itemId: step.itemId,
      delta: step.delta ?? "…",
    });
    return;
  }
  if (step.do === "error") {
    send("error", {
      threadId,
      turnId,
      error: { message: step.message ?? "mock transient error" },
      willRetry: step.willRetry ?? true,
    });
    return;
  }
  if (step.do === "approval") {
    serverRequestId += 1;
    const id = `srv-${serverRequestId}`;
    write({
      id,
      method: step.method ?? "item/commandExecution/requestApproval",
      params: {
        threadId,
        turnId,
        itemId: step.itemId ?? "item-cmd-1",
        ...(step.approvalId !== undefined ? { approvalId: step.approvalId } : {}),
        item: step.item ?? {
          type: "commandExecution",
          id: step.itemId ?? "item-cmd-1",
          command: "npm test",
          cwd: "/tmp",
        },
        // permissions 方法（F1）：请求携带 RequestPermissionProfile（与应答的
        // GrantedPermissionProfile 同构），approve 应答原样回授本对象
        ...(step.permissions !== undefined ? { permissions: step.permissions } : {}),
      },
    });
    const decision = await new Promise((resolve) => {
      approvalWaiters.set(id, resolve);
    });
    logWire("decision", { id, decision });
    // 决策回显进命令结果与消息（断言 approval→turn 流贯通）
    const itemId = step.itemId ?? "item-cmd-1";
    const isPermissionsGrant =
      decision !== null &&
      typeof decision === "object" &&
      !Array.isArray(decision) &&
      Object.hasOwn(decision, "permissions");
    const nonEmptyGrant =
      isPermissionsGrant &&
      (decision.permissions.fileSystem !== null || decision.permissions.network !== null);
    const accepted =
      decision === "accept" ||
      decision === "acceptForSession" ||
      decision === "approved" ||
      decision === "approved_for_session" ||
      nonEmptyGrant; // permissions 应答：空授权 = 拒绝语义（协议无 decline 字面量）
    send("item/completed", {
      threadId,
      turnId,
      item: {
        type: "commandExecution",
        id: itemId,
        command: (step.item ?? {}).command ?? "npm test",
        exitCode: accepted ? 0 : 1,
        aggregatedOutput: `decision=${JSON.stringify(decision)}`,
      },
    });
    send("item/started", {
      threadId,
      turnId,
      item: {
        type: "agentMessage",
        id: `${itemId}-msg`,
        text: `审批结果：${JSON.stringify(decision)}`,
      },
    });
    send("item/completed", {
      threadId,
      turnId,
      item: {
        type: "agentMessage",
        id: `${itemId}-msg`,
        text: `审批结果：${JSON.stringify(decision)}`,
      },
    });
    return;
  }
  if (step.do === "sleep") {
    await sleep(step.ms ?? 50);
    return;
  }
  if (step.do === "die") {
    // F3 respawn 用例：mid-turn 服务端死亡（turn/completed 永不到达）。
    // exit 非零 → 适配器退出证明物化 error 事件；stdout 已写的帧保持有效
    process.exit(step.code ?? 3);
  }
  if (step.do === "unknownServerRequest") {
    serverRequestId += 1;
    write({
      id: `srv-${serverRequestId}`,
      method: step.method ?? "item/unknown/requestApproval",
      params: {},
    });
    return;
  }
}

let threadCounter = 0;
let currentThreadId = "thread-mock-1";

async function handleFrame(frame) {
  logWire("in", frame);
  const { id, method, params } = frame;
  if (method === undefined) {
    // 服务端请求应答（审批决策）：唤起对应等待者。v2 decision 系 result 是
    // {decision}（协议 §4，与 fixtures codex 引擎同口径读 frame.result.decision）；
    // permissions 方法 result 是 {permissions, scope}（F1：授予形状无 decision 键，
    // 整对象透传——回显消息可断言应答形状）；v1 裸值/错误帧宽容兜底
    if (id !== undefined && approvalWaiters.has(String(id))) {
      const result = frame.result;
      let decision;
      if (result !== null && typeof result === "object" && !Array.isArray(result)) {
        decision = Object.hasOwn(result, "permissions")
          ? { permissions: result.permissions, scope: result.scope }
          : (result.decision ?? null);
      } else {
        decision = result ?? null;
      }
      approvalWaiters.get(String(id))(decision ?? frame.error ?? null);
      approvalWaiters.delete(String(id));
    }
    return;
  }
  if (method === "initialize") {
    respond(id, {
      userAgent: "codex-mock/0.169.0",
      codexHome: "~/.codex",
      platformFamily: "mock",
      platformOs: "mock-os",
    });
    return;
  }
  if (method === "initialized") {
    return; // 通知：礼貌接收
  }
  if (method === "thread/start") {
    threadCounter += 1;
    const threadId = scenario.threadId ?? `thread-mock-${threadCounter}`;
    currentThreadId = threadId;
    respond(id, {
      thread: { id: threadId, title: "mock thread", createdAt: new Date().toISOString() },
      model: (params ?? {}).model ?? "gpt-5-codex-mock",
      sandbox: (params ?? {}).sandbox ?? "workspace-write",
    });
    send("thread/started", { thread: { id: threadId } });
    return;
  }
  if (method === "turn/start") {
    // 脚本序：缺省进程内计数；场景 turnCountFile:true 时走跨进程持久计数
    // （respawn 后的新进程续接序号，等价真实服务端 thread 状态持久语义）
    const scriptIndex =
      turnCountFile !== null
        ? durableTurns
        : Math.min(turnCounter, scenario.turnScripts.length - 1);
    if (turnCountFile !== null) {
      durableTurns += 1;
      try {
        writeFileSync(turnCountFile, String(durableTurns));
      } catch {
        // 计数落盘失败不影响回放（仅 respawn 续接退化）
      }
    }
    const script = scenario.turnScripts[Math.min(scriptIndex, scenario.turnScripts.length - 1)] ?? {
      steps: [],
    };
    // 异步推进（响应先行，通知按场景流出）
    void playTurn(currentThreadId, id, script).catch(() => undefined);
    return;
  }
  if (method === "turn/interrupt") {
    respond(id, {});
    if (playing !== null) {
      playing.interrupted = true;
    }
    return;
  }
  if (method === "thread/resume") {
    const threadId = (params ?? {}).threadId ?? "thread-mock-1";
    const excludeTurns = (params ?? {}).excludeTurns === true;
    respond(id, {
      thread: {
        id: threadId,
        turns: excludeTurns ? [] : (scenario.resumeTurns ?? []),
      },
    });
    return;
  }
  if (method === "mock/exit") {
    respond(id, {});
    setTimeout(() => process.exit((params ?? {}).code ?? 3), 10);
    return;
  }
  if (method === "mock/stderr") {
    process.stderr.write((params ?? {}).text ?? "mock stderr line\n");
    respond(id, {});
    return;
  }
  if (method === "mock/rpcError") {
    respondError(id, -32602, "invalid params（mock）");
    return;
  }
  if (method === "mock/slow") {
    const delay = (params ?? {}).delayMs ?? 3000;
    setTimeout(() => respond(id, { ok: true }), delay);
    return;
  }
  respondError(id, -32601, `mock 未实现方法：${String(method)}`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (text.length === 0) return;
  try {
    handleFrame(JSON.parse(text)).catch(() => undefined);
  } catch {
    // 坏行：mock 容忍（真服务端同款不崩）
  }
});
rl.on("close", () => {
  // stdin EOF：单客户端语义——宽限冲刷后退出（§7）
  setTimeout(() => process.exit(0), 100);
});
