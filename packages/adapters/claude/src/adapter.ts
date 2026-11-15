import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  Options,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
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
import {
  mapSdkMessage,
  normalizeStream,
  vendorTimestamp,
  type TerminalIntent,
} from "./normalize.js";
import { createProcessHostSpawn } from "./spawn-bridge.js";

// ===== Claude L1 适配器（@anthropic-ai/claude-agent-sdk 实现，P0-07）=====
// - 事件直出不解析终端流（蓝图 §5：L1 结构化事件，状态直接来自协议）；
// - 进程治理经 process-host：SDK spawnClaudeCodeProcess 钩子（0.3.325 查证定案，
//   官方自定义 spawn 注入点）路由进 spawnCommand，取 PID/ExitProof/killTree；
// - 排序契约（core 状态机）：终态事件在进程退出证明之后物化——先判非零退出
//   （发 error），干净退出才发 session 终态；被本宿主杀掉（killedByUs）= 用户取消
//   → stopped 而非 error。

/** 依赖注入缝：query/spawn/killTree/时钟/探针均可替换（单测 mock 注入） */
export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

export interface ClaudeAdapterDeps {
  readonly query?: QueryFn;
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnTrackedOptions,
  ) => ProcessHandle;
  readonly killTree?: (target: ProcessHandle | number) => Promise<unknown>;
  readonly now?: () => string;
  readonly newId?: () => string;
  /** discover 版本探针（默认真实探测候选 CLI 列表） */
  readonly probeVersion?: (candidates: readonly string[]) => Promise<string | null>;
}

interface RunState {
  readonly abortController: AbortController;
  handle: ProcessHandle | null;
  readonly whenSpawned: Promise<void>;
  readonly notifySpawned: () => void;
  readonly failSpawned: (error: Error) => void;
  readonly permissionWaiters: Map<string, (result: PermissionResult) => void>;
}

interface SessionRuntime {
  readonly processId: string;
  readonly sessionId: string;
  externalSessionId: string | null;
  /** 事件序号（跨 run 单调，eventId 组成部分） */
  eventSeq: number;
  /** follow-up/resume 复用的会话参数（端口未携带时的会话内记忆） */
  autonomy: AutonomyLevel;
  model: string | null;
  /**
   * 活跃 run 集合（spec-review 定案）：runtime 单槽会在"上一轮未结束就 follow-up"
   * 时静默顶替、丢失旧 run 治理句柄——违背 §6.2『spawn 即拥有子进程』。
   * 集合保证任一时刻全部活跃 run 的 abort/killTree/权限等待都可触达；
   * pump 终态事件物化后自集合移除。
   */
  activeRuns: Set<RunState>;
}

/** autonomy → SDK permissionMode 映射（SYSTEM_DESIGN §6.2；auto 为 SDK 0.3.x 实有模式：分类器裁决+canUseTool 兜底） */
function permissionModeFor(autonomy: AutonomyLevel): PermissionMode {
  switch (autonomy) {
    case "read_only":
      return "plan";
    case "workspace_write":
      return "acceptEdits";
    case "auto":
      return "auto";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summaryForPermissionAsk(options: Parameters<CanUseTool>[2], toolName: string): string {
  const title = options.title ?? options.description ?? options.displayName;
  return typeof title === "string" && title.length > 0 ? title : `${toolName} 请求授权`;
}

const INSTALL_HINT =
  "未探测到 claude CLI：安装 @anthropic-ai/claude-agent-sdk（自带平台 CLI 二进制）、" +
  "或将 claude CLI 装入 PATH、或在 provider 配置 config.cliPath 指定可执行文件路径。";

/** 解析 SDK 自带平台 CLI 二进制路径（win32→claude.exe，其余→claude；linux 含 musl 变体） */
export function resolveBundledCliPath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
    const sdkRequire = createRequire(sdkEntry);
    const platform = `${process.platform}-${process.arch}`;
    const variants = process.platform === "linux" ? [platform, `${platform}-musl`] : [platform];
    for (const variant of variants) {
      try {
        const pkgPath = sdkRequire.resolve(
          `@anthropic-ai/claude-agent-sdk-${variant}/package.json`,
        );
        const bin = join(dirname(pkgPath), process.platform === "win32" ? "claude.exe" : "claude");
        if (existsSync(bin)) return bin;
      } catch {
        // 该平台变体未安装，尝试下一候选
      }
    }
  } catch {
    // SDK 本体不可解析（未安装）——交由候选列表兜底
  }
  return null;
}

