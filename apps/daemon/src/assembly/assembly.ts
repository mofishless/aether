// daemon 组装根（P0-10，SYSTEM_DESIGN §6.4/§4.4/§7）：把 storage / 适配器注册表 /
// 终端池 / 事件总线 / 执行日志管线装配为可注入的整体。组装根保持薄：
// 全部依赖经 options 注入可替换（测试换内存库/假件），本模块只做接线，不写业务。
import type { DatabaseSync } from "node:sqlite";
import {
  ExecutionLogReplayService,
  ExecutionLogSink,
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
  ExecutionProcessLogRepository,
  ExecutionProcessRepository,
  closeDatabase,
  openStorage,
} from "@aether/storage";
import { createTerminalPool, warmupConpty, type TerminalPool } from "@aether/terminal";
import { createEventBus, type EventBus } from "../events/event-bus.js";

/** 默认 sink 异常上报：stderr 中文日志（token 等敏感值绝不出现在事件载荷中） */
function defaultSinkErrorLog(error: ExecutionLogSinkError): void {
  process.stderr.write(`[aether-daemon] 执行日志管线异常：${JSON.stringify(error)}\n`);
}

export interface DaemonAssemblyOptions {
  /**
   * SQLite 数据库路径；默认 ':memory:'。
   * TODO(P0-11)：默认路径策略接 desktop userData（launcher 注入 env），
   * 现以 AETHER_DAEMON_DB_PATH 为临时注入缝（见 index.ts）。
   */
  readonly dbPath?: string;
  /** 终端池注入缝（测试假件）；默认真 TerminalPool */
  readonly terminalPool?: TerminalPool;
  /** 事件总线注入缝；默认新建 */
  readonly eventBus?: EventBus;
  /** 执行日志 sink 异常回调；默认 stderr 中文日志 */
  readonly onSinkError?: (error: ExecutionLogSinkError) => void;
}

export interface AgentEventContextInput {
  /** = execution_process.id（外键链由 spawn 流程先建行，P0-11 agents.spawn） */
  readonly processId: string;
  /** agent 的 cwd */
  readonly worktreePath: string;
  /** 注入 env（值永不落库） */
  readonly env?: Record<string, string>;
  /** 自定义 provider resume 时重水化历史事件 */
  readonly loadEvents: (sessionId: string) => Promise<ProviderEvent[]>;
}

export interface DaemonAssembly {
  /** 原始连接（测试建外键链用；P0-11 agents.spawn 服务落地后收敛为内部细节） */
  readonly db: DatabaseSync;
  readonly eventBus: EventBus;
  readonly terminalPool: TerminalPool;
  readonly logSink: ExecutionLogSink;
  /** adapter 事件泵接线（P0-09 收口）：emit → 执行日志管线入库 */
  createAgentEventContext(input: AgentEventContextInput): AdapterContext;
  /** 重放进程日志；sessionId 归属自动接线（execution_process 行 → sessionIdOverride） */
  replayProcessLogs(processId: string): ReplayResult;
  /**
   * ConPTY 后台预热（调研 06 §9.1：摊平 Windows 首建秒级冷启动）。
   * 注意：node-pty 的 ConPTY spawn 含同步段，会阻塞事件循环——入口必须在
   * listening 行写出之后再调（否则吃掉 supervisor 的启动超时预算，P0-10 实测
   * 全量并行下 --hang-silent 用例 28 次重启）。尽力而为：失败不置位、不抛错。
   */
  warmupConptyInBackground(): void;
  /** 优雅关闭：终端全释放（退出帧正常出站）→ sink 余量落库 → 数据库关闭；幂等 */
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
  const claudeAdapter = createAdapter({
    kind: "claude-sdk",
    providerConfigId: "builtin-claude-sdk",
    displayName: "Claude",
    config: {},
  });

  const logs = new ExecutionProcessLogRepository(db);
  const processes = new ExecutionProcessRepository(db);
  const logSink = new ExecutionLogSink({
    store: logs,
    onError: options.onSinkError ?? defaultSinkErrorLog,
  });
  const replay = new ExecutionLogReplayService(logs);

  // 终端输出/退出 → 事件总线（payload 经 zod 校验后出站，见 event-bus.ts）
  terminalPool.onOutput((frame) => {
    eventBus.publish(terminalOutputTopic(frame.terminalId), frame, TerminalOutputFrameSchema);
  });
  terminalPool.onExit((frame) => {
    eventBus.publish(terminalExitTopic(frame.terminalId), frame, TerminalExitFrameSchema);
  });

  let closed = false;
  return {
    db,
    eventBus,
    terminalPool,
    logSink,
    warmupConptyInBackground(): void {
      // 非 Windows 直接置位；失败不置位、不抛（见 warmup.ts）——绝不打断 daemon
      void warmupConpty();
    },
    createAgentEventContext(input: AgentEventContextInput): AdapterContext {
      const { processId, worktreePath, loadEvents } = input;
      const env = input.env ?? {};
      return {
        worktreePath,
        env,
        loadEvents,
        // 定案（P0-10 deviations）：adapter 未暴露 SDK 原始行流（spawn 桥在
        // adapter 内部、原始行无出站缝，且本卡不得改 adapters/claude/src）——
        // 以归一化 ProviderEvent 的 JSON 行入执行日志（rawJson = 归一化事件）；
        // SDK 原始行流订阅缝 P0-11 处置。emit 前过 ProviderEventSchema：
        // 入库行保证可被事件面信任（wire 边界 fail-closed 同口径）。
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
    },
    replayProcessLogs(processId: string): ReplayResult {
      const row = processes.findById(processId);
      if (row === null) {
        throw new Error(`未知进程：execution_process 行不存在（processId=${processId}）`);
      }
      // 归属修正用 execution_process 行的 sessionId（P0-09 注释定案形态）。
      // P0-10 只有 claude-sdk 一个内置 kind、process 行未记录 kind——
      // P0-11 随 agents.spawn 落库补 kind 归属。
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
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await terminalPool.disposeAll(); // 退出帧经 eventBus 正常出站（连接仍在则可达）
      logSink.dispose(); // 余量落库
      closeDatabase(db);
    },
  };
}
