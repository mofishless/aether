// agents 服务（P0-11，SYSTEM_DESIGN §6.2 spawn 编排 + §8.1 状态机驱动）：
// taskId 校验 → worktree 缺省创建（持久预留先行）→ session 行 → execution_process 行
// （commandJson 记录 {"kind":...} 归属，P0-10 遗留收口）→ adapter.spawn → 事件泵一路三发。
//
// 事件泵接线（emit 三发定案）：
// ① inner ctx.emit → 执行日志管线入库（P0-10 行为保持）；
// ② eventBus.publish(session.<id>.events, ev)（归一化事件流 topic）；
// ③ applySessionEvent fold——applied 且状态变化时：session 行 touchStatus +
//    session.<id>.state / agent.status / task.updated 投影发布 + 进程行终局。
//
// 依赖全部经 deps 注入（组装根保持薄；测试换假件）。
import {
  AgentStatusPayloadSchema,
  ProviderEventSchema,
  STATIC_TOPIC,
  SessionStatePayloadSchema,
  TaskUpdatedPayloadSchema,
  WorkspaceStatusPayloadSchema,
  sessionEventsTopic,
  sessionStateTopic,
} from "@aether/contracts";
import type {
  AgentProfile,
  AgentStatus,
  AutonomyLevel,
  PermissionDecision,
  ProviderConfig,
  ProviderEvent,
  ProviderKind,
  Session,
  SessionHandle,
  Task,
  Workspace,
} from "@aether/contracts";
import type {
  AdapterContext,
  AgentAdapter,
  ExecutionLogSink,
  ReplayResult,
  ResolvedProviderConfig,
  WorktreeLifecycleService,
} from "@aether/core";
import {
  INITIAL_AGENT_STATUS,
  WorktreeError,
  applySessionEvent,
  hasAdapter,
  nowIso,
} from "@aether/core";
import type {
  AgentProfileRepository,
  ExecutionProcessRepository,
  ProjectRepository,
  SessionRepository,
  TaskRepository,
  WorkspaceRepository,
} from "@aether/storage";
import { findDefaultGlobalProfile } from "@aether/storage";
import type { ProviderConfigRepository } from "@aether/storage";
import type { EventBus } from "../events/event-bus.js";
import {
  internalError as internal,
  errorMessage,
  invalidParamsError as invalidParams,
} from "../service-error.js";
import { ProcessRegistry } from "./process-registry.js";
import type { PumpTarget, ProcessRegistryEntry, StatusWatch } from "./process-registry.js";

/** spawn 入参（contracts agents.spawn 签名的服务面形态；可选字段带 | undefined 对齐 zod 推断） */
export interface SpawnAgentInput {
  readonly taskId: string;
  readonly workspaceId?: string | undefined;
  /** 缺省 = 种子的全局默认 agent_profile（P0-11 渲染线定案：UI 无 profile 选择器） */
  readonly agentProfileId?: string | undefined;
  /**
   * 显式 provider 路由（P1-01 评审 F2 接线）：优先级最高（env 覆盖缝 > 配置行 kind）。
   * 必须已在适配器注册表内（值域通过 ≠ 已注册，如 acp/tui 为 P2+ 占位）。
   */
  readonly providerKind?: ProviderKind | undefined;
  readonly prompt: string;
  readonly autonomy?: AutonomyLevel | undefined;
}

