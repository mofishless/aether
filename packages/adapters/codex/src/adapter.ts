// ===== Codex L1 适配器（自研 app-server JSONL RPC 实现，P1-01）=====
// - 进程模型与 claude 相反：codex app-server 是长活服务端，一个会话一个进程、
//   一个 thread，多轮 follow-up 复用同进程同 thread（codex 天然多轮，§10）；
// - 终态排序契约（与 claude 同构）：turn/completed 不发终态（completed/interrupted
//   静默、failed→error 事件），session 终态由进程退出证明物化——killedByUs 或干净
//   退出 → session(stopped)，非零退出 → error；
// - §7 采纳 T3 生产参数 -c thread_unload_delay_secs=0（thread 即用即卸）：turn 完成后
//   thread 被卸载（thread/closed / notLoaded），下一轮 turn/start 前以
//   thread/resume{excludeTurns:true} 重载（无历史重放开销）；
// - 审批（§4）：服务端带 id 请求 → permission_request 事件（requestId=approvalId||itemId），
//   resolvePermission 并发应答、原样回传 id；allow→accept / always→acceptForSession /
//   deny→decline（v1 蛇形 DEPRECATED 兜底）；permissions 方法应答形状特例（F1）：
//   {permissions, scope}——deny=空授权、approve=请求 profile 原样回授；
// - 取消（§10 定案）：turn/interrupt → 等 turn/completed（≤5s）→ 关 stdin →
//   killTree 兜底；恢复：thread/resume{threadId} 默认全量水合（canResume=true）。
import { killTree as realKillTree, spawnCommand as realSpawnCommand } from "@aether/process-host";
import type { ExitProof, ProcessHandle, SpawnTrackedOptions } from "@aether/process-host";
import type {
  AdapterContext,
  AgentAdapter,
  AgentProcess,
  AutonomyLevel,
  CancelReason,
  DiscoverResult,
  PermissionDecision,
  ResolvedProviderConfig,
  SessionRecord,
  SpawnInput,
} from "@aether/core";
import type { ProviderEvent } from "@aether/contracts";
import { createJsonlRpcClient, RpcError } from "./client.js";
import type { JsonlRpcClient, ServerRequestOutcome } from "./client.js";
import type { ServerNotificationFrame, ServerRequestFrame } from "./frame-router.js";
import {
  approvalEventFor,
  autonomyToCodexPolicy,
  mapNotification,
  mapResumeTurns,
  normalizeFrames,
  textUserInput,
  v1ApprovalDecision,
  v2ApprovalDecision,
  v2PermissionsGrant,
  PERMISSIONS_APPROVAL_METHOD,
  V1_APPROVAL_METHODS,
  V2_APPROVAL_METHODS,
} from "./normalize.js";
import { launchCodexServer, prepareCodexHome, resolveCodexLaunch } from "./spawn.js";
import type { LaunchSpec } from "./spawn.js";

/** 安装提示按平台分叉（P1-01 评审 F5）：Windows 裸名 codex 不做 PATHEXT 解析，明示 PATH/npm 要求 */
const installHint = (): string =>
  process.platform === "win32"
    ? "未探测到 codex CLI：需 codex 在 PATH（npm install -g @openai/codex，提供 codex.cmd）" +
      "，或 provider 配置 config.cliPath 指向 codex.cmd / 完整入口。"
    : "未探测到 codex CLI：npm install -g @openai/codex（或将 codex 装入 PATH），" +
      "或在 provider 配置 config.cliPath 指定入口（POSIX 可执行 / node 脚本均可）。";

/** 通知方法白名单（§8 方法白名单 + 未知容忍；delta 族白名单内计数为未消费） */
const KNOWN_NOTIFICATION_METHODS: ReadonlySet<string> = new Set([
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "error",
  "thread/started",
  "thread/status/changed",
  "thread/closed",
  "thread/tokenUsage/updated",
  "deprecationNotice",
]);

const KNOWN_SERVER_REQUEST_METHODS: ReadonlySet<string> = new Set([
  ...V2_APPROVAL_METHODS,
  ...V1_APPROVAL_METHODS,
]);

