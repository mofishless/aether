// ===== aether-mock-cli codex 引擎自测（P1-01 支撑件）=====
// node:test 零依赖自测（fixtures 目录不进 vitest include，`node --test` 驱动），
// 模式对照 packages/adapters/claude/tests/mock-cli.test.ts：spawn 子进程 → 写 stdin
// JSONL → 收集 stdout 帧 → 断言。核心断言口径（协议定案 §1）：
// - 全部帧无 jsonrpc 键；
// - 通知帧（method 且无 id）带 emittedAtMs；请求/响应帧回传请求原 id。
// 覆盖：握手门控（Not initialized / experimentalApi）、全旅程帧序、审批三分支
// （accept/decline/cancel）、turn/interrupt、thread/resume（跨进程回退 + 同进程内存
// 优先）、未知方法、EOF 干净退出、fixture 校验负例、平台包装器冒烟。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const MOCK_DIR = fileURLToPath(new URL("..", import.meta.url));
const SERVER = join(MOCK_DIR, "codex-server.mjs");
const FIXTURES_DIR = join(MOCK_DIR, "fixtures");
const WRAPPER = join(
  MOCK_DIR,
  process.platform === "win32" ? "codex-server.cmd" : "codex-server.sh",
);
const HAPPY = join(FIXTURES_DIR, "codex-happy-path.json");

/** 启动模拟器（直连 node 运行引擎；包装器另有冒烟用例）；返回帧收集器与控制面 */
function launch(scriptPath, useWrapper = false) {
  const child = useWrapper
    ? spawn(WRAPPER, [], {
        env: { ...process.env, AETHER_MOCK_SCRIPT: scriptPath },
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32", // .cmd 经 shell（node 24 裸 spawn .cmd 是 EINVAL）
      })
    : spawn(process.execPath, [SERVER], {
        env: { ...process.env, AETHER_MOCK_SCRIPT: scriptPath },
        stdio: ["pipe", "pipe", "pipe"],
      });
  const frames = [];
  let buffer = "";
  let stderrText = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (text.length > 0) frames.push(JSON.parse(text));
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrText += chunk;
  });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const stdoutEnded = new Promise((resolve) => {
    child.stdout.once("end", resolve);
  });
  // 兜底回收：断言失败提前抛出时子进程不泄漏（管道句柄会吊住 node:test 事件循环）。
  // 正常路径 EOF 已让子进程自行退出，kill 到已退出进程是安全 no-op。
  after(() => {
    child.stdin.end();
    const killer = setTimeout(() => child.kill(), 1500);
    killer.unref();
  });
  return {
    frames,
    stderrText: () => stderrText,
    exited,
    stdoutEnded,
    send: (frame) => {
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    },
    endInput: () => {
      child.stdin.end();
    },
  };
}

