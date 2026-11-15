import { z } from "zod";
import type {
  AgentStatus,
  AutonomyLevel,
  PermissionDecision,
  Project,
  Session,
  Task,
  TaskStatus,
  Workspace,
} from "./domain.js";
import type { ProviderEvent } from "./provider-event.js";

// ===== JSON-RPC 2.0 envelope（SYSTEM_DESIGN §5.1：JSON-RPC 2.0 over WebSocket）=====
// 全部 envelope schema 采用 .strict()：wire 边界 fail-closed——未知字段一律拒绝。
// 特别地，Notification 若不 strict，携带 id 的 Request 会因 zod 默认剥离未知键而
// 被误判为 Notification，故必须 strict。

export const JsonRpcVersionSchema = z.literal("2.0");

/** Response/Error 的 id：协议允许 null（无法确定请求 id 的错误响应） */
export const JsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);

/** Request 的 id：string | number，不含 null */
export const JsonRpcRequestIdSchema = z.union([z.string(), z.number()]);

/** params：按位置（数组）或按名（对象），可省略；标量/null 非法（JSON-RPC 2.0 规范） */
const JsonRpcParamsSchema = z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]);

export const JsonRpcRequestSchema = z
  .object({
    jsonrpc: JsonRpcVersionSchema,
    id: JsonRpcRequestIdSchema,
    method: z.string().min(1),
    params: JsonRpcParamsSchema.optional(),
  })
  .strict();
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export const JsonRpcNotificationSchema = z
  .object({
    jsonrpc: JsonRpcVersionSchema,
    method: z.string().min(1),
    params: JsonRpcParamsSchema.optional(),
  })
  .strict();
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;

export const JsonRpcErrorObjectSchema = z
  .object({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  })
  .strict();
export type JsonRpcErrorObject = z.infer<typeof JsonRpcErrorObjectSchema>;

export const JsonRpcSuccessResponseSchema = z
  .object({
    jsonrpc: JsonRpcVersionSchema,
    id: JsonRpcIdSchema,
    result: z.unknown(),
  })
  .strict();
export type JsonRpcSuccessResponse = z.infer<typeof JsonRpcSuccessResponseSchema>;

export const JsonRpcErrorResponseSchema = z
  .object({
    jsonrpc: JsonRpcVersionSchema,
    id: JsonRpcIdSchema,
    error: JsonRpcErrorObjectSchema,
  })
  .strict();
export type JsonRpcErrorResponse = z.infer<typeof JsonRpcErrorResponseSchema>;

export const JsonRpcResponseSchema = z.union([
  JsonRpcSuccessResponseSchema,
  JsonRpcErrorResponseSchema,
]);
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

// 注：批量请求（JSON-RPC 2.0 batch array）MVP 不使用，如需引入在 envelope 层扩展。

/** JSON-RPC 2.0 保留错误码（规范 -32700..-32603；应用错误码自 ≥ -32000 区间取用） */
export const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// ===== RPC 返回形状（P0 占位）=====
// 文档未定形的返回类型在此定义最小合理形状；已有实体（Task/Session/Project 等）
// 直接复用 domain.ts。以下形状随 P0-05（worktree/diff）、P0-07（agent）、P0-08（终端）细化。

/** projects.list 返回的元素 —— P0 占位，随 P0-11 驾驶舱 UI 需求细化 */
export interface ProjectSummary {
  id: string;
  name: string;
  rootPath: string;
  archivedAt: string | null;
}

/** agents.spawn / followUp 返回的会话句柄 —— P0 占位，随 P0-07 细化 */
export interface SessionHandle {
  sessionId: string;
  workspaceId: string;
  status: AgentStatus;
}

/** terminals.create 返回的终端句柄 —— P0 占位，随 P0-08 细化 */
export interface TerminalHandle {
  terminalId: string;
  /** PTY 子进程 pid（P0-10 daemon 组装细化：创建成功即有值） */
  pid?: number;
}

export type DiffFileStatus = "added" | "modified" | "deleted";

/** diff 单文件条目 —— P0 占位，随 P0-05 细化 */
export interface DiffFile {
  path: string;
  status: DiffFileStatus;
  /** unified diff 补丁文本 */
  patch: string;
}

/** diff.workspaceDiff 返回 —— P0 占位，随 P0-05 细化 */
export interface DiffResult {
  workspaceId: string;
  /** 对比的基准分支（默认为项目 gitDefaultBranch） */
  baseBranch: string;
  files: DiffFile[];
}

/** subscribe 的 cursor 早于保留水位时返回的全量状态快照（§5.4，T3 模式）—— P0 占位，随 P0-03 事件流细化 */
export interface StateSnapshot {
  /** 快照建立时刻的事件水位，客户端自此续传增量 */
  cursor: number;
  projects?: ProjectSummary[];
  tasks?: Task[];
  workspaces?: Workspace[];
  sessions?: Session[];
}