export interface CodexAdapterDeps {
  /** 治理 spawn 注入缝（默认 process-host spawnCommand，经 launchCodexServer 组装） */
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnTrackedOptions,
  ) => ProcessHandle;
  readonly killTree?: (target: ProcessHandle | number) => Promise<unknown>;
  readonly now?: () => string;
  readonly newId?: () => string;
  /** discover 版本探针（默认对解析出的入口执行 --version） */
  readonly probeVersion?: (spec: LaunchSpec) => Promise<string | null>;
}

interface ApprovalWaiter {
  /** 请求方法（permissions 方法应答形状与 decision 系不同，应答回传时的分叉依据） */
  readonly method: string;
  /** 请求原始 params（permissions approve 回授 params.permissions 用；wire 数据原样保存） */
  readonly requestParams: unknown;
  readonly isV1: boolean;
  readonly settle: (outcome: ServerRequestOutcome) => void;
}

/** 取消/续聊时等 turn/completed 的上限（§10 定案 ≤5s），超时即关 stdin + killTree 兜底 */
const INTERRUPT_SETTLE_TIMEOUT_MS = 5_000;
/** 关 stdin（EOF）后等进程自然退出的上限，超时 killTree */
const EXIT_DRAIN_TIMEOUT_MS = 5_000;

interface SessionRuntime {
  readonly processId: string;
  readonly sessionId: string;
  threadId: string | null;
  autonomy: AutonomyLevel;
  model: string | null;
  /** 最新 AdapterContext（事件物化与审批请求用；spawn/followUp/resume 时刷新） */
  ctx: AdapterContext | null;
  handle: ProcessHandle | null;
  client: JsonlRpcClient | null;
  threadLoaded: boolean;
  activeTurnId: string | null;
  /** turn/completed 等待者（cancel 的 interrupt 结算 / 续聊的空闲确认） */
  turnCompletionWaiters: Set<() => void>;
  approvalWaiters: Map<string, ApprovalWaiter>;
  /** 终态事件已物化（turn failed 的 error 或退出证明的 session/error，二选一） */
  terminalEmitted: boolean;
  /** error 通知（willRetry=false）已覆盖的 turnId：turn/completed(failed) 去重用 */
  turnErrorNotified: string | null;
  /** 通知跳过计数（容忍观测，诊断用） */
  skippedCounts: Record<string, number>;
}