/** 轮询等待首个满足条件的帧（10ms 步进；超时抛错带当前帧数） */
async function waitForFrame(mock, predicate, timeoutMs = 10_000) {
  const startedAt = Date.now();
  for (;;) {
    const found = mock.frames.find(predicate);
    if (found !== undefined) return found;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`等待帧超时（${timeoutMs}ms，当前 ${mock.frames.length} 帧）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 帧分类助手：通知（method 无 id）/ 服务端请求（method 有 id）/ 响应（id 无 method） */
const isNotification = (frame) => typeof frame.method === "string" && !("id" in frame);
const isServerRequest = (frame) => typeof frame.method === "string" && "id" in frame;
const isResponse = (frame) => typeof frame.method !== "string" && "id" in frame;

/** 协议 §1 核心口径：任何写出帧都不得带 jsonrpc 键 */
function assertNoJsonRpcKey(mock) {
  for (const frame of mock.frames) {
    assert.equal("jsonrpc" in frame, false, `帧不应带 jsonrpc 键：${JSON.stringify(frame)}`);
  }
}

/** 通知帧必须带 emittedAtMs（数值）；服务端请求帧带字符串 id 与 method */
function assertNotificationShapes(mock) {
  for (const frame of mock.frames) {
    if (isNotification(frame)) {
      assert.equal(
        typeof frame.emittedAtMs,
        "number",
        `通知缺 emittedAtMs：${JSON.stringify(frame)}`,
      );
      assert.equal("id" in frame, false, `通知不应带 id：${JSON.stringify(frame)}`);
    }
    if (isServerRequest(frame)) {
      assert.equal(typeof frame.id, "string", `服务端请求 id 应为字符串：${JSON.stringify(frame)}`);
    }
  }
}

/**
 * 走完握手并做平台无关的形状断言（四字段全字符串 + userAgent 缺省值）。
 * platformFamily/platformOs 随运行平台推导（fixture 未覆盖时），跨平台矩阵下不能硬编码。
 */
async function handshake(mock, id = 1, capabilities = { experimentalApi: true }) {
  mock.send({
    id,
    method: "initialize",
    params: { clientInfo: { name: "aether-test" }, capabilities },
  });
  const response = await waitForFrame(mock, (frame) => isResponse(frame) && frame.id === id);
  assert.deepEqual(Object.keys(response.result).sort(), [
    "codexHome",
    "platformFamily",
    "platformOs",
    "userAgent",
  ]);
  for (const value of Object.values(response.result)) {
    assert.equal(typeof value, "string", `initialize 应答字段应为字符串：${JSON.stringify(value)}`);
  }
  assert.equal(response.result.userAgent, "aether-mock-codex/0.1.0");
  return response;
}

test("initialize 握手 + initialized 通知容忍 + EOF 干净退出 0", async () => {
  const mock = launch(HAPPY);
  const response = await handshake(mock, 1);
  // HAPPY fixture 钉死 initialize 覆盖值（跨平台常量）：四字段精确断言
  assert.deepEqual(response.result, {
    userAgent: "aether-mock-codex/0.1.0",
    codexHome: "~/.codex",
    platformFamily: "windows",
    platformOs: "win32",
  });
  const framesBefore = mock.frames.length;
  mock.send({ method: "initialized" }); // 通知：仅日志，不回帧
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(mock.frames.length, framesBefore, "initialized 通知不应产生回帧");
  mock.endInput();
  const proof = await mock.exited;
  await mock.stdoutEnded;
  assert.equal(proof.code, 0);
  assertNoJsonRpcKey(mock);
});

test("initialize 前发请求 → -32600 Not initialized", async () => {
  const mock = launch(HAPPY);
  mock.send({ id: 7, method: "thread/start", params: {} });
  const response = await waitForFrame(mock, (frame) => isResponse(frame) && frame.id === 7);
  assert.equal(response.error.code, -32600);
  assert.match(response.error.message, /Not initialized/);
  mock.endInput();
  assert.equal((await mock.exited).code, 0);
});

test("experimentalApi 未声明：initialize 成功但 thread/start 实验字段 → -32600（陷阱 2 复刻）", async () => {
  const mock = launch(HAPPY);
  await handshake(mock, 1, {}); // 未声明 experimentalApi
  mock.send({ id: 2, method: "thread/start", params: { approvalPolicy: "on-request" } });
  const response = await waitForFrame(mock, (frame) => isResponse(frame) && frame.id === 2);
  assert.equal(
    response.error.code,
    -32600,
    `错误码应为 -32600 非 -32602：${JSON.stringify(response)}`,
  );
  assert.match(response.error.message, /requires experimentalApi capability/);
  mock.endInput();
  assert.equal((await mock.exited).code, 0);
});

test("未知方法 → -32601 method not found", async () => {
  const mock = launch(HAPPY);
  await handshake(mock, 1);
  mock.send({ id: 3, method: "thread/poke", params: {} });
  const response = await waitForFrame(mock, (frame) => isResponse(frame) && frame.id === 3);
  assert.equal(response.error.code, -32601);
  assert.match(response.error.message, /thread\/poke/);
  mock.endInput();
  assert.equal((await mock.exited).code, 0);
});

test("全旅程（审批 accept）：帧序 + id 回传 + emittedAtMs + 同进程 resume 内存历史", async () => {
  const mock = launch(HAPPY);
  await handshake(mock, 1);
  mock.send({
    id: 2,
    method: "thread/start",
    params: { cwd: "D:/wt/mock", approvalPolicy: "on-request" },
  });
  const threadResponse = await waitForFrame(mock, (frame) => isResponse(frame) && frame.id === 2);
  assert.equal(threadResponse.result.thread.id, "thread-1");
  assert.equal(threadResponse.result.approvalPolicy, "on-request", "thread/start 应答回显实验字段");

  mock.send({
    id: 3,
    method: "turn/start",
    params: { threadId: "thread-1", input: [{ type: "text", text: "跑一遍" }] },
  });
  const turnResponse = await waitForFrame(mock, (frame) => isResponse(frame) && frame.id === 3);
  assert.equal(turnResponse.result.turn.status, "inProgress");
  await waitForFrame(mock, (frame) => frame.method === "turn/started");

  // item-1：agentMessage（started → 2×delta → completed）
  await waitForFrame(
    mock,
    (frame) => frame.method === "item/started" && frame.params?.item?.type === "agentMessage",
  );
  await waitForFrame(
    mock,
    () => mock.frames.filter((f) => f.method === "item/agentMessage/delta").length >= 2,
  );
  assert.equal(
    mock.frames.filter((f) => f.method === "item/agentMessage/delta").length >= 2,
    true,
    "deltas=2 应产生两条增量通知",
  );

  // item-2：commandExecution 审批请求（服务端带 id 请求）
  const approval = await waitForFrame(mock, (frame) => isServerRequest(frame));
  assert.equal(approval.method, "item/commandExecution/requestApproval");
  assert.equal(approval.params.itemId, "item-2");
  assert.equal(approval.params.call.command, "echo aether");
  mock.send({ id: approval.id, result: { decision: "accept" } });

  await waitForFrame(
    mock,
    (frame) => frame.method === "item/completed" && frame.params?.item?.type === "commandExecution",
  );
  const commandCompleted = mock.frames.find(
    (frame) => frame.method === "item/completed" && frame.params?.item?.type === "commandExecution",
  );
  assert.equal(commandCompleted.params.item.exitCode, 0);
  assert.equal(commandCompleted.params.item.aggregatedOutput, "aether");

  const completed = await waitForFrame(mock, (frame) => frame.method === "turn/completed");
  assert.equal(completed.params.turn.status, "completed");
  assert.equal(completed.params.turn.items.length, 3);

  // 同进程 thread/resume：内存历史优先（与 fixture.resume 同形但来自实际回放）
  mock.send({ id: 4, method: "thread/resume", params: { threadId: "thread-1" } });
  const resume = await waitForFrame(mock, (frame) => isResponse(frame) && frame.id === 4);
  assert.equal(resume.result.thread.id, "thread-1");
  assert.equal(resume.result.thread.turns.length, 1);
  assert.equal(resume.result.thread.turns[0].status, "completed");

  mock.endInput();
  assert.equal((await mock.exited).code, 0);
  assertNoJsonRpcKey(mock);
  assertNotificationShapes(mock);
});

test("审批 decline：拒绝该 item 但 turn 继续（decline ≠ cancel）", async () => {
  const mock = launch(HAPPY);
  await handshake(mock, 1);
  mock.send({ id: 2, method: "thread/start", params: {} });
  await waitForFrame(mock, (frame) => isResponse(frame) && frame.id === 2);
  mock.send({ id: 3, method: "turn/start", params: { threadId: "thread-1" } });
  const approval = await waitForFrame(mock, (frame) => isServerRequest(frame));
  mock.send({ id: approval.id, result: { decision: "decline" } });

  const completed = await waitForFrame(mock, (frame) => frame.method === "turn/completed");
  assert.equal(completed.params.turn.status, "completed", "decline 后 turn 应正常完成");
  const denied = completed.params.turn.items.find((item) => item.type === "commandExecution");
  assert.equal(denied.exitCode, null);
  assert.match(denied.aggregatedOutput, /decline/);
  assert.equal(completed.params.turn.items.length, 3, "decline 不打断后续 item");
  mock.endInput();
  assert.equal((await mock.exited).code, 0);
});

test("审批 cancel：拒绝并中断 turn（turn/completed status=interrupted）", async () => {
  const mock = launch(HAPPY);
  await handshake(mock, 1);
  mock.send({ id: 2, method: "thread/start", params: {} });
  await waitForFrame(mock, (frame) => isResponse(frame) && frame.id === 2);
  mock.send({ id: 3, method: "turn/start", params: { threadId: "thread-1" } });
  const approval = await waitForFrame(mock, (frame) => isServerRequest(frame));
  mock.send({ id: approval.id, result: { decision: "cancel" } });

  const completed = await waitForFrame(mock, (frame) => frame.method === "turn/completed");
  assert.equal(completed.params.turn.status, "interrupted");
  assert.equal(completed.params.turn.items.length, 2, "cancel 后不再回放后续 item");
  const denied = completed.params.turn.items.find((item) => item.type === "commandExecution");
  assert.match(denied.aggregatedOutput, /cancel/);
  mock.endInput();
  assert.equal((await mock.exited).code, 0);
});

test("turn/interrupt：{} 应答 + turn/completed(status=interrupted) 通知", async () => {
  // 自建慢速 fixture：第二个 item delayMs 400ms，制造可中断窗口
  const workdir = mkdtempSync(join(tmpdir(), "aether-mock-codex-interrupt-"));
  try {
    const scriptPath = join(workdir, "slow.json");
    writeFileSync(
      scriptPath,
      JSON.stringify({
        protocol: "codex-app-server",
        exitCode: 0,
        turns: [
          {
            delayMs: 0,
            items: [
              { type: "agentMessage", text: "第一段", deltas: 1, delayMs: 0 },
              { type: "agentMessage", text: "第二段", deltas: 1, delayMs: 400 },
            ],
          },
        ],
      }),
      "utf8",
    );
    const mock = launch(scriptPath);
    await handshake(mock, 1);
    mock.send({ id: 2, method: "thread/start", params: {} });
    await waitForFrame(mock, (frame) => isResponse(frame) && frame.id === 2);
    mock.send({ id: 3, method: "turn/start", params: { threadId: "thread-1" } });
    await waitForFrame(
      mock,
      (frame) => frame.method === "item/completed" && frame.params?.item?.text === "第一段",
    );

    mock.send({
      id: 4,
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
    const interruptResponse = await waitForFrame(
      mock,
      (frame) => isResponse(frame) && frame.id === 4,
    );
    assert.deepEqual(interruptResponse.result, {});
    const completed = await waitForFrame(mock, (frame) => frame.method === "turn/completed");
    assert.equal(completed.params.turn.status, "interrupted");
    assert.equal(completed.params.turn.items.length, 1, "中断后第二段不落 items");
    mock.endInput();
    assert.equal((await mock.exited).code, 0);
    assertNoJsonRpcKey(mock);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("thread/resume 跨进程：fixture.resume 声明历史回退（canResume 验收素材）", async () => {
  const mock = launch(HAPPY); // 新进程无内存记录
  await handshake(mock, 1);
  mock.send({ id: 2, method: "thread/resume", params: { threadId: "thread-1" } });
  const response = await waitForFrame(mock, (frame) => isResponse(frame) && frame.id === 2);
  assert.equal(response.result.thread.id, "thread-1");
  const turns = response.result.thread.turns;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].status, "completed");
  assert.equal(turns[0].items[1].command, "echo aether");
  mock.endInput();
  assert.equal((await mock.exited).code, 0);
});

test("thread/resume 未声明历史且无内存记录 → 空 turns", async () => {
  const mock = launch(HAPPY);
  await handshake(mock, 1);
  mock.send({ id: 2, method: "thread/resume", params: { threadId: "thread-999" } });
  const response = await waitForFrame(mock, (frame) => isResponse(frame) && frame.id === 2);
  assert.deepEqual(response.result.thread.turns, []);
  mock.endInput();
  assert.equal((await mock.exited).code, 0);
});

test("fixture 校验负例：非法 item type → 退出码 65 + stderr 指名 type", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "aether-mock-codex-invalid-"));
  try {
    const scriptPath = join(workdir, "invalid.json");
    writeFileSync(
      scriptPath,
      JSON.stringify({
        protocol: "codex-app-server",
        turns: [{ items: [{ type: "bogus" }] }],
      }),
      "utf8",
    );
    const mock = launch(scriptPath);
    const proof = await mock.exited;
    await mock.stdoutEnded;
    assert.equal(proof.code, 65);
    assert.match(mock.stderrText(), /type/);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("平台包装器冒烟：codex-server.cmd/.sh 经包装器握手成功（%~dp0/dirname 展开）", async () => {
  if (process.platform !== "win32") {
    chmodSync(WRAPPER, 0o755); // git 检出不带执行位，运行时补（对照 cli.sh 约定）
  }
  const mock = launch(HAPPY, true);
  await handshake(mock, 1);
  mock.endInput();
  assert.equal((await mock.exited).code, 0);
  assertNoJsonRpcKey(mock);
});
