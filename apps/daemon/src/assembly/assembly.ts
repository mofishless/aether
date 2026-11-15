// daemon 组装根（P0-10 落地 + P0-11 服务全量）：把 storage / 适配器注册表 /
// 终端池 / 事件总线 / 执行日志管线 / agents/catalog/diff 服务装配为可注入的整体。
// 组装根保持薄：全部依赖经 options 注入可替换（测试换内存库/假件），本模块只做接线，不写业务。
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExecutionLogReplayService,
  ExecutionLogSink,
  WorktreeLifecycleService,
  computeWorkspaceDiff,
  createAdapter,
  registerAdapter,
  type AdapterContext,
  type ExecutionLogSinkError,
  type ReplayResult,
} from "@aether/core";
import {
  ProviderEventSchema,
  TerminalExitFrameSchema,
  TerminalOutputFrameSchema,
  terminalExitTopic,
  terminalOutputTopic,
  type ProviderEvent,
} from "@aether/contracts";
import { createClaudeAdapter } from "@aether/adapter-claude";
import {
  AgentProfileRepository,
  ExecutionProcessLogRepository,
  ExecutionProcessRepository,
  ProjectRepository,
  ProviderConfigRepository,
  SessionRepository,
  TaskRepository,
  WorkspaceRepository,
  closeDatabase,
  openStorage,
} from "@aether/storage";
import { createTerminalPool, warmupConpty, type TerminalPool } from "@aether/terminal";
import { AgentService } from "../agents/agents-service.js";
import { CatalogService } from "../catalog/catalog-service.js";
import { DiffService } from "../diff/diff-service.js";
import { createEventBus, type EventBus } from "../events/event-bus.js";

/** 默认 sink 异常上报：stderr 中文日志（token 等敏感值绝不出现在事件载荷中） */
function defaultSinkErrorLog(error: ExecutionLogSinkError): void {
  process.stderr.write(`[aether-daemon] 执行日志管线异常：${JSON.stringify(error)}\n`);
}

export interface DaemonAssemblyOptions {
  /**
   * SQLite 数据库路径；默认 ':memory:'。
   * TODO(P0-11 desktop 线)：默认路径策略接 desktop userData（launcher 注入 env），
   * 现以 AETHER_DAEMON_DB_PATH 为临时注入缝（见 index.ts）。
   */
  readonly dbPath?: string;
  /** 终端池注入缝（测试假件）；默认真 TerminalPool */
  readonly terminalPool?: TerminalPool;
  /** 事件总线注入缝；默认新建 */
  readonly eventBus?: EventBus;
  /** 执行日志 sink 异常回调；默认 stderr 中文日志 */
  readonly onSinkError?: (error: ExecutionLogSinkError) => void;
  /** agents 服务注入缝（测试假件；注入后本组装根不再自建 agents 服务） */
  readonly agents?: AgentService;
  /** catalog 服务注入缝（测试假件） */
  readonly catalog?: CatalogService;
  /** diff 服务注入缝（测试假件） */
  readonly diff?: DiffService;
  /**
   * worktree 回退基座目录（主基座 .aether-worktrees/ 不可写时使用；
   * 生产应注入 userData，P0 缺省系统 tmp——desktop launcher 接线后收紧）。
   */
  readonly worktreeFallbackDir?: string;
  /**
   * provider config 的 cliPath 覆盖（E2E/测试注入缝：fixtures/aether-mock-cli）。
   * 缺省读 env AETHER_AGENT_CLI_PATH（空/缺失 = undefined，走 adapter 默认解析）。
   * 注意：env 值只进 adapter config，绝不落库、绝不进事件载荷。
   */
  readonly agentCliPath?: string;
  /** ConPTY 预热实现注入缝（测试假件；默认 terminal 包 warmupConpty） */
  readonly warmup?: () => Promise<void>;
}

export interface AgentEventContextInput {
  /** = execution_process.id（外键链由 spawn 流程先建行，agents.spawn 服务负责） */
  readonly processId: string;
  /** agent 的 cwd */
  readonly worktreePath: string;
  /** 注入 env（值永不落库） */
  readonly env?: Record<string, string>;
  /** 自定义 provider resume 时重水化历史事件 */
  readonly loadEvents: (sessionId: string) => Promise<ProviderEvent[]>;
}

