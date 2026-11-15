import { z } from "zod";

// ===== 枚举（与 SYSTEM_DESIGN §4.2 DDL 的 CHECK 约束一一对应；全仓唯一来源，storage/daemon/desktop 均从此 import）=====

export const TaskStatusSchema = z.enum(["todo", "in_progress", "in_review", "done", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const WorkspaceStatusSchema = z.enum([
  "reserved",
  "creating",
  "ready",
  "archived",
  "deleting",
  "failed",
  "orphaned",
]);
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;
// 崩溃恢复扫描 creating / deleting / orphaned（SYSTEM_DESIGN §4.2）

export const AgentStatusSchema = z.enum([
  "starting",
  "ready",
  "running",
  "waiting",
  "stopped",
  "error",
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
// 状态机：starting → ready → running ↔ waiting → stopped / error（SYSTEM_DESIGN §8.1，T3 式）

export const ExecutionProcessStatusSchema = z.enum(["running", "exited", "killed", "failed"]);
export type ExecutionProcessStatus = z.infer<typeof ExecutionProcessStatusSchema>;

export const RunReasonSchema = z.enum([
  "setup",
  "cleanup",
  "dev_server",
  "coding_agent",
  "follow_up",
]);
export type RunReason = z.infer<typeof RunReasonSchema>;

export const ProviderKindSchema = z.enum([
  "claude-sdk",
  "codex-app-server",
  "custom",
  "acp",
  "tui",
]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;
// 'acp' | 'tui' 为 P2+ 扩展位占位，MVP 不注册实现（SYSTEM_DESIGN §6.2）

export const ProviderConfigKindSchema = z.enum(["claude-sdk", "codex-app-server", "custom"]);
export type ProviderConfigKind = z.infer<typeof ProviderConfigKindSchema>;
// provider_config 表 CHECK 子集（DDL 不含扩展位）

export const AutonomyLevelSchema = z.enum(["read_only", "workspace_write", "auto"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;
// 权限模式映射：read_only→plan / workspace_write→acceptEdits / auto→auto（SYSTEM_DESIGN §6.2）

export const PermissionDecisionSchema = z.enum(["approve", "deny"]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

// ===== 实体（字段与 §4.2 DDL 对应；TS 驼峰，storage 层负责蛇↔驼峰行映射）=====
// 约定：主键 uuid v4 字符串；时间一律 UTC ISO-8601 字符串；*_json 列以原始 JSON 字符串透传，
// 需要结构化时由具体 schema（如 CustomProviderConfigSchema）parse。

const isoTimestamp = z.string();

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(), // 规范化绝对路径即身份（唯一）
  gitDefaultBranch: z.string(),
  settingsJson: z.string(),
  createdAt: isoTimestamp,
  archivedAt: isoTimestamp.nullable(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  parentTaskId: z.string().nullable(), // 自引用
  title: z.string(),
  description: z.string(),
  status: TaskStatusSchema,
  assigneeAgentProfileId: z.string().nullable(),
  position: z.number(), // 看板排序
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type Task = z.infer<typeof TaskSchema>;

export const WorkspaceSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string().nullable(), // 归属可空
  name: z.string(), // 唯一；持久预留先行：先插行再动 Git
  branch: z.string(),
  worktreePath: z.string(), // 唯一；项目同级 .aether-worktrees/<name>/，不可写时回退 userData
  storageKey: z.string(), // 崩溃恢复用存储键
  status: WorkspaceStatusSchema,
  createdAt: isoTimestamp,
  releasedAt: isoTimestamp.nullable(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const ProviderConfigSchema = z.object({
  id: z.string(),
  kind: ProviderConfigKindSchema, // Driver(kind) 与 Instance(配置行) 分离
  displayName: z.string(),
  configJson: z.string(), // kind=custom 时为 §6.3 schema（zod 校验后入库）
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const AgentProfileSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(), // NULL = 全局可用
  name: z.string(),
  providerConfigId: z.string(),
  model: z.string().nullable(), // 覆盖 provider 默认模型
  persona: z.string(), // 系统 prompt 增量
  autonomyJson: z.string(), // 权限/bypass 旗标映射
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  agentProfileId: z.string(),
  externalSessionId: z.string().nullable(), // 供 --resume
  status: AgentStatusSchema,
  lineageParentId: z.string().nullable(), // 会话谱系
  checkpointRef: z.string().nullable(), // 隐藏 git ref，不产生用户可见 commit
  createdAt: isoTimestamp,
  lastActiveAt: isoTimestamp,
});
export type Session = z.infer<typeof SessionSchema>;

export const ExecutionProcessSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  runReason: RunReasonSchema,
  pid: z.number().nullable(),
  commandJson: z.string(), // argv + env 变量名列表（不含密钥值）
  status: ExecutionProcessStatusSchema,
  exitCode: z.number().nullable(),
  startedAt: isoTimestamp,
  endedAt: isoTimestamp.nullable(),
});
export type ExecutionProcess = z.infer<typeof ExecutionProcessSchema>;

export const ExecutionProcessLogSchema = z.object({
  id: z.number(), // INTEGER rowid（append-only，业务表才用 TEXT uuid）
  processId: z.string(),
  seq: z.number(), // 进程内单调序号
  rawJson: z.string(), // JSONL 原样落库
  normalizedJson: z.string().nullable(), // NULL = 尚未归一化（normalizeLogs 旁路回填）
  createdAt: isoTimestamp,
});
export type ExecutionProcessLog = z.infer<typeof ExecutionProcessLogSchema>;
