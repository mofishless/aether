// @aether/storage —— SQLite（node:sqlite）访问层（SYSTEM_DESIGN §4）：
// 连接封装（WAL PRAGMA 三连）、手写迁移链、种子、Repositories。
// 实体与枚举类型唯一来源 @aether/contracts，本包只做蛇列名 ↔ 驼峰字段映射，不重复定义。
export { closeDatabase, openDatabase, openStorage } from "./connection.js";
export { StorageError } from "./errors.js";
export type { StorageErrorContext, StorageErrorInit } from "./errors.js";
export { BASE_MIGRATIONS, runMigrations } from "./migrations/runner.js";
export type { Migration } from "./migrations/types.js";
export { V1_MIGRATION } from "./migrations/v1.js";
export {
  AgentProfileRepository,
  type AgentProfileCreateInput,
  type AgentProfilePatch,
} from "./repositories/agent-profile.repository.js";
export {
  ExecutionProcessLogRepository,
  type ExecutionProcessLogCreateInput,
  type ExecutionProcessLogPatch,
} from "./repositories/execution-process-log.repository.js";
export {
  ExecutionProcessRepository,
  type ExecutionProcessCreateInput,
  type ExecutionProcessPatch,
} from "./repositories/execution-process.repository.js";
export {
  ProjectRepository,
  type ProjectCreateInput,
  type ProjectPatch,
} from "./repositories/project.repository.js";
export {
  ProviderConfigRepository,
  type ProviderConfigCreateInput,
  type ProviderConfigPatch,
} from "./repositories/provider-config.repository.js";
export {
  SessionRepository,
  type SessionCreateInput,
  type SessionPatch,
} from "./repositories/session.repository.js";
export {
  TaskRepository,
  type TaskCreateInput,
  type TaskPatch,
} from "./repositories/task.repository.js";
export {
  WorkspaceRepository,
  type WorkspaceCreateInput,
  type WorkspacePatch,
} from "./repositories/workspace.repository.js";
export { findDefaultGlobalProfile, seedDefaults } from "./seed.js";