export interface AgentServiceDeps {
  readonly eventBus: EventBus;
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly workspaces: WorkspaceRepository;
  readonly profiles: AgentProfileRepository;
  readonly providerConfigs: ProviderConfigRepository;
  readonly sessions: SessionRepository;
  readonly processes: ExecutionProcessRepository;
  readonly worktrees: WorktreeLifecycleService;
  /** P0-10 组装根的事件上下文工厂（emit → 执行日志管线入库） */
  readonly createEventContext: (input: {
    processId: string;
    worktreePath: string;
    env?: Record<string, string>;
    loadEvents: (sessionId: string) => Promise<ProviderEvent[]>;
  }) => AdapterContext;
  /** P0-10 组装根的进程日志重放（sessions.listEvents / loadEvents 用） */
  readonly replayProcessLogs: (processId: string) => ReplayResult;
  /** 执行日志 sink（listEvents 前冲刷余量，保证读口径新鲜） */
  readonly logSink: ExecutionLogSink;
  /** 适配器工厂（默认走 core 注册表；测试假件注入缝） */
  readonly createAdapterInstance: (cfg: ResolvedProviderConfig) => AgentAdapter;
  /** provider config 的 cliPath 覆盖（env AETHER_AGENT_CLI_PATH；生产 undefined 走 adapter 默认解析） */
  readonly cliPathOverride?: string;
  /**
   * provider kind 覆盖（P1-01 注入缝，env AETHER_AGENT_PROVIDER_KIND）：覆盖 provider
   * config 行的 kind 路由。优先级低于 agents.spawn 显式 providerKind 入参（P1-01 评审
   * F2 接线：显式入参 > env 覆盖 > 配置行 kind）。覆盖后的 kind 如实记入
   * commandJson（重放归属事实），不改 provider_config 行。daemon 集成测试仍在用。
   */
  readonly providerKindOverride?: ProviderKind;
  /** 诊断输出口（默认 stderr；值永不携带 env/token 等敏感信息） */
  readonly log?: (message: string) => void;
}

export class AgentService {
  private readonly registry = new ProcessRegistry();

  constructor(private readonly deps: AgentServiceDeps) {}

  get registeredSessionCount(): number {
    return this.registry.size;
  }

  /** 新会话：§6.2 spawn 编排全链路（见文件头注释）。 */
  async spawn(input: SpawnAgentInput): Promise<SessionHandle> {
    const taskId = input.taskId;
    const task = this.deps.tasks.findById(taskId);
    if (task === null) {
      throw invalidParams(`未知任务：taskId=${taskId}`);
    }
    const profile =
      input.agentProfileId !== undefined
        ? this.requireProfile(input.agentProfileId)
        : this.resolveDefaultProfile();
    const providerConfig = this.deps.providerConfigs.findById(profile.providerConfigId);
    if (providerConfig === null) {
      throw internal(`provider 配置行缺失：providerConfigId=${profile.providerConfigId}`);
    }
    // P1-01 provider 路由（评审 F2 接线）：显式入参 providerKind > env 覆盖缝
    // （AETHER_AGENT_PROVIDER_KIND）> provider 配置行 kind；commandJson/注册表记录
    // 实际路由 kind（重放归属事实），不改 provider_config 行
    const resolvedKind =
      input.providerKind ?? this.deps.providerKindOverride ?? providerConfig.kind;
    // 显式入参必须已在适配器注册表内（值域由 RPC schema 先拒；注册表成员资格在此拒
    // ——acp/tui 值域合法但 P2+ 无实现），否则 invalidParams 且不建任何行
    if (input.providerKind !== undefined && !hasAdapter(input.providerKind)) {
      throw invalidParams(
        `未注册的 provider kind：${input.providerKind}（适配器注册表内不存在；acp/tui 为 P2+ 占位）`,
      );
    }

    const workspace =
      input.workspaceId === undefined
        ? await this.createWorkspaceForTask(task)
        : this.requireWorkspace(input.workspaceId);
    const session = this.deps.sessions.create({
      workspaceId: workspace.id,
      agentProfileId: profile.id,
      status: INITIAL_AGENT_STATUS,
    });
    const sessionId = session.id;
    // 初始状态点先行发布（spawn 失败也有 starting → error 轨迹可追）
    this.publishAgentStatus(sessionId, workspace.id, taskId, INITIAL_AGENT_STATUS);

    const processRow = this.deps.processes.create({
      sessionId,
      runReason: "coding_agent",
      // P0-10 遗留收口：commandJson 记录 kind 归属（P1-01 起重放按 kind 分发重放器）
      commandJson: JSON.stringify({ kind: resolvedKind }),
      status: "running",
    });
    const watch: StatusWatch = { status: INITIAL_AGENT_STATUS };
    const target: PumpTarget = {
      sessionId,
      workspaceId: workspace.id,
      taskId,
      processId: processRow.id,
      watch,
      pendingPermissionRequests: new Set<string>(),
    };
    const ctx = this.buildEventContext(target, workspace.worktreePath);
    const adapter = this.deps.createAdapterInstance(
      this.resolveProviderConfig(providerConfig, this.deps.cliPathOverride, resolvedKind),
    );
    let proc;
    try {
      proc = await adapter.spawn(
        {
          sessionId,
          message: input.prompt,
          // 缺省只读（fail-closed：autonomy 未给时不放宽权限）
          autonomy: input.autonomy ?? "read_only",
          model: profile.model,
        },
        ctx,
      );
    } catch (cause) {
      this.finalizeProcessRow(processRow.id, { status: "failed", endedAt: nowIso() });
      // 泵已发 error 事件（adapter 排序契约）驱动状态机 → error；防御：泵未发时强制终态
      this.forceTerminalIfActive(target, "error");
      throw internal("agent 进程启动失败", cause);
    }
    this.deps.processes.update(processRow.id, { pid: proc.pid });
    const entry: ProcessRegistryEntry = {
      ...target,
      proc,
      adapter,
      ctx,
      providerConfigId: providerConfig.id,
      providerKind: resolvedKind,
      cancelling: false,
      exitProofSettled: false,
    };
    this.registry.register(sessionId, entry);
    this.attachExitWatch(sessionId, entry, processRow.id);
    this.publishTaskUpdated(taskId);
    return { sessionId, workspaceId: workspace.id, status: watch.status };
  }