export interface DaemonAssembly {
  /** 原始连接（测试建外键链用；agents 服务落地后常规路径不再直触） */
  readonly db: DatabaseSync;
  readonly eventBus: EventBus;
  readonly terminalPool: TerminalPool;
  readonly logSink: ExecutionLogSink;
  /** projects 组与 tasks 组方法（P0-11） */
  readonly catalog: CatalogService;
  /** agents 组与 sessions 组方法（P0-11） */
  readonly agents: AgentService;
  /** diff.* 方法组（P0-11） */
  readonly diff: DiffService;
  /** adapter 事件泵接线（P0-09 收口）：emit → 执行日志管线入库 */
  createAgentEventContext(input: AgentEventContextInput): AdapterContext;
  /** 重放进程日志；sessionId 归属自动接线（execution_process 行 → sessionIdOverride） */
  replayProcessLogs(processId: string): ReplayResult;
  /**
   * ConPTY 后台预热（调研 06 §9.1：摊平 Windows 首建秒级冷启动）。
   * 注意：node-pty 的 ConPTY spawn 含同步段，会阻塞事件循环——入口必须在
   * listening 行写出之后再调（否则吃掉 supervisor 的启动超时预算，P0-10 实测
   * 全量并行下 --hang-silent 用例 28 次重启）。尽力而为：失败不置位、不抛错。
   * P0-11 孤儿收口：warmup 的哑 PTY 不在池中——close() 会等待在途预热收口
   *（dispose 内有 SIGKILL 升级 + 5s settle 兜底，等待有界）。
   */
  warmupConptyInBackground(): void;
  /** 优雅关闭：agent 全释放 → 终端全释放（退出帧正常出站）→ sink 余量落库 → 数据库关闭；幂等 */
  close(): Promise<void>;
}

