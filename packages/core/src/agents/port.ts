import type {
  AutonomyLevel,
  PermissionDecision,
  ProviderEvent,
  ProviderKind,
  Session,
} from "@aether/contracts";

// ===== AgentAdapter 端口（SYSTEM_DESIGN §6.2 接口唯一权威；定义在 core，adapters 实现）=====
// 枚举与事件类型唯一来源 = @aether/contracts，本包禁止重复定义；
// 下面第一组 export type 仅做转发，让 adapter 作者从 @aether/core 一站取用。

export type {
  AgentStatus,
  AutonomyLevel,
  PermissionDecision,
  ProviderKind,
} from "@aether/contracts";

export interface AdapterCapabilities {
  /** 仅部分 CLI 真支持（见调研 06 §9.2） */
  canResume: boolean;
  /** --resume-session-at 级精度（见调研 05.C） */
  followUpAtMessage: boolean;
  /** 各 CLI 自有的 bypass/权限旗标（见调研 02.g） */
  permissionFlags: boolean;
  /** L1/L2=true；tui 预留 false（终端流解析，P2+） */
  structuredEvents: boolean;
  /** custom 用：'anthropic' | 'openai-chat' | 'openai-responses' */
  protocols: readonly string[];
}

/**
 * 取消原因：双向取消契约（用户取消与进程退出互为因果，VK SpawnedChild，见调研 05.C #2）。
 * core 定案：三个既定字面量 + 开放扩展（未来 adapter 可自报原因）；`(string & {})` 保留字面量提示，
 * 不塌缩为裸 string。
 */
export type CancelReason = "user_cancelled" | "process_exit" | "shutdown" | (string & {});

/** 环境探测结果（core 定案，§6.2 discover 注释：缺失则返回安装指引，不静默失败，见调研 02.a）。 */
export interface DiscoverResult {
  /** CLI 在 PATH / 端点可达 */
  available: boolean;
  /** 探测到的版本（CLI --version / 端点自报）；未知时可缺省 */
  version?: string;
  /** available=false 时必带：安装/配置指引 */
  installHint?: string;
}

/**
 * 新会话 spawn 入参（core 定案：§6.2 未展开，最小合理形状）。
 * workspacePath 与注入 env 不在此重复——它们是每次 spawn 的执行环境，由 AdapterContext 携带
 * （ctx.worktreePath / ctx.env），单一来源避免双入口漂移。
 */
export interface SpawnInput {
  /** session 行 id（持久预留先行：core 先建 session/workspace 行再 spawn，§6.2 spawn 注释） */
  readonly sessionId: string;
  /** 首轮 prompt（RPC agents.spawn 的 prompt） */
  readonly message: string;
  /** 权限模式映射：read_only→plan / workspace_write→acceptEdits / auto→auto（§6.2） */
  readonly autonomy: AutonomyLevel;
  /** agent_profile.model 覆盖；缺省/null = 用 provider 默认模型 */
  readonly model?: string | null;
}

export interface AgentAdapter {
  readonly kind: ProviderKind;
  readonly capabilities: AdapterCapabilities;
  /** 环境探测：CLI 在 PATH？端点可达？缺失则返回安装指引，不静默失败（见调研 02.a） */
  discover(): Promise<DiscoverResult>;
  /** 新会话：spawn agent 进程（core 先建 session/workspace 行，持久预留先行） */
  spawn(input: SpawnInput, ctx: AdapterContext): Promise<AgentProcess>;
  /** 同会话追问：走 --resume <externalSessionId>（见调研 05.C） */
  spawnFollowUp(proc: AgentProcess, input: { message: string }, ctx: AdapterContext): Promise<void>;
  /** 断线/重启后恢复；canResume=false 时 UI 明示只能新会话 */
  resume(session: SessionRecord, ctx: AdapterContext): Promise<AgentProcess>;
  /** 双向取消契约：用户取消与进程退出互为因果（VK SpawnedChild，见调研 05.C #2） */
  cancel(proc: AgentProcess, reason: CancelReason): Promise<void>;
  /** 权限应答：对 waiting 中的 permission_request 批准/拒绝，解除 waiting 状态（RPC：agents.permission.respond） */
  resolvePermission(
    processId: string,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void>;
  /** 原始日志行数组 → 归一化事件数组（旁路转换器，vendor 格式变化只改一处，见调研 05.C #5） */
  normalizeLogs(raw: unknown[]): ProviderEvent[];
  dispose(): Promise<void>;
}

export interface AgentProcess {
  /** = execution_process.id */
  readonly processId: string;
  readonly pid: number | null;
  /** §6.2 原文为 readonly cancel(reason)——TS 不允许方法签名加 readonly，此处为等价改写（只读函数属性） */
  readonly cancel: (reason: CancelReason) => Promise<void>;
  /** 退出证明（见调研 05.A） */
  readonly exited: Promise<{ code: number | null; signal?: string }>;
}

export interface AdapterContext {
  /** → 状态机 + 落库 */
  emit(ev: ProviderEvent): void;
  /** agent 的 cwd */
  worktreePath: string;
  /** 注入的 env 变量名→值；值永不落库 */
  env: Record<string, string>;
  /** 自定义 provider resume 时重水化历史事件 */
  loadEvents(sessionId: string): Promise<ProviderEvent[]>;
}

/**
 * §6.2 resume 形参名定案 = 会话行记录；实体唯一来源 @aether/contracts Session，此处仅别名转发。
 */
export type SessionRecord = Session;

/**
 * 工厂入参：daemon 从 provider_config（+必要的运行期解析）装配（core 定案：§6.4 未展开，最小合理形状）。
 * kind=custom 时 config 为 §6.3 schema 经 zod 校验后的解析结果（adapter 侧自行 narrow）；内置 kind 为 CLI 选项对象。
 */
export interface ResolvedProviderConfig {
  readonly kind: ProviderKind;
  /** provider_config 行 id（factory 无需时可忽略） */
  readonly providerConfigId: string;
  /** 展示名（UI/日志） */
  readonly displayName: string;
  /** 已解析配置；不透传密钥本体（只可有 env 变量名，§6.3 安全规则） */
  readonly config: Readonly<Record<string, unknown>>;
}