  /** 同会话追问：新 execution_process 行（follow_up）+ 新事件上下文（日志归属换行）。 */
  async followUp(input: { sessionId: string; message: string }): Promise<SessionHandle> {
    const sessionId = input.sessionId;
    const entry = this.requireEntry(sessionId);
    // 审批等待期追问前置拒绝（P1-01 评审 F4）：waiting 态下活动 turn 挂在审批上，
    // adapter 侧 turn/start 会空等 turn/completed 超时（≤5s）后抛错——立即拒绝并给
    // 可行动文案，且不建 execution_process 行（无实质执行发生）
    if (entry.watch.status === "waiting") {
      throw invalidParams(
        "会话正等待权限应答（waiting）：请先应答权限请求再追问（agents.permission.respond）",
      );
    }
    const processRow = this.deps.processes.create({
      sessionId,
      runReason: "follow_up",
      commandJson: JSON.stringify({ kind: entry.providerKind }),
      status: "running",
    });
    const target: PumpTarget = {
      sessionId,
      workspaceId: entry.workspaceId,
      taskId: entry.taskId,
      processId: processRow.id,
      watch: entry.watch,
      // 待决权限集合跨轮共享：首轮阻塞的请求，follow-up 轮应答仍可反查命中
      pendingPermissionRequests: entry.pendingPermissionRequests,
    };
    const ctx = this.buildEventContext(
      target,
      this.requireWorkspace(entry.workspaceId).worktreePath,
    );
    try {
      await entry.adapter.spawnFollowUp(entry.proc, { message: input.message }, ctx);
    } catch (cause) {
      this.finalizeProcessRow(processRow.id, { status: "failed", endedAt: nowIso() });
      this.forceTerminalIfActive(target, "error");
      throw internal("追问启动失败", cause);
    }
    entry.processId = processRow.id;
    entry.ctx = ctx;
    return { sessionId, workspaceId: entry.workspaceId, status: entry.watch.status };
  }

  /** 用户取消：adapter.cancel(proc, "user_cancelled")；退出证明到达后注册表清理。 */
  async cancel(input: { sessionId: string }): Promise<void> {
    const sessionId = input.sessionId;
    const entry = this.requireEntry(sessionId);
    entry.cancelling = true;
    await entry.adapter.cancel(entry.proc, "user_cancelled");
    if (entry.exitProofSettled) {
      // 进程早已自然退出（证明 promise 已 settle 不再来）：就地清理注册表；
      // 进程行维持自然终局，不改判 killed
      this.registry.remove(sessionId);
    }
  }