function errorText(error: unknown): string {
  if (error instanceof RpcError) {
    return `RPC ${error.code}：${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 创建 Codex 适配器（AgentAdapter 全九方法）。cfg.config 可选键：
 * cliPath（CLI 入口，默认 "codex"）、codexHome（CODEX_HOME，支持 ~ 前缀）、
 * serverArgs（app-server 前附加旗标，替换默认 -c thread_unload_delay_secs=0）。 */
export function createCodexAdapter(
  cfg: ResolvedProviderConfig,
  deps: CodexAdapterDeps = {},
): AgentAdapter {
  if (cfg.kind !== "codex-app-server") {
    throw new Error(`createCodexAdapter 只接受 kind='codex-app-server'（收到 '${cfg.kind}'）`);
  }
  const cliPath =
    typeof cfg.config["cliPath"] === "string" && cfg.config["cliPath"].length > 0
      ? (cfg.config["cliPath"] as string)
      : "codex";
  const codexHomeRaw =
    typeof cfg.config["codexHome"] === "string" ? (cfg.config["codexHome"] as string) : undefined;
  const serverArgs = Array.isArray(cfg.config["serverArgs"])
    ? (cfg.config["serverArgs"] as unknown[]).filter(
        (arg): arg is string => typeof arg === "string",
      )
    : undefined;
  // 默认附加 -c thread_unload_delay_secs=0（§7 Aether 采纳）——turn 完成即卸载：
  // 主动置 threadLoaded=false（thread/closed 通知可能滞后于 turn/completed，
  // 若在间隙发 turn/start 会撞上服务端卸载竞态）
  const unloadImmediately = serverArgs === undefined;

  const spawnFn = deps.spawn ?? realSpawnCommand;
  const killTreeFn = deps.killTree ?? realKillTree;
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const runtimes = new Map<string, SessionRuntime>();

  // ---- 通知泵：白名单通知 → 归一化 → ctx.emit；侧信号驱动 runtime 状态 ----
  const handleNotification = (runtime: SessionRuntime, note: ServerNotificationFrame): void => {
    const ctx = runtime.ctx;
    if (ctx === null) return;
    const mapped = mapNotification(note, {
      sessionId: runtime.sessionId,
      occurredAtFallback: now(),
    });
    if (mapped.skippedType !== null) {
      const key = mapped.skippedType;
      runtime.skippedCounts[key] = (runtime.skippedCounts[key] ?? 0) + 1;
    }
    const { signals } = mapped;
    if (signals.threadId !== null && runtime.threadId === null) {
      runtime.threadId = signals.threadId; // thread/started 先于响应处理的兜底收养
    }
    if (note.method === "turn/started" && signals.turnId !== null) {
      runtime.activeTurnId = signals.turnId;
    }
    if (note.method === "thread/closed") {
      runtime.threadLoaded = false; // §9-7：卸载后不能再对该 thread 发 turn
    }
    if (note.method === "thread/status/changed" && signals.threadStatus === "notLoaded") {
      runtime.threadLoaded = false;
    }
    // 真实 codex 失败路径 = error 通知（willRetry=false）+ turn/completed(failed) 双帧：
    // 同一 turn 的失败只物化一次 error 事件（error 通知先到则 turn/completed 侧去重）
    let events = mapped.events;
    const turnId = signals.turnId ?? "";
    if (note.method === "error" && mapped.events.length > 0) {
      runtime.turnErrorNotified = turnId;
      runtime.terminalEmitted = true; // §10 定案：willRetry=false 即置 fail（状态机吸收）
    }
    if (note.method === "turn/completed") {
      runtime.activeTurnId = null;
      for (const waiter of runtime.turnCompletionWaiters) waiter();
      runtime.turnCompletionWaiters.clear();
      if (unloadImmediately) {
        runtime.threadLoaded = false; // 即用即卸：下轮 turn 前走 thread/resume 重载
      }
      if (signals.turnCompletedStatus === "failed") {
        runtime.terminalEmitted = true; // turn failed 的 error 即该会话终态（状态机吸收）
        if (runtime.turnErrorNotified === turnId && turnId.length > 0) {
          events = events.filter((event) => event.type !== "error");
        }
      }
    }
    for (const event of events) {
      ctx.emit(event);
    }
  };

  // ---- 审批泵：服务端请求 → permission_request → 等待 resolvePermission 应答 ----
  const handleServerRequest = (
    runtime: SessionRuntime,
    request: ServerRequestFrame,
  ): Promise<ServerRequestOutcome> => {
    const ctx = runtime.ctx;
    if (ctx === null) {
      return Promise.resolve({ handled: false } as ServerRequestOutcome);
    }
    const mapped = approvalEventFor(request.method, request.params, {
      sessionId: runtime.sessionId,
      occurredAt: now(),
      fallbackKey: String(request.id),
    });
    if (mapped === null) {
      return Promise.resolve({ handled: false } as ServerRequestOutcome);
    }
    ctx.emit(mapped.event);
    return new Promise<ServerRequestOutcome>((resolve) => {
      runtime.approvalWaiters.set(mapped.key, {
        method: request.method,
        requestParams: request.params,
        isV1: V1_APPROVAL_METHODS.includes(request.method),
        settle: resolve,
      });
    });
  };

  /** 换客户端/关停时清空审批等待者（应答无处可送：以 decline 语义释放，防悬挂泄漏） */
  const detachApprovalWaiters = (runtime: SessionRuntime): void => {
    for (const waiter of runtime.approvalWaiters.values()) {
      waiter.settle({ handled: true, result: "decline" });
    }
    runtime.approvalWaiters.clear();
  };

  /** 等 turn/completed（waiters 被泵唤醒或超时）；返回 false = 超时仍有活动 turn */
  const waitForTurnCompletion = (runtime: SessionRuntime, timeoutMs: number): Promise<boolean> => {
    if (runtime.activeTurnId === null) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (result: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        runtime.turnCompletionWaiters.delete(fire);
        resolve(result);
      };
      const timer = setTimeout(() => {
        done(runtime.activeTurnId === null);
      }, timeoutMs);
      const fire = (): void => {
        done(true);
      };
      runtime.turnCompletionWaiters.add(fire);
    });
  };

  // ---- 进程退出证明 → 终态事件（排序契约：终态唯一、退出证明之后物化）----
  const watchExitProof = (runtime: SessionRuntime, handle: ProcessHandle): void => {
    void handle.exited.then(
      (proof) => {
        const ctx = runtime.ctx;
        if (ctx === null || runtime.terminalEmitted) return;
        runtime.terminalEmitted = true;
        const base = {
          eventId: `${runtime.processId}-exit-${proof.pid}`,
          sessionId: runtime.sessionId,
          occurredAt: now(),
        };
        if (proof.killedByUs || proof.code === 0) {
          // 本宿主杀掉（用户取消/关停）或 stdin EOF 后干净退出 → 会话终态 stopped
          ctx.emit({ ...base, type: "session", externalSessionId: runtime.threadId });
          return;
        }
        const tail = runtime.client?.stderrTail() ?? "";
        const tailNote = tail.length > 0 ? `；stderr 尾部：${tail.slice(-512)}` : "";
        ctx.emit({
          ...base,
          type: "error",
          message: `codex app-server 进程非零退出（code=${proof.code ?? "null"}${tailNote}）`,
        });
      },
      () => {
        // spawn 失败（进程从未创建）：ensureServer 的 initialize 已 reject 上抛，无事件可物化
      },
    );
  };

  /** 拉起（或复用）app-server 服务端并完成 initialize 握手 */
  const ensureServer = async (
    runtime: SessionRuntime,
    ctx: AdapterContext,
  ): Promise<JsonlRpcClient> => {
    const existing = runtime.client;
    if (existing !== null && !existing.isDead()) {
      return existing;
    }
    if (existing !== null) {
      detachApprovalWaiters(runtime); // 旧连接的应答目标已死，避免跨连接错答 id
      // P1-01 评审 F3：新连接不可能收到旧 turn 的完成通知——respawn 时重置活动
      // turn 标记，否则 mid-turn 崩溃后的 followUp 会在 startTurn 空等 5s 后误抛冲突
      runtime.activeTurnId = null;
    }
    const codexHome = prepareCodexHome(codexHomeRaw ?? ctx.env["CODEX_HOME"]);
    const handle = launchCodexServer({
      cliPath,
      ...(serverArgs !== undefined ? { extraArgs: serverArgs } : {}),
      codexHome,
      cwd: ctx.worktreePath,
      env: ctx.env,
      spawn: spawnFn,
    });
    runtime.handle = handle;
    const client = createJsonlRpcClient({
      handle,
      onNotification: (note) => handleNotification(runtime, note),
      onServerRequest: (request) => handleServerRequest(runtime, request),
      // §8 方法白名单 + 未知容忍：白名单外通知静默计数，白名单外服务端请求由
      // 客户端 -32601 兜底应答（防服务端悬挂）
      serverRequestMethods: KNOWN_SERVER_REQUEST_METHODS,
      notificationMethods: KNOWN_NOTIFICATION_METHODS,
    });
    runtime.client = client;
    runtime.threadLoaded = false; // 新进程内 thread 一律未加载
    watchExitProof(runtime, handle);
    await client.initialize({ name: "aether", title: "Aether", version: "0.1.0" });
    return client;
  };

  /** 发起新 turn：thread 卸载则先 resume（excludeTurns，无历史重放），再 turn/start */
  const startTurn = async (
    runtime: SessionRuntime,
    client: JsonlRpcClient,
    message: string,
  ): Promise<void> => {
    const threadId = runtime.threadId;
    if (threadId === null) {
      throw new Error("turn 前置条件不满足：会话尚无 threadId（thread/start 未完成）");
    }
    // §9-5/§3.1：活动 turn 中 turn/start 会被转为 steer（字段被忽略）——适配器应
    // 靠 turn/completed 确认空闲再发新 turn：先等（≤5s），超时仍活动才上抛冲突
    if (runtime.activeTurnId !== null) {
      const settledInTime = await waitForTurnCompletion(runtime, INTERRUPT_SETTLE_TIMEOUT_MS);
      if (!settledInTime && runtime.activeTurnId !== null) {
        throw new Error(
          `上一 turn 尚未完成（${runtime.activeTurnId}）：请等 turn/completed 再发新 turn`,
        );
      }
    }
    // 空闲后再判卸载（turn/completed 即用即卸信号可能在此等待期间到达）：
    // thread 卸载则 resume 重载（excludeTurns，无历史重放开销）
    if (!runtime.threadLoaded) {
      await client.request("thread/resume", { threadId, excludeTurns: true });
      runtime.threadLoaded = true;
    }
    const result = await client.request("turn/start", {
      threadId,
      input: [textUserInput(message)], // §9-1：省略 text_elements
    });
    const turn =
      result !== null && typeof result === "object"
        ? (result as Record<string, unknown>)["turn"]
        : null;
    const turnId =
      typeof turn === "object" && turn !== null
        ? (turn as Record<string, unknown>)["id"]
        : result !== null && typeof result === "object"
          ? (result as Record<string, unknown>)["turnId"]
          : null;
    if (typeof turnId === "string" && turnId.length > 0) {
      runtime.activeTurnId = turnId; // turn/started 通知未及到达时的先行记录
    }
  };

  /** 关停：interrupt 结算（可选）→ 关 stdin → 等自然退出 → killTree 兜底 */
  const shutdownRuntime = async (runtime: SessionRuntime, interrupt: boolean): Promise<void> => {
    const client = runtime.client;
    if (client === null) return; // 幂等：无活连接静默无操作
    if (
      interrupt &&
      runtime.activeTurnId !== null &&
      runtime.threadId !== null &&
      !client.isDead()
    ) {
      try {
        await client.request("turn/interrupt", {
          threadId: runtime.threadId,
          turnId: runtime.activeTurnId,
        });
        await waitForTurnCompletion(runtime, INTERRUPT_SETTLE_TIMEOUT_MS);
      } catch {
        // interrupt 请求失败（连接已死等）：直接落入关停链路
      }
    }
    client.close(); // stdin EOF：单客户端模式下服务端随之退出（§7）
    const handle = runtime.handle;
    if (handle !== null) {
      const exited = handle.exited.then(
        () => true,
        () => true, // spawn 失败也视为"无需树杀"
      );
      const timeout = new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), EXIT_DRAIN_TIMEOUT_MS);
      });
      const natural = await Promise.race([exited, timeout]);
      if (!natural && handle.pid !== null) {
        await killTreeFn(handle).catch(() => undefined); // 5s 未自然退出：树杀兜底
      }
    }
    detachApprovalWaiters(runtime);
  };

  const makeFacade = (runtime: SessionRuntime): AgentProcess => {
    const facade: AgentProcess = {
      processId: runtime.processId,
      pid: runtime.handle?.pid ?? null,
      cancel: (reason: CancelReason) => adapter.cancel(facade, reason),
      exited:
        runtime.handle !== null
          ? runtime.handle.exited.then(
              (proof: ExitProof) =>
                proof.signal !== null
                  ? { code: proof.code, signal: proof.signal }
                  : { code: proof.code },
              () => ({ code: null }),
            )
          : Promise.resolve({ code: null }),
    };
    return facade;
  };

  const newRuntime = (
    sessionId: string,
    autonomy: AutonomyLevel,
    model: string | null,
    threadId: string | null,
    ctx: AdapterContext | null,
  ): SessionRuntime => {
    const runtime: SessionRuntime = {
      processId: newId(),
      sessionId,
      threadId,
      autonomy,
      model,
      ctx,
      handle: null,
      client: null,
      threadLoaded: false,
      activeTurnId: null,
      turnCompletionWaiters: new Set(),
      approvalWaiters: new Map(),
      terminalEmitted: false,
      turnErrorNotified: null,
      skippedCounts: {},
    };
    runtimes.set(runtime.processId, runtime);
    return runtime;
  };

  const adapter: AgentAdapter = {
    kind: "codex-app-server",
    capabilities: {
      // thread/resume 为一等 RPC 字段（§5 差异表：真恢复 + rejoin 语义）
      canResume: true,
      // 如实声明（§10 定案）：thread/fork 是分叉新会话，非消息级断点续聊
      followUpAtMessage: false,
      permissionFlags: true, // approvalPolicy 维 + 审批应答桥
      structuredEvents: true, // L1：thread/turn/item 结构化通知
      protocols: ["codex-app-server"],
    },

    async discover(): Promise<DiscoverResult> {
      const spec = resolveCodexLaunch(cliPath, {
        extraArgs: [],
        subcommand: ["--version"],
      });
      const probe =
        deps.probeVersion ??
        (async (candidate: LaunchSpec): Promise<string | null> => {
          let handle: ProcessHandle;
          try {
            handle = spawnFn(candidate.command, candidate.args, {
              stdio: ["ignore", "pipe", "pipe"],
            });
          } catch {
            return null;
          }
          let stdoutTail = "";
          const stdout = handle.stdout;
          if (stdout !== null) {
            stdout.setEncoding("utf8");
            stdout.on("data", (chunk: string) => {
              stdoutTail += chunk;
            });
          }
          const timer = setTimeout(() => handle.kill(), 10_000);
          try {
            const proof = await handle.exited;
            if (proof.code === 0) {
              const match = /(\d+\.\d+\.\d+)/.exec(stdoutTail);
              if (match !== null && match[1] !== undefined) return match[1];
            }
          } catch {
            return null; // 进程从未创建（ENOENT）
          } finally {
            clearTimeout(timer);
          }
          return null;
        });
      const version = await probe(spec);
      return version !== null
        ? { available: true, version }
        : { available: false, installHint: installHint() };
    },

    async spawn(input: SpawnInput, ctx: AdapterContext): Promise<AgentProcess> {
      const runtime = newRuntime(input.sessionId, input.autonomy, input.model ?? null, null, ctx);
      try {
        const client = await ensureServer(runtime, ctx);
        const policy = autonomyToCodexPolicy(runtime.autonomy);
        const result = (await client.request("thread/start", {
          cwd: ctx.worktreePath,
          sandbox: policy.sandbox,
          approvalPolicy: policy.approvalPolicy,
          ...(runtime.model !== null ? { model: runtime.model } : {}),
        })) as Record<string, unknown> | null;
        const thread =
          result !== null ? (result["thread"] as Record<string, unknown> | undefined) : undefined;
        const threadId =
          (typeof thread?.["id"] === "string" ? thread["id"] : null) ??
          (typeof result?.["threadId"] === "string" ? result["threadId"] : null);
        if (threadId === null) {
          throw new Error("thread/start 响应缺少 thread.id");
        }
        runtime.threadId = threadId;
        runtime.threadLoaded = true;
        ctx.emit({
          eventId: `${runtime.processId}-thread-${threadId}`,
          sessionId: runtime.sessionId,
          occurredAt: now(),
          type: "session",
          externalSessionId: threadId,
        });
        await startTurn(runtime, client, input.message);
      } catch (error) {
        // 启动失败：清理本 runtime 避免半开会话；错误上抛给调用方（daemon 落 error 态）
        runtimes.delete(runtime.processId);
        void shutdownRuntime(runtime, false).catch(() => undefined);
        throw error instanceof Error ? error : new Error(errorText(error));
      }
      return makeFacade(runtime);
    },

    async spawnFollowUp(
      proc: AgentProcess,
      input: { message: string },
      ctx: AdapterContext,
    ): Promise<void> {
      const runtime = runtimes.get(proc.processId);
      if (runtime === undefined) {
        throw new Error(`未知 processId：${proc.processId}（会话运行时不存在或已清理）`);
      }
      runtime.ctx = ctx;
      const client = await ensureServer(runtime, ctx); // 进程已死则重拉 + resume 重载
      try {
        await startTurn(runtime, client, input.message);
      } catch (error) {
        ctx.emit({
          eventId: `${runtime.processId}-followup-error-${now()}`,
          sessionId: runtime.sessionId,
          occurredAt: now(),
          type: "error",
          message: `follow-up 失败：${errorText(error)}`,
        });
        throw error instanceof Error ? error : new Error(errorText(error));
      }
    },

    async resume(session: SessionRecord, ctx: AdapterContext): Promise<AgentProcess> {
      const external = session.externalSessionId;
      if (external === null || external.length === 0) {
        throw new Error(
          "resume 前置条件不满足：session.externalSessionId 为空（无 codex threadId 可恢复）",
        );
      }
      // 端口 resume 未携带 autonomy：保守默认 read_only（daemon 侧可重建会话覆盖，
      // 与 claude adapter 同款端口缺口处理）
      const runtime = newRuntime(session.id, "read_only", null, external, ctx);
      let client: JsonlRpcClient;
      let result: unknown;
      try {
        client = await ensureServer(runtime, ctx);
        // §10 定案：默认全量水合（excludeTurns 缺省 = 响应内嵌 thread.turns 全历史）
        result = await client.request("thread/resume", { threadId: external });
      } catch (error) {
        runtimes.delete(runtime.processId);
        void shutdownRuntime(runtime, false).catch(() => undefined);
        throw error instanceof Error ? error : new Error(errorText(error));
      }
      runtime.threadLoaded = true;
      ctx.emit({
        eventId: `${runtime.processId}-resume-${external}`,
        sessionId: runtime.sessionId,
        occurredAt: now(),
        type: "session",
        externalSessionId: external,
      });
      const thread =
        result !== null && typeof result === "object"
          ? (result as Record<string, unknown>)["thread"]
          : null;
      const turns =
        thread !== null && typeof thread === "object"
          ? (thread as Record<string, unknown>)["turns"]
          : result !== null && typeof result === "object"
            ? (result as Record<string, unknown>)["turns"]
            : undefined;
      const hydrated = mapResumeTurns(turns, {
        sessionId: runtime.sessionId,
        threadId: external,
        occurredAtFallback: now(),
      });
      runtime.skippedCounts = { ...runtime.skippedCounts, ...hydrated.skipped };
      for (const event of hydrated.events) {
        ctx.emit(event);
      }
      return makeFacade(runtime);
    },

    async cancel(proc: AgentProcess, _reason: CancelReason): Promise<void> {
      const runtime = runtimes.get(proc.processId);
      if (runtime === undefined) return; // 幂等：未知/已清理的句柄静默无操作
      await shutdownRuntime(runtime, true); // interrupt → 等 turn/completed → EOF → 树杀
    },

    async resolvePermission(
      processId: string,
      requestId: string,
      decision: PermissionDecision,
    ): Promise<void> {
      const runtime = runtimes.get(processId);
      const waiter = runtime?.approvalWaiters.get(requestId);
      if (runtime === undefined || waiter === undefined) {
        throw new Error(`无待决权限请求：processId=${processId} requestId=${requestId}`);
      }
      runtime.approvalWaiters.delete(requestId);
      const choice = decision === "approve" ? "allow" : "deny";
      // 双线对账（P1-01）：v2 decision 系方法（commandExecution/fileChange）应答 result
      // 是对象 {decision: <值>}（协议 §4；fixtures codex 引擎同口径读 frame.result.decision）；
      // permissions 方法应答形状特例（P1-01 评审 F1，官方 schema
      // PermissionsRequestApprovalResponse）——{permissions: GrantedPermissionProfile,
      // scope}，无 decline 字面量：deny=空授权、approve=请求 params.permissions 原样回授；
      // v1 DEPRECATED 遗留为裸 ReviewDecision 值，维持兜底形状
      const result = waiter.isV1
        ? v1ApprovalDecision(choice)
        : waiter.method === PERMISSIONS_APPROVAL_METHOD
          ? v2PermissionsGrant(choice, waiter.requestParams)
          : { decision: v2ApprovalDecision(choice) };
      const client = runtime.client;
      if (client === null) {
        waiter.settle({ handled: true, result: "decline" });
        return;
      }
      // 并发应答：原样回传服务端请求 id（§9-4）；连接已死时写失败由 client 收敛
      waiter.settle({ handled: true, result });
    },

    normalizeLogs(raw: unknown[]): ProviderEvent[] {
      // 旁路重放：sessionId 占位 "replay"（P0-09 落库以 execution_process 行归属为准）
      return normalizeFrames(raw).events;
    },

    async dispose(): Promise<void> {
      const all = [...runtimes.values()];
      runtimes.clear();
      await Promise.allSettled(all.map((runtime) => shutdownRuntime(runtime, true)));
    },
  };

  return adapter;
}