/**
 * 创建 Claude 适配器（AgentAdapter 全九方法）。
 * cfg.config 可选键：cliPath（覆盖 CLI 路径 → Options.pathToClaudeCodeExecutable，
 * 同时作为 discover 第一候选）。
 */
export function createClaudeAdapter(
  cfg: ResolvedProviderConfig,
  deps: ClaudeAdapterDeps = {},
): AgentAdapter {
  if (cfg.kind !== "claude-sdk") {
    throw new Error(`createClaudeAdapter 只接受 kind='claude-sdk'（收到 '${cfg.kind}'）`);
  }
  const cliPathOverride =
    typeof cfg.config.cliPath === "string" && cfg.config.cliPath.length > 0
      ? cfg.config.cliPath
      : null;
  // 成本护栏（spec-review 定案）：真实计费测试的轮次上限应落在 flag 而非提示词约束
  const maxTurnsOverride =
    typeof cfg.config.maxTurns === "number" &&
    Number.isInteger(cfg.config.maxTurns) &&
    cfg.config.maxTurns > 0
      ? cfg.config.maxTurns
      : null;

  const queryFn: QueryFn = deps.query ?? (sdkQuery as unknown as QueryFn);
  const spawnFn = deps.spawn ?? realSpawnCommand;
  const killTreeFn = deps.killTree ?? realKillTree;
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const runtimes = new Map<string, SessionRuntime>();

  const startRun = (
    runtime: SessionRuntime,
    message: string,
    ctx: AdapterContext,
    resumeFrom: string | null,
  ): RunState => {
    let settleSpawned: ((error?: Error) => void) | undefined;
    const whenSpawned = new Promise<void>((resolve, reject) => {
      settleSpawned = (error?: Error) => {
        if (error !== undefined) reject(error);
        else resolve();
      };
    });
    void whenSpawned.catch(() => undefined); // 防 unhandled rejection（spawn() 会 await）

    let spawnedSettled = false;
    const notifySpawned = (): void => {
      if (spawnedSettled) return;
      spawnedSettled = true;
      settleSpawned?.();
    };
    const failSpawned = (error: Error): void => {
      if (spawnedSettled) return;
      spawnedSettled = true;
      settleSpawned?.(error);
    };

    const run: RunState = {
      abortController: new AbortController(),
      handle: null,
      whenSpawned,
      notifySpawned,
      failSpawned,
      permissionWaiters: new Map(),
    };

    const spawnHook = createProcessHostSpawn({
      spawn: spawnFn,
      onHandle: (handle) => {
        run.handle = handle;
        notifySpawned();
      },
    });

    const permissionHook: CanUseTool = (toolName, _input, options) =>
      new Promise<PermissionResult | null>((resolve) => {
        const requestId =
          typeof options.requestId === "string" && options.requestId.length > 0
            ? options.requestId
            : options.toolUseID;
        runtime.eventSeq += 1;
        ctx.emit({
          eventId: `${runtime.processId}-perm-${runtime.eventSeq}`,
          sessionId: runtime.sessionId,
          occurredAt: now(),
          type: "permission_request",
          requestId,
          toolName,
          summary: summaryForPermissionAsk(options, toolName),
        });
        run.permissionWaiters.set(requestId, resolve);
        options.signal.addEventListener(
          "abort",
          () => {
            if (run.permissionWaiters.delete(requestId)) {
              resolve({ behavior: "deny", message: "cancelled" });
            }
          },
          { once: true },
        );
      });

    const options: Options = {
      cwd: ctx.worktreePath,
      // SDK 语义：env 整体替换子进程环境（不与 process.env 合并）——自行铺底再叠加注入项
      env: { ...process.env, ...ctx.env },
      permissionMode: permissionModeFor(runtime.autonomy),
      abortController: run.abortController,
      spawnClaudeCodeProcess: spawnHook,
      canUseTool: permissionHook,
      ...(runtime.model !== null ? { model: runtime.model } : {}),
      ...(resumeFrom !== null ? { resume: resumeFrom } : {}),
      ...(cliPathOverride !== null ? { pathToClaudeCodeExecutable: cliPathOverride } : {}),
      ...(maxTurnsOverride !== null ? { maxTurns: maxTurnsOverride } : {}),
    };

    // 事件泵：驱动 query 流 → 归一化 → ctx.emit；终态按退出证明物化。
    // 不抛出（全部错误收敛为 error 事件 / whenSpawned 拒绝）。
    const pump = async (): Promise<void> => {
      let terminal: TerminalIntent | null = null;
      let failure: unknown = null;
      let sawMessage = false;
      try {
        for await (const message_ of queryFn({ prompt: message, options })) {
          if (!sawMessage) {
            sawMessage = true;
            notifySpawned(); // 防御：spawn 钩子未触发（如预热会话）也能解除 spawn 等待
          }
          runtime.eventSeq += 1;
          const mapped = mapSdkMessage(message_, {
            sessionId: runtime.sessionId,
            seq: runtime.eventSeq,
            occurredAt: vendorTimestamp(message_) ?? now(),
            eventIdPrefix: runtime.processId,
          });
          if (mapped.externalSessionId !== null) {
            runtime.externalSessionId = mapped.externalSessionId;
          }
          if (mapped.terminal !== null) {
            terminal = mapped.terminal;
          }
          for (const event of mapped.events) {
            ctx.emit(event);
          }
        }
      } catch (error) {
        failure = error;
      }
      let proof: ExitProof | null = null;
      if (run.handle !== null) {
        try {
          proof = await run.handle.exited;
        } catch (error) {
          failure ??= error; // spawn 失败（进程从未创建，无证明可产）
        }
      }
      if (failure !== null) {
        failSpawned(failure instanceof Error ? failure : new Error(errorMessage(failure)));
      }
      ctx.emit(decideTerminalEvent(runtime, terminal, proof, failure));
      runtime.activeRuns.delete(run); // 终态已物化：本 run 不再活跃，治理收敛于其余活跃 run
    };
    void pump();

    runtime.activeRuns.add(run);
    return run;
  };

  /** 终态判定（排序契约：退出证明之后；非零退出先于干净收敛；killedByUs = 取消 → stopped） */
  const decideTerminalEvent = (
    runtime: SessionRuntime,
    terminal: TerminalIntent | null,
    proof: ExitProof | null,
    failure: unknown,
  ): ProviderEvent => {
    const base = {
      eventId: `${runtime.processId}-end-${++runtime.eventSeq}`,
      sessionId: runtime.sessionId,
      occurredAt: now(),
    };
    if (terminal?.kind === "error") {
      return { ...base, type: "error", message: terminal.message };
    }
    if (proof?.killedByUs === true) {
      return { ...base, type: "session", externalSessionId: runtime.externalSessionId };
    }
    if (proof !== null && proof.code !== 0) {
      const signal = proof.signal !== null ? `，signal=${proof.signal}` : "";
      return {
        ...base,
        type: "error",
        message: `CLI 进程非零退出（code=${proof.code ?? "null"}${signal}）`,
      };
    }
    if (failure !== null) {
      return { ...base, type: "error", message: errorMessage(failure) };
    }
    return { ...base, type: "session", externalSessionId: runtime.externalSessionId };
  };

  const adapter: AgentAdapter = {
    kind: "claude-sdk",
    capabilities: {
      canResume: true, // SDK resume: <sessionId>（会话恢复，调研 06 §9.2 属"真支持"梯队）
      // 如实声明（spec-review 定案）：当前仅整会话 --resume；消息级断点
      // （Options.resumeSessionAt）待端口扩展 follow-up 入参携带 messageUuid 后再启用
      followUpAtMessage: false,
      permissionFlags: true, // permissionMode + canUseTool 桥
      structuredEvents: true, // L1：stream-json 结构化事件
      protocols: [],
    },

    async discover(): Promise<DiscoverResult> {
      const candidates = [cliPathOverride, resolveBundledCliPath(), "claude"].filter(
        (entry): entry is string => entry !== null,
      );
      const probe = deps.probeVersion ?? probeCliVersions(spawnFn);
      const version = await probe([...new Set(candidates)]);
      if (version !== null) {
        return { available: true, version };
      }
      return { available: false, installHint: INSTALL_HINT };
    },

    async spawn(input: SpawnInput, ctx: AdapterContext): Promise<AgentProcess> {
      const runtime: SessionRuntime = {
        processId: newId(),
        sessionId: input.sessionId,
        externalSessionId: null,
        eventSeq: 0,
        autonomy: input.autonomy,
        model: input.model ?? null,
        activeRuns: new Set(),
      };
      runtimes.set(runtime.processId, runtime);
      const run = startRun(runtime, input.message, ctx, null);
      // 拿到 PID 再返回；启动失败（进程从未创建）在此冒泡，error 事件已由泵发出
      await run.whenSpawned;
      const facade: AgentProcess = {
        processId: runtime.processId,
        pid: run.handle?.pid ?? null,
        cancel: (reason: CancelReason) => adapter.cancel(facade, reason),
        exited:
          run.handle !== null
            ? run.handle.exited.then((proof) =>
                proof.signal !== null
                  ? { code: proof.code, signal: proof.signal }
                  : { code: proof.code },
              )
            : Promise.resolve({ code: null }),
      };
      return facade;
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
      const resumeId = runtime.externalSessionId;
      if (resumeId === null) {
        throw new Error(
          "会话尚无 externalSessionId，无法 follow-up（需先完成 init/result 握手或经 resume 恢复）",
        );
      }
      const run = startRun(runtime, input.message, ctx, resumeId);
      await run.whenSpawned;
    },

    async resume(session: SessionRecord, _ctx: AdapterContext): Promise<AgentProcess> {
      const external = session.externalSessionId;
      if (external === null || external.length === 0) {
        throw new Error(
          "resume 前置条件不满足：session.externalSessionId 为空（只能新会话+喂 transcript）",
        );
      }
      // 恢复 = 可续会话句柄（无活进程）：daemon 重启后原 CLI 进程已亡，
      // 首条 follow-up 才拉起新进程（resume 参数）。pid=null / exited 立即收敛
      // 是"无活进程"的诚实表达（port 形状限制，见包 README notes）。
      const runtime: SessionRuntime = {
        processId: newId(),
        sessionId: session.id,
        externalSessionId: external,
        eventSeq: 0,
        // 端口 resume 未携带 autonomy：保守默认 read_only（daemon 侧可经 spawn 覆盖，
        // 端口缺口记录于任务 notes）
        autonomy: "read_only",
        model: null,
        activeRuns: new Set(),
      };
      runtimes.set(runtime.processId, runtime);
      const facade: AgentProcess = {
        processId: runtime.processId,
        pid: null,
        cancel: (reason: CancelReason) => adapter.cancel(facade, reason),
        exited: Promise.resolve({ code: null }),
      };
      return facade;
    },

    async cancel(proc: AgentProcess, reason: CancelReason): Promise<void> {
      const runtime = runtimes.get(proc.processId);
      if (runtime === undefined) return; // 幂等：未知/已清理的句柄静默无操作
      // 取消会话 = 取消其全部活跃轮（含"上一轮未结束就 follow-up"的旧 run——
      // 集合化保证治理句柄零失联，spec-review major 修复）
      const targets = [...runtime.activeRuns];
      if (targets.length === 0) return;
      const killPromises: Promise<unknown>[] = [];
      for (const run of targets) {
        run.abortController.abort(reason); // SDK 优雅中止（stdin EOF + 宽限）
        const handle = run.handle;
        if (handle !== null) {
          killPromises.push(killTreeFn(handle)); // 用户取消：树杀 + 退出证明（killedByUs）
        }
      }
      await Promise.allSettled(killPromises);
    },

    async resolvePermission(
      processId: string,
      requestId: string,
      decision: PermissionDecision,
    ): Promise<void> {
      const runtime = runtimes.get(processId);
      // 活跃 run 集合内查找该待决请求（单会话同一时刻通常仅一轮活跃，集合遍历更稳）
      const entry =
        runtime === undefined
          ? undefined
          : [...runtime.activeRuns]
              .map((run) => ({ run, waiter: run.permissionWaiters.get(requestId) }))
              .find((item) => item.waiter !== undefined);
      if (runtime === undefined || entry === undefined) {
        throw new Error(`无待决权限请求：processId=${processId} requestId=${requestId}`);
      }
      entry.run.permissionWaiters.delete(requestId);
      entry.waiter?.(
        decision === "approve" ? { behavior: "allow" } : { behavior: "deny", message: "用户拒绝" },
      );
    },

    normalizeLogs(raw: unknown[]): ProviderEvent[] {
      const parsed = raw.map((entry) => {
        if (typeof entry !== "string") return entry;
        try {
          return JSON.parse(entry) as unknown;
        } catch {
          return undefined; // 非法 JSONL 行：丢弃（旁路转换器不炸）
        }
      });
      // sessionId 占位 "replay"：normalizeLogs 端口无会话上下文，
      // P0-09 落库时以 execution_process 行归属为准
      return normalizeStream({ sessionId: "replay", messages: parsed }).events;
    },

    async dispose(): Promise<void> {
      // 遍历全部会话 × 全部活跃 run（集合化：无一失联）
      const liveRuns = [...runtimes.values()].flatMap((runtime) => [...runtime.activeRuns]);
      for (const run of liveRuns) {
        run.abortController.abort("shutdown");
      }
      await Promise.allSettled(
        liveRuns.map((run) => (run.handle !== null ? killTreeFn(run.handle) : undefined)),
      );
      runtimes.clear();
    },
  };

  return adapter;
}

/** 默认版本探测：逐候选执行 `<cli> --version`（10s 超时强杀；探测进程本身走治理 spawn） */
function probeCliVersions(
  spawn: (command: string, args: readonly string[], options: SpawnTrackedOptions) => ProcessHandle,
): (candidates: readonly string[]) => Promise<string | null> {
  return async (candidates: readonly string[]): Promise<string | null> => {
    for (const candidate of candidates) {
      let handle: ProcessHandle;
      try {
        handle = spawn(candidate, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        continue; // 候选不可用
      }
      let stdoutTail = "";
      const stdout = handle.stdout;
      if (stdout !== null) {
        stdout.setEncoding("utf8");
        stdout.on("data", (chunk: string) => {
          stdoutTail += chunk;
        });
      }
      const timer = setTimeout(() => {
        handle.kill();
      }, 10_000);
      try {
        const proof = await handle.exited;
        if (proof.code === 0) {
          const match = /(\d+\.\d+\.\d+)/.exec(stdoutTail);
          if (match !== null) return match[1] ?? null;
        }
      } catch {
        // 进程从未创建（ENOENT）→ 尝试下一候选
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  };
}

export type { SpawnOptions, SpawnedProcess };