  /**
   * 权限应答（§6.2 resolvePermission 的服务面）：processId 缺省时按 requestId 反查
   * （permission_request 事件不携带 processId，渲染层无从得知——P0-11 契约定案）。
   */
  async respondPermission(input: {
    processId?: string | undefined;
    requestId: string;
    decision: PermissionDecision;
  }): Promise<void> {
    const entry =
      input.processId !== undefined
        ? this.registry.findByProcessId(input.processId)
        : this.registry.findByRequestId(input.requestId);
    if (entry === null) {
      const scope =
        input.processId !== undefined
          ? `processId=${input.processId}，requestId=${input.requestId}`
          : `requestId=${input.requestId}`;
      throw invalidParams(`权限应答无对应运行会话（${scope}；未运行、已应答或 daemon 已重启）`);
    }
    try {
      await entry.adapter.resolvePermission(entry.proc.processId, input.requestId, input.decision);
    } catch (cause) {
      throw invalidParams(`权限应答未送达：${errorMessage(cause)}`);
    }
    entry.pendingPermissionRequests.delete(input.requestId);
  }

  /** 会话历史归一化事件（sessions.listEvents）：进程行按时间序 → 日志重放合并。 */
  listSessionEvents(sessionId: string): ProviderEvent[] {
    const session = this.deps.sessions.findById(sessionId);
    if (session === null) {
      throw invalidParams(`未知会话：sessionId=${sessionId}`);
    }
    this.deps.logSink.flushNow();
    const rows = this.deps.processes
      .findAll()
      .map((row, index) => ({ row, index }))
      .filter((item) => item.row.sessionId === sessionId)
      .sort((a, b) => a.row.startedAt.localeCompare(b.row.startedAt) || a.index - b.index);
    const events: ProviderEvent[] = [];
    for (const item of rows) {
      events.push(...this.deps.replayProcessLogs(item.row.id).events);
    }
    return events;
  }

  /** 任务名下全部会话（sessions.list）：workspace.taskId 联表，行序（创建序）返回。 */
  listSessionsByTask(taskId: string): { items: Session[] } {
    const task = this.deps.tasks.findById(taskId);
    if (task === null) {
      throw invalidParams(`未知任务：taskId=${taskId}`);
    }
    const workspaceIds = new Set(
      this.deps.workspaces
        .findAll()
        .filter((workspace) => workspace.taskId === taskId)
        .map((workspace) => workspace.id),
    );
    const items = this.deps.sessions
      .findAll()
      .filter((session) => workspaceIds.has(session.workspaceId));
    return { items };
  }

  /** 优雅关闭收口（assembly.close 注入）：全量取消 + 适配器释放。 */
  async dispose(): Promise<void> {
    const entries = this.registry.entries();
    await Promise.allSettled(entries.map((entry) => entry.adapter.cancel(entry.proc, "shutdown")));
    await Promise.allSettled(entries.map((entry) => entry.adapter.dispose()));
  }

  // ----- 内部：编排部件 -----

  /** 显式 agentProfileId 的校验读取（不存在 = 参数引用错误）。 */
  private requireProfile(agentProfileId: string): AgentProfile {
    const profile = this.deps.profiles.findById(agentProfileId);
    if (profile === null) {
      throw invalidParams(`未知 agent 配置档：agentProfileId=${agentProfileId}`);
    }
    return profile;
  }

  /** 缺省 agentProfileId 的解析：种子的全局默认行（findDefaultGlobalProfile 同一判据）。 */
  private resolveDefaultProfile(): AgentProfile {
    const profile = findDefaultGlobalProfile(this.deps.profiles);
    if (profile === null) {
      throw internal("默认 agent 配置档缺失（库未正确初始化或默认行被删且种子未补齐）");
    }
    return profile;
  }

  /** workspaceId 给定时的校验读取（不存在 = 参数引用错误）。 */
  private requireWorkspace(workspaceId: string): Workspace {
    const workspace = this.deps.workspaces.findById(workspaceId);
    if (workspace === null) {
      throw invalidParams(`未知工作区：workspaceId=${workspaceId}`);
    }
    return workspace;
  }