export function createDaemonAssembly(options: DaemonAssemblyOptions = {}): DaemonAssembly {
  const dbPath = options.dbPath ?? ":memory:";
  const db = openStorage(dbPath);
  const eventBus = options.eventBus ?? createEventBus();
  const terminalPool = options.terminalPool ?? createTerminalPool();

  // §6.4：daemon 启动注册内置 kind（当前唯一内置 = claude-sdk；未来 acp/tui 以新 kind 进同一注册表）
  registerAdapter("claude-sdk", createClaudeAdapter);
  // 重放用常驻适配器实例：normalizeLogs 是纯转换器（无进程状态），复用安全
  const claudeAdapter = createClaudeAdapter({
    kind: "claude-sdk",
    providerConfigId: "builtin-claude-sdk",
    displayName: "Claude",
    config: {},
  });

  const logs = new ExecutionProcessLogRepository(db);
  const processes = new ExecutionProcessRepository(db);
  const projects = new ProjectRepository(db);
  const tasks = new TaskRepository(db);
  const workspaces = new WorkspaceRepository(db);
  const profiles = new AgentProfileRepository(db);
  const providerConfigs = new ProviderConfigRepository(db);
  const sessions = new SessionRepository(db);
  const logSink = new ExecutionLogSink({
    store: logs,
    onError: options.onSinkError ?? defaultSinkErrorLog,
  });
  const replay = new ExecutionLogReplayService(logs);
  const worktrees = new WorktreeLifecycleService({
    store: workspaces, // WorkspaceRepository 结构性满足 WorkspaceStore 端口（§2 依赖倒置）
    fallbackDir: options.worktreeFallbackDir ?? join(tmpdir(), "aether-worktrees-fallback"),
  });

  const replayProcessLogs = (processId: string): ReplayResult => {
    const row = processes.findById(processId);
    if (row === null) {
      throw new Error(`未知进程：execution_process 行不存在（processId=${processId}）`);
    }
    // 归属修正用 execution_process 行的 sessionId（P0-09 注释定案形态）。
    // kind 归属（P0-11 收口）：agents.spawn 落库 commandJson={"kind":...}——
    // P0 仅 claude-sdk 一个内置 kind，其他 kind 到来时在此按 kind 分发重放器。
    //
    // 行内容双形态（P0-10 定案）：daemon emit 写入的行 = 归一化 ProviderEvent
    // JSON（透传回填即可——经 mapSdkMessage 会落兜底跳过、静默重放 0 事件，
    // spec-review minor 修复）；SDK 原始帧行（fixture 回放/P0-11 原始行缝打开后）
    // = 走 normalizeLogs 归一化。两形态键面不相交，safeParse 探测无歧义；
    // 混合行按 SDK 帧整批处理（当前写入路径单一进程只有一种形态）。
    return replay.replayProcess(
      processId,
      (raw) => {
        // raw 行可能是 JSON 字符串（rawJson 落库形态）或已解析对象——先统一解包
        const parsedAll = raw.map((line) => {
          let value: unknown = line;
          if (typeof line === "string") {
            try {
              value = JSON.parse(line) as unknown;
            } catch {
              value = line; // 非法 JSON：safeParse 必败 → 走 SDK 帧分支兜底
            }
          }
          return ProviderEventSchema.safeParse(value);
        });
        if (parsedAll.length > 0 && parsedAll.every((r) => r.success)) {
          return parsedAll.map((r) => (r as { success: true; data: ProviderEvent }).data);
        }
        return claudeAdapter.normalizeLogs(raw);
      },
      { sessionIdOverride: row.sessionId },
    );
  };

  const createAgentEventContext = (input: AgentEventContextInput): AdapterContext => {
    const { processId, worktreePath, loadEvents } = input;
    const env = input.env ?? {};
    return {
      worktreePath,
      env,
      loadEvents,
      // 定案（P0-10 deviations）：adapter 未暴露 SDK 原始行流（spawn 桥在
      // adapter 内部、原始行无出站缝，且 P0-10 卡不得改 adapters/claude/src）——
      // 以归一化 ProviderEvent 的 JSON 行入执行日志（rawJson = 归一化事件）。
      // P0-11 定案：该缝保持关闭——归一化事件落库路径已覆盖重放（sessions.listEvents），
      // SDK 原始行订阅需求出现时再开（成本：spawn 桥加行流回调 + 队列治理）。
      // emit 前过 ProviderEventSchema：入库行保证可被事件面信任（wire 边界 fail-closed 同口径）。
      emit(ev: ProviderEvent): void {
        const parsed = ProviderEventSchema.safeParse(ev);
        if (!parsed.success) {
          process.stderr.write(
            `[aether-daemon] 拒绝入库的非法 ProviderEvent：${parsed.error.message}\n`,
          );
          return;
        }
        logSink.append(processId, JSON.stringify(parsed.data));
      },
    };
  };

  // P0-11 服务装配：agents.spawn 事件泵经 createAgentEventContext 落库，
  // 再由服务层包装"一路三发"（见 agents-service.ts）；全部依赖此处注入。
  const agentCliPath =
    options.agentCliPath !== undefined
      ? options.agentCliPath
      : readEnvCliPath(process.env["AETHER_AGENT_CLI_PATH"]);
  const agents =
    options.agents ??
    new AgentService({
      eventBus,
      projects,
      tasks,
      workspaces,
      profiles,
      providerConfigs,
      sessions,
      processes,
      worktrees,
      createEventContext: createAgentEventContext,
      replayProcessLogs,
      logSink,
      createAdapterInstance: createAdapter,
      ...(agentCliPath !== undefined ? { cliPathOverride: agentCliPath } : {}),
    });
  const catalog =
    options.catalog ??
    new CatalogService({
      eventBus,
      projects,
      tasks,
    });
  const diff =
    options.diff ??
    new DiffService({
      workspaces,
      projects,
      computeDiff: computeWorkspaceDiff,
    });

  // 终端输出/退出 → 事件总线（payload 经 zod 校验后出站，见 event-bus.ts）
  terminalPool.onOutput((frame) => {
    eventBus.publish(terminalOutputTopic(frame.terminalId), frame, TerminalOutputFrameSchema);
  });
  terminalPool.onExit((frame) => {
    eventBus.publish(terminalExitTopic(frame.terminalId), frame, TerminalExitFrameSchema);
  });

  // P0-11 孤儿收口：在途 warmup 的哑 PTY 不在池中——close() 等待其 dispose 收口
  let warmupInFlight: Promise<void> | null = null;

  let closed = false;
  return {
    db,
    eventBus,
    terminalPool,
    logSink,
    catalog,
    agents,
    diff,
    warmupConptyInBackground(): void {
      if (warmupInFlight !== null) {
        return; // 幂等：在途预热不重复发起
      }
      // 非 Windows 直接置位；失败不置位、不抛（见 warmup.ts）——绝不打断 daemon
      warmupInFlight = (options.warmup ?? warmupConpty)().catch(() => undefined);
    },
    createAgentEventContext,
    replayProcessLogs,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      // agent 进程先收口（cancel("shutdown") + adapter.dispose）：泵的终态事件随处置入 sink
      await agents.dispose();
      // 让泵的收尾微任务先走一拍（cancel 与 emit 终态存在微任务差；setImmediate 让一轮跑完）
      await new Promise<void>((resolve) => setImmediate(resolve));
      // 在途 ConPTY 预热等待收口（哑 PTY dispose 含 SIGKILL 升级 + 5s settle，有界）
      if (warmupInFlight !== null) {
        await warmupInFlight;
      }
      await terminalPool.disposeAll(); // 退出帧经 eventBus 正常出站（连接仍在则可达）
      logSink.dispose(); // 余量落库
      closeDatabase(db);
    },
  };
}

/** env 值清洗：空串/空白视为未设置（undefined → adapter 默认解析）；原值只透传不落库 */
function readEnvCliPath(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
