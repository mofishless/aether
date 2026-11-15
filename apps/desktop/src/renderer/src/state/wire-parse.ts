// wire 结果结构收窄（P0-11）：RPC 返回值在渲染侧的运行时校验。
// 原则与 rpc-client.parseSystemVersion 一致——contracts 提供运行时 schema 的实体
// （Task/Session/ProviderEvent）直接用 schema.safeParse；仅以 interface 定义的返回形状
// （ProjectSummary/SessionHandle/DiffResult）做结构收窄。渲染层不得 import zod
// （renderer-boundary 白名单），故 schema 经 contracts 值导入、收窄结果手写。
import {
  AgentStatusPayloadSchema,
  AgentStatusSchema,
  ProviderEventSchema,
  SessionSchema,
  TaskSchema,
  TaskUpdatedPayloadSchema,
  type AgentStatus,
  type DiffFile,
  type DiffFileStatus,
  type DiffResult,
  type ProjectSummary,
  type ProviderEvent,
  type Session,
  type SessionHandle,
  type Task,
} from "@aether/contracts";

const DIFF_FILE_STATUSES: readonly DiffFileStatus[] = ["added", "modified", "deleted"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 数组字段整体校验失败返回 null（调用方置 lastError，不静默吞） */
function arrayOf(result: unknown, key: string): readonly unknown[] | null {
  if (!isRecord(result)) return null;
  const items = result[key];
  return Array.isArray(items) ? items : null;
}

/** schema 逐项校验（zod 数组组合需 import zod，渲染层不可；逐项 safeParse 等价） */
function parseAll<T>(
  values: readonly unknown[],
  parse: (value: unknown) => T | null,
): readonly T[] | null {
  const parsed: T[] = [];
  for (const value of values) {
    const item = parse(value);
    if (item === null) return null;
    parsed.push(item);
  }
  return parsed;
}

function parseTask(value: unknown): Task | null {
  const result = TaskSchema.safeParse(value);
  return result.success ? result.data : null;
}

function parseSession(value: unknown): Session | null {
  const result = SessionSchema.safeParse(value);
  return result.success ? result.data : null;
}

function parseProviderEvent(value: unknown): ProviderEvent | null {
  const result = ProviderEventSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** projects.list 返回 → ProjectSummary[] */
export function parseProjectList(result: unknown): readonly ProjectSummary[] | null {
  const items = arrayOf(result, "items");
  if (items === null) return null;
  return parseAll(items, (value) => {
    if (!isRecord(value)) return null;
    const id = value["id"];
    const name = value["name"];
    const rootPath = value["rootPath"];
    const archivedAt = value["archivedAt"];
    if (typeof id !== "string" || typeof name !== "string" || typeof rootPath !== "string") {
      return null;
    }
    if (archivedAt !== null && typeof archivedAt !== "string") return null;
    return { id, name, rootPath, archivedAt };
  });
}

/** tasks.list 返回 → Task[] */
export function parseTaskList(result: unknown): readonly Task[] | null {
  const items = arrayOf(result, "items");
  if (items === null) return null;
  return parseAll(items, parseTask);
}

/** sessions.list 返回 → Session[] */
export function parseSessionList(result: unknown): readonly Session[] | null {
  const items = arrayOf(result, "items");
  if (items === null) return null;
  return parseAll(items, parseSession);
}

/** sessions.listEvents 返回（线1契约形状：{ events: ProviderEvent[] }）→ ProviderEvent[] */
export function parseEventList(result: unknown): readonly ProviderEvent[] | null {
  const events = arrayOf(result, "events");
  if (events === null) return null;
  return parseAll(events, parseProviderEvent);
}

/** agents.spawn / followUp 返回 → SessionHandle */
export function parseSessionHandle(result: unknown): SessionHandle | null {
  if (!isRecord(result)) return null;
  const sessionId = result["sessionId"];
  const workspaceId = result["workspaceId"];
  const status = result["status"];
  if (typeof sessionId !== "string" || typeof workspaceId !== "string") return null;
  const statusParsed = AgentStatusSchema.safeParse(status);
  return statusParsed.success ? { sessionId, workspaceId, status: statusParsed.data } : null;
}

/** diff.workspaceDiff 返回 → DiffResult */
export function parseDiffResult(result: unknown): DiffResult | null {
  if (!isRecord(result)) return null;
  const workspaceId = result["workspaceId"];
  const baseBranch = result["baseBranch"];
  const files = result["files"];
  if (typeof workspaceId !== "string" || typeof baseBranch !== "string" || !Array.isArray(files)) {
    return null;
  }
  const parsedFiles = parseAll(files, (value) => {
    if (!isRecord(value)) return null;
    const filePath = value["path"];
    const status = value["status"];
    const patch = value["patch"];
    if (typeof filePath !== "string" || typeof patch !== "string") return null;
    if (typeof status !== "string" || !DIFF_FILE_STATUSES.includes(status as DiffFileStatus)) {
      return null;
    }
    const file: DiffFile = { path: filePath, status: status as DiffFileStatus, patch };
    return file;
  });
  if (parsedFiles === null) return null;
  return { workspaceId, baseBranch, files: [...parsedFiles] };
}

/** agent.status topic 载荷投影（contracts AgentStatusPayloadSchema，P0-11 线1 定案形状） */
export function parseAgentStatusPatch(
  payload: unknown,
): { sessionId: string; status: AgentStatus } | null {
  const parsed = AgentStatusPayloadSchema.safeParse(payload);
  return parsed.success ? { sessionId: parsed.data.sessionId, status: parsed.data.status } : null;
}

/** task.updated topic 载荷（contracts TaskUpdatedPayloadSchema：{ task: Task } 包装） */
export function parseTaskUpdate(payload: unknown): Task | null {
  const parsed = TaskUpdatedPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data.task : null;
}