  /** 缺省 worktree：项目 rootPath 下建 worktree+分支（持久预留先行），成功后发 workspace.status。 */
  private async createWorkspaceForTask(task: Task): Promise<Workspace> {
    const projectId = task.projectId;
    const project = this.deps.projects.findById(projectId);
    if (project === null) {
      throw internal(`项目行缺失：projectId=${projectId}`);
    }
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const name = workspaceNameFor(task.id, attempt);
      try {
        const result = await this.deps.worktrees.createForTask(project.rootPath, {
          projectId,
          name,
          taskId: task.id,
        });
        this.deps.eventBus.publish(
          STATIC_TOPIC.workspaceStatus,
          { workspaceId: result.workspace.id, projectId, status: result.workspace.status },
          WorkspaceStatusPayloadSchema,
        );
        return result.workspace;
      } catch (error) {
        lastError = error;
        // 仅同名预留撞车才值得换名重试（随机后缀下概率极低）；其余错误直接抛
        if (error instanceof WorktreeError && error.operation === "reserve") {
          continue;
        }
        throw internal("工作区创建失败", error);
      }
    }
    throw internal("工作区创建失败（重试用尽）", lastError);
  }

  /**
   * 组装 ResolvedProviderConfig：configJson 解析合并 + cliPath 覆盖 + kind 覆盖
   * （env 值不落库不进事件；kind 覆盖仅改路由，commandJson 记录的是实际路由值）。
   */
  private resolveProviderConfig(
    providerConfig: ProviderConfig,
    cliPathOverride: string | undefined,
    resolvedKind: ProviderKind,
  ): ResolvedProviderConfig {
    const config = readConfigObject(providerConfig.configJson);
    if (typeof cliPathOverride === "string" && cliPathOverride.length > 0) {
      config["cliPath"] = cliPathOverride;
    }
    return {
      kind: resolvedKind,
      providerConfigId: providerConfig.id,
      displayName: providerConfig.displayName,
      config,
    };
  }

  /** 事件上下文（emit 一路三发）：inner ctx 落库 + 总线发布 + 状态机 fold。 */
  private buildEventContext(target: PumpTarget, worktreePath: string): AdapterContext {
    const sessionId = target.sessionId;
    const inner = this.deps.createEventContext({
      processId: target.processId,
      worktreePath,
      env: {},
      loadEvents: (targetSessionId: string) =>
        Promise.resolve(this.listSessionEvents(targetSessionId)),
    });
    return {
      ...inner,
      emit: (ev: ProviderEvent): void => {
        const parsed = ProviderEventSchema.safeParse(ev);
        if (!parsed.success) {
          this.log(`拒绝非法 ProviderEvent（session=${sessionId}）：${parsed.error.message}`);
          return;
        }
        // 待决权限登记：permission.respond 缺省 processId 时按 requestId 反查的依据
        if (ev.type === "permission_request") {
          target.pendingPermissionRequests.add(ev.requestId);
        }
        inner.emit(ev); // ① 执行日志管线（P0-10 行为保持）
        this.deps.eventBus.publish(sessionEventsTopic(sessionId), ev, ProviderEventSchema); // ②
        try {
          this.applyTransition(target, ev); // ③
        } catch (cause) {
          // 投影/落库失败不杀死事件泵（adapter 泵契约：emit 不因基础设施异常中断）；
          // stderr 上报（对齐 eventBus onError 口径——不静默吞）
          this.log(
            `状态机接线异常（session=${sessionId}，event=${ev.type}）：${errorMessage(cause)}`,
          );
        }
      },
    };
  }

  /** 状态机 fold：applied 且状态变化 → session 行 + 三个投影 topic + 进程行终局。 */
  private applyTransition(target: PumpTarget, ev: ProviderEvent): void {
    const previous = target.watch.status;
    const result = applySessionEvent(previous, ev);
    if (result.transition !== "applied" || result.status === previous) {
      return; // rejected / 幂等重报：不重复发布投影
    }
    target.watch.status = result.status;
    const sessionId = target.sessionId;
    this.deps.sessions.touchStatus(sessionId, result.status);
    this.deps.eventBus.publish(
      sessionStateTopic(sessionId),
      { sessionId, previous, status: result.status },
      SessionStatePayloadSchema,
    );
    this.publishAgentStatus(sessionId, target.workspaceId, target.taskId, result.status);
    this.publishTaskUpdated(target.taskId);
    if (result.status === "stopped" || result.status === "error") {
      // 终态清待决权限（渲染侧 §8.1 折叠同口径）：会话已终局，旧请求不再可应答
      target.pendingPermissionRequests.clear();
      // 进程行终局保守写（running 守卫）：follow-up 轮无独立退出证明，以此收口
      this.finalizeProcessRow(target.processId, {
        status: result.status === "stopped" ? "exited" : "failed",
        endedAt: nowIso(),
      });
    }
  }

  /** 泵未驱动状态机时的防御终态（spawn/followUp 失败路径）。 */
  private forceTerminalIfActive(target: PumpTarget, status: AgentStatus): void {
    const previous = target.watch.status;
    if (previous === "stopped" || previous === "error") {
      return;
    }
    target.watch.status = status;
    target.pendingPermissionRequests.clear(); // 终态清待决权限（同 applyTransition 口径）
    const sessionId = target.sessionId;
    this.deps.sessions.touchStatus(sessionId, status);
    this.deps.eventBus.publish(
      sessionStateTopic(sessionId),
      { sessionId, previous, status },
      SessionStatePayloadSchema,
    );
    this.publishAgentStatus(sessionId, target.workspaceId, target.taskId, status);
  }

  /** 退出证明看护：进程行终局（证明口径优先）+ 取消清理。 */
  private attachExitWatch(sessionId: string, entry: ProcessRegistryEntry, processId: string): void {
    void entry.proc.exited
      .then((exit) => {
        entry.exitProofSettled = true;
        const cancelled = entry.cancelling;
        const status =
          cancelled || exit.code === null ? "killed" : exit.code === 0 ? "exited" : "failed";
        this.overwriteProcessRow(processId, {
          status,
          exitCode: exit.code,
          endedAt: nowIso(),
        });
        if (cancelled) {
          this.registry.remove(sessionId);
        }
      })
      .catch(() => undefined); // 证明 promise 不应拒绝；防御 unhandled
  }

  /** 进程行终局（守卫写）：仅 running 行收口（证明到达后由 overwrite 覆盖为准）。 */
  private finalizeProcessRow(
    processId: string,
    patch: { status: "exited" | "failed" | "killed"; endedAt: string },
  ): void {
    const row = this.deps.processes.findById(processId);
    if (row !== null && row.status === "running") {
      this.deps.processes.update(processId, patch);
    }
  }

  /** 进程行终局（覆盖写）：退出证明携带 exitCode，口径最准（迟到亦覆盖保守写）。 */
  private overwriteProcessRow(
    processId: string,
    patch: {
      status: "exited" | "failed" | "killed";
      exitCode: number | null;
      endedAt: string;
    },
  ): void {
    try {
      this.deps.processes.update(processId, patch);
    } catch (cause) {
      this.log(`进程行终局回写失败（processId=${processId}）：${errorMessage(cause)}`);
    }
  }

  private publishAgentStatus(
    sessionId: string,
    workspaceId: string,
    taskId: string,
    status: AgentStatus,
  ): void {
    this.deps.eventBus.publish(
      STATIC_TOPIC.agentStatus,
      { sessionId, workspaceId, taskId, status },
      AgentStatusPayloadSchema,
    );
  }

  private publishTaskUpdated(taskId: string): void {
    const task = this.deps.tasks.findById(taskId);
    if (task === null) {
      return; // 防御：任务行被并发删除时投影静默跳过（任务删除不走 P0-11 RPC 面）
    }
    this.deps.eventBus.publish(STATIC_TOPIC.taskUpdated, { task }, TaskUpdatedPayloadSchema);
  }

  private requireEntry(sessionId: string): ProcessRegistryEntry {
    const entry = this.registry.findBySession(sessionId);
    if (entry === null) {
      throw invalidParams(`会话未在运行（可能已取消清理或 daemon 重启）：sessionId=${sessionId}`);
    }
    return entry;
  }

  private log(message: string): void {
    (this.deps.log ?? defaultLog)(message);
  }
}

function defaultLog(message: string): void {
  process.stderr.write(`[aether-daemon] ${message}\n`);
}

/** workspace 名生成：t-<taskId 前缀 slug>-<随机后缀>（UNIQUE 撞车由重试换名兜底）。 */
function workspaceNameFor(taskId: string, attempt: number): string {
  const slug = taskId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 8);
  const suffix = `${Math.random().toString(16).slice(2, 6)}${attempt === 0 ? "" : `-${attempt}`}`;
  return `t-${slug}-${suffix}`;
}

/** provider configJson 安全解析（非法/非对象 → {}；键值只作 adapter 配置透传）。 */
function readConfigObject(configJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(configJson) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
    return {};
  } catch {
    return {};
  }
}