/** system.health 返回 —— P0 占位，随 P0-03 daemon 生命周期细化 */
export interface SystemHealth {
  ok: boolean;
}

/** system.version 返回 —— P0 占位 */
export interface SystemVersion {
  daemonVersion: string;
  protocolVersion: number;
}

// ===== RPC 方法面（AetherRpc）=====
// §5.3 的 5 个签名示例原文落地 + P0 最小集。本接口为纯类型（编译期单一来源），
// envelope 运行时校验用上方 zod schema；方法级 params 的运行时校验 schema 由
// daemon RPC 层（P0-03）按需在本包补齐。
export interface AetherRpc {
  // --- projects（§5.2：项目 CRUD / 归档 / 设置）---
  /** §5.3 示例原文 */
  "projects.list"(): { items: ProjectSummary[] };
  "projects.create"(input: { name: string; rootPath: string; gitDefaultBranch?: string }): Project;
  "projects.archive"(input: { projectId: string }): Project;

  // --- tasks（§5.2：backlog 票）---
  /** §5.3 示例原文 */
  "tasks.create"(input: {
    projectId: string;
    title: string;
    description?: string;
    parentId?: string;
  }): Task;
  "tasks.move"(input: { taskId: string; status: TaskStatus; position?: number }): Task;
  /** P0-11 驾驶舱：项目任务列表（左栏 TaskList 数据源） */
  "tasks.list"(input: { projectId: string }): { items: Task[] };
  // P1+ 占位：tasks.assign / tasks.comment（P1-02 backlog 看板）

  // --- agents（§5.2：会话与 provider）---
  /** §5.3 示例原文 */
  "agents.spawn"(input: {
    taskId: string;
    /** 缺省则按持久预留先行新建 worktree */
    workspaceId?: string;
    /**
     * 缺省 = daemon 取种子的全局默认 agent_profile（P0-11 渲染线定案：
     * UI 无 profile 选择器，profile id 亦非固定值不可硬编码）。
     */
    agentProfileId?: string;
    prompt: string;
    /** 'read_only' | 'workspace_write' | 'auto'（映射见 §6.2） */
    autonomy?: AutonomyLevel;
  }): SessionHandle;
  "agents.followUp"(input: { sessionId: string; message: string }): SessionHandle;
  "agents.cancel"(input: { sessionId: string }): void;
  /**
   * 权限应答（§6.2 resolvePermission(processId, requestId, decision) 的 RPC 面）。
   * processId 可选（P0-11 渲染线定案）：permission_request 事件不携带 processId、
   * 渲染层无从得知；缺省时 daemon 按 requestId 反查当前阻塞的进程。
   */
  "agents.permission.respond"(input: {
    processId?: string;
    requestId: string;
    decision: PermissionDecision;
  }): void;
  // P3+ 占位：agents.resume（P3-01 布局恢复）

  // --- sessions（P0-11 驾驶舱：活动视图历史事件拉取）---
  /** 会话历史归一化事件（daemon 走执行日志重放，按进程时间序合并） */
  "sessions.listEvents"(input: { sessionId: string }): { events: ProviderEvent[] };
  /** 任务名下全部会话（P0-11 AgentCard 数据源；daemon 经 workspace.taskId 联表） */
  "sessions.list"(input: { taskId: string }): { items: Session[] };

  // --- terminals（§5.2：人类终端；帧协议见 terminal.ts）---
  /** §5.3 示例原文 */
  "terminals.create"(input: {
    projectId: string;
    workspaceId?: string;
    cwd: string;
    cols: number;
    rows: number;
  }): TerminalHandle;
  /** data 为 base64 字节流（§7.3 input 帧） */
  "terminals.write"(input: { terminalId: string; data: string }): void;
  "terminals.resize"(input: { terminalId: string; cols: number; rows: number }): void;
  "terminals.kill"(input: { terminalId: string }): void;

  // --- diff（§5.2：审查闭环）---
  /** §5.3 示例原文 */
  "diff.workspaceDiff"(input: { workspaceId: string }): DiffResult;
  // P1+ 占位：diff.requestChanges / diff.approve（P1-03 审查闭环）

  // --- system（§5.2：daemon 自身）---
  "system.health"(): SystemHealth;
  "system.version"(): SystemVersion;
  "system.shutdown"(): void;

  // --- 事件订阅（§5.4：带 cursor 断线重放）---
  subscribe(input: { topics: string[]; cursor?: number }): {
    cursor: number;
    snapshot?: StateSnapshot;
  };

  // P1+ 占位（§5.2 方法分组，不在此发明形状）：
  // - workspaces 组（createForTask / release / cleanupOrphans）：随 P0-05 worktree 生命周期落地时补充
  // - mcp 组（listTools / toggleFamily）：P1-06 mcp-host
  // - projects 设置类方法：随 per-project settings 需求补充
}
