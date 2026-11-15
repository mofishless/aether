// P0-11 驾驶舱领域状态 store（贴 connection-store 风格）：projects/tasks/sessions/
// 事件流/权限队列/diff 缓存，全部不可变更新。组件不直接持有 RPC 客户端——
// 一切数据经 store 动作（注入缝 configureAppStore），渲染层纪律见 renderer-boundary 测试。
// 会话状态在渲染侧镜像 §8.1 状态机最小折叠（事件驱动），sessions.list 刷新时以库内权威值覆盖。
import { create } from "zustand";
import {
  ProviderEventSchema,
  STATIC_TOPIC,
  sessionEventsTopic,
  type AgentStatus,
  type DiffResult,
  type EventEnvelope,
  type PermissionDecision,
  type ProjectSummary,
  type ProviderEvent,
  type Session,
  type Task,
} from "@aether/contracts";
import {
  parseAgentStatusPatch,
  parseDiffResult,
  parseEventList,
  parseProjectList,
  parseSessionHandle,
  parseSessionList,
  parseTaskList,
  parseTaskUpdate,
} from "./wire-parse.js";

/** 单会话事件流保留上限（环形截断，防长会话无限增长） */
export const MAX_EVENTS_PER_SESSION = 500;

/** RPC 注入缝：main.tsx 装配真客户端，单测注入假件；params 恒为按名对象 */
export type RpcParams = Readonly<Record<string, unknown>>;
export interface RpcPort {
  request<T = unknown>(method: string, params?: RpcParams): Promise<T>;
}

export interface PendingPermission {
  readonly sessionId: string;
  readonly requestId: string;
  readonly toolName: string;
  readonly summary: string;
}

export interface AppStoreState {
  /** 首次 handleConnected 完成（连接后初始数据就绪） */
  readonly booted: boolean;
  readonly projects: readonly ProjectSummary[];
  readonly selectedProjectId: string | null;
  readonly tasks: readonly Task[];
  readonly selectedTaskId: string | null;
  readonly sessions: readonly Session[];
  readonly activeSessionId: string | null;
  /** sessionId → 事件流（listEvents 拉取 + subscribe 推送，按 eventId@occurredAt 去重） */
  readonly eventsBySession: Readonly<Record<string, readonly ProviderEvent[]>>;
  readonly pendingPermissions: readonly PendingPermission[];
  readonly diff: DiffResult | null;
  readonly lastError: string | null;
}

const INITIAL_STATE: AppStoreState = {
  booted: false,
  projects: [],
  selectedProjectId: null,
  tasks: [],
  selectedTaskId: null,
  sessions: [],
  activeSessionId: null,
  eventsBySession: {},
  pendingPermissions: [],
  diff: null,
  lastError: null,
};

export const useAppStore = create<AppStoreState>()(() => INITIAL_STATE);

// ---- 模块级运行时（连接期可变，状态外发不可变）----
let rpc: RpcPort | null = null;
let bootInFlight = false;
/** 已随 subscribe 声明的 topic（重连后 ensureSubscribed 重发全量） */
const subscribedTopics = new Set<string>();

/** 连接后必订的静态投影 topic（session 具体 topic 随会话发现增量补订） */
const BASE_TOPICS: readonly string[] = [
  STATIC_TOPIC.taskUpdated,
  STATIC_TOPIC.workspaceStatus,
  STATIC_TOPIC.agentStatus,
];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setLastError(message: string): void {
  useAppStore.setState((previous) => ({ ...previous, lastError: message }));
}

export function configureAppStore(port: RpcPort): void {
  rpc = port;
}

/** 恢复初始状态（测试隔离用；生产不调用） */
export function resetAppStore(): void {
  rpc = null;
  bootInFlight = false;
  subscribedTopics.clear();
  useAppStore.setState(INITIAL_STATE);
}

/**
 * 订阅接线（任务卡：一次 subscribe 多 topic，具体 session topic 不做通配）。
 * 真实语义（与 daemon 实现对齐，勿误读）：daemon 对已握手连接全量广播
 * （P0-10 定案），subscribe 声明的 topic 集只用于 cursor 重放时的精确匹配；
 * 渲染层真正的事件过滤在 applyEventEnvelope 的客户端 topic 路由。
 */
export async function ensureSubscribed(): Promise<void> {
  const client = rpc;
  if (client === null) return;
  const state = useAppStore.getState();
  const sessionIds = new Set([
    ...Object.keys(state.eventsBySession),
    ...state.sessions.map((session) => session.id),
  ]);
  // 去重后一次声明全量关心的 topic（缺省订阅语义 = 增量补订，见函数头注释）
  const wanted = [...new Set([...BASE_TOPICS, ...[...sessionIds].map(sessionEventsTopic)])];
  const missing = wanted.filter((topic) => !subscribedTopics.has(topic));
  if (missing.length === 0) return;
  try {
    await client.request("subscribe", { topics: wanted });
    for (const topic of wanted) subscribedTopics.add(topic);
  } catch (error) {
    setLastError(`事件订阅失败：${messageOf(error)}`);
  }
}

/** 连接 established 后引导：订阅 + 初始数据（重连幂等重跑） */
export async function handleConnected(): Promise<void> {
  const client = rpc;
  if (client === null || bootInFlight) return;
  bootInFlight = true;
  try {
    await ensureSubscribed();
    await refreshProjects();
    const { selectedProjectId, selectedTaskId } = useAppStore.getState();
    if (selectedProjectId !== null) {
      await refreshTasks(selectedProjectId);
    }
    if (selectedTaskId !== null) {
      await refreshSessions(selectedTaskId);
    }
    useAppStore.setState((previous) => ({ ...previous, booted: true }));
  } finally {
    bootInFlight = false;
  }
}

export async function refreshProjects(): Promise<void> {
  const client = rpc;
  if (client === null) return;
  try {
    const result = await client.request("projects.list");
    const projects = parseProjectList(result);
    if (projects === null) {
      setLastError("projects.list 返回形状非法（wire 校验失败）");
      return;
    }
    useAppStore.setState((previous) => ({ ...previous, projects }));
  } catch (error) {
    setLastError(`加载项目列表失败：${messageOf(error)}`);
  }
}

export async function createProject(name: string, rootPath: string): Promise<boolean> {
  const client = rpc;
  if (client === null) return false;
  try {
    const created = await client.request<{ id?: unknown }>("projects.create", { name, rootPath });
    if (typeof created?.id !== "string") {
      setLastError("projects.create 返回形状非法（缺少 id）");
      return false;
    }
    const projectId = created.id;
    await refreshProjects();
    await selectProject(projectId);
    return true;
  } catch (error) {
    setLastError(`新建项目失败：${messageOf(error)}`);
    return false;
  }
}

export async function selectProject(projectId: string): Promise<void> {
  useAppStore.setState((previous) => ({
    ...previous,
    selectedProjectId: projectId,
    tasks: [],
    selectedTaskId: null,
    sessions: [],
    activeSessionId: null,
    diff: null,
  }));
  await refreshTasks(projectId);
}

export async function refreshTasks(projectId: string): Promise<void> {
  const client = rpc;
  if (client === null) return;
  try {
    const result = await client.request("tasks.list", { projectId });
    const tasks = parseTaskList(result);
    if (tasks === null) {
      setLastError("tasks.list 返回形状非法（wire 校验失败）");
      return;
    }
    useAppStore.setState((previous) => ({ ...previous, tasks }));
  } catch (error) {
    setLastError(`加载任务列表失败：${messageOf(error)}`);
  }
}

export async function createTask(title: string): Promise<boolean> {
  const client = rpc;
  const projectId = useAppStore.getState().selectedProjectId;
  if (client === null || projectId === null) {
    setLastError("新建任务失败：先选择项目");
    return false;
  }
  try {
    const created = await client.request<{ id?: unknown }>("tasks.create", { projectId, title });
    if (typeof created?.id !== "string") {
      setLastError("tasks.create 返回形状非法（缺少 id）");
      return false;
    }
    const taskId = created.id;
    await refreshTasks(projectId);
    await selectTask(taskId);
    return true;
  } catch (error) {
    setLastError(`新建任务失败：${messageOf(error)}`);
    return false;
  }
}

export async function selectTask(taskId: string): Promise<void> {
  useAppStore.setState((previous) => ({
    ...previous,
    selectedTaskId: taskId,
    activeSessionId: null,
    diff: null,
  }));
  await refreshSessions(taskId);
}

export async function refreshSessions(taskId: string): Promise<void> {
  const client = rpc;
  if (client === null) return;
  try {
    const result = await client.request("sessions.list", { taskId });
    const sessions = parseSessionList(result);
    if (sessions === null) {
      setLastError("sessions.list 返回形状非法（wire 校验失败）");
      return;
    }
    useAppStore.setState((previous) => ({ ...previous, sessions }));
    await ensureSubscribed();
    // 无本地缓存的会话补拉历史事件（活动视图切换即有内容）
    const cached = useAppStore.getState().eventsBySession;
    for (const session of sessions) {
      if (cached[session.id] === undefined) {
        await loadSessionEvents(session.id);
      }
    }
  } catch (error) {
    setLastError(`加载会话列表失败：${messageOf(error)}`);
  }
}

export async function loadSessionEvents(sessionId: string): Promise<void> {
  const client = rpc;
  if (client === null) return;
  try {
    const result = await client.request("sessions.listEvents", { sessionId });
    const events = parseEventList(result);
    if (events === null) {
      setLastError("sessions.listEvents 返回形状非法（wire 校验失败）");
      return;
    }
    mergeSessionEvents(sessionId, events);
  } catch (error) {
    setLastError(`加载会话事件失败：${messageOf(error)}`);
  }
}

/** 事件并入（eventId@occurredAt 复合去重：同 eventId 不同轮次回放不误删）+ 截断 */
function mergeSessionEvents(sessionId: string, incoming: readonly ProviderEvent[]): void {
  useAppStore.setState((previous) => {
    const existing = previous.eventsBySession[sessionId] ?? [];
    const seen = new Set(existing.map(eventKey));
    const appended: ProviderEvent[] = [];
    for (const event of incoming) {
      const key = eventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      appended.push(event);
    }
    if (appended.length === 0) return previous;
    const merged = [...existing, ...appended].slice(-MAX_EVENTS_PER_SESSION);
    return { ...previous, eventsBySession: { ...previous.eventsBySession, [sessionId]: merged } };
  });
}

function eventKey(event: ProviderEvent): string {
  return `${event.eventId}@${event.occurredAt}`;
}

/** spawn 后等待会话行在 sessions.list 可见：立即一次，未见到则 250ms 步进重试（上限 2s） */
async function waitForSessionVisible(sessionId: string, taskId: string): Promise<boolean> {
  const RETRY_DELAY_MS = 250;
  const MAX_ATTEMPTS = 8; // 首查 + 7 次重试 ≈ 2s
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    await refreshSessions(taskId);
    if (useAppStore.getState().sessions.some((session) => session.id === sessionId)) return true;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
  return false;
}

export async function spawnAgent(prompt: string): Promise<boolean> {
  const client = rpc;
  const taskId = useAppStore.getState().selectedTaskId;
  if (client === null) {
    setLastError("启动 agent 失败：RPC 通道未就绪");
    return false;
  }
  if (taskId === null) {
    setLastError("启动 agent 失败：先选择任务");
    return false;
  }
  try {
    // agentProfileId 缺省：daemon 取种子全局默认 profile（契约 P0-11 定案）
    const handle = await client.request("agents.spawn", { taskId, prompt });
    const parsed = parseSessionHandle(handle);
    if (parsed === null) {
      setLastError("agents.spawn 返回形状非法（wire 校验失败）");
      return false;
    }
    // 会话行落地 + 具体 topic 补订（refreshSessions 内 ensureSubscribed）+ 激活；
    // 行落库与 RPC 应答偶发可见性差时小步重试（有界）——耗尽仍不可见则显式置错
    // （不静默：用户可经任务列表重选刷新恢复）
    const visible = await waitForSessionVisible(parsed.sessionId, taskId);
    if (!visible) {
      setLastError(
        `启动 agent 后约 2 秒仍未见会话行（sessionId=${parsed.sessionId}），请重选任务刷新`,
      );
    }
    await setActiveSession(parsed.sessionId);
    return true;
  } catch (error) {
    setLastError(`启动 agent 失败：${messageOf(error)}`);
    return false;
  }
}

export async function setActiveSession(sessionId: string): Promise<void> {
  useAppStore.setState((previous) => ({ ...previous, activeSessionId: sessionId, diff: null }));
  await ensureSubscribed();
  if (useAppStore.getState().eventsBySession[sessionId] === undefined) {
    await loadSessionEvents(sessionId);
  }
}

export async function sendFollowUp(message: string): Promise<boolean> {
  const client = rpc;
  const sessionId = useAppStore.getState().activeSessionId;
  if (client === null || sessionId === null) {
    setLastError("跟问失败：无活动会话");
    return false;
  }
  try {
    const handle = await client.request("agents.followUp", { sessionId, message });
    const parsed = parseSessionHandle(handle);
    if (parsed === null) {
      setLastError("agents.followUp 返回形状非法（wire 校验失败）");
      return false;
    }
    const taskId = useAppStore.getState().selectedTaskId;
    if (taskId !== null) {
      await refreshSessions(taskId);
    }
    return true;
  } catch (error) {
    setLastError(`跟问失败：${messageOf(error)}`);
    return false;
  }
}

export async function respondPermission(
  requestId: string,
  decision: PermissionDecision,
): Promise<void> {
  const client = rpc;
  if (client === null) return;
  // 乐观出队；失败重入队回滚并提示（弹层复现，应答路径可达——不静默吞失败）
  const target = useAppStore.getState().pendingPermissions.find((p) => p.requestId === requestId);
  if (target !== undefined) {
    useAppStore.setState((previous) => ({
      ...previous,
      pendingPermissions: previous.pendingPermissions.filter((p) => p.requestId !== requestId),
    }));
  }
  try {
    // processId 缺省：daemon 按 requestId 反查（契约 P0-11 定案，渲染层无从得知 processId）
    await client.request("agents.permission.respond", { requestId, decision });
  } catch (error) {
    if (target !== undefined) {
      useAppStore.setState((previous) => ({
        ...previous,
        pendingPermissions: [...previous.pendingPermissions, target],
      }));
    }
    setLastError(`权限应答失败：${messageOf(error)}`);
  }
}

export async function refreshDiff(): Promise<boolean> {
  const client = rpc;
  const state = useAppStore.getState();
  const session = state.sessions.find((item) => item.id === state.activeSessionId);
  if (client === null || session === undefined) {
    setLastError("拉取 diff 失败：无活动会话");
    return false;
  }
  try {
    const result = await client.request("diff.workspaceDiff", { workspaceId: session.workspaceId });
    const diff = parseDiffResult(result);
    if (diff === null) {
      setLastError("diff.workspaceDiff 返回形状非法（wire 校验失败）");
      return false;
    }
    useAppStore.setState((previous) => ({ ...previous, diff }));
    return true;
  } catch (error) {
    setLastError(`拉取 diff 失败：${messageOf(error)}`);
    return false;
  }
}

// ---- 事件面（subscribe 推送 → store）----

/** 会话内活跃态（终态 stopped/error 吸收后续一切事件，§8.1） */
const ACTIVE_STATUSES: readonly AgentStatus[] = ["starting", "ready", "running", "waiting"];

/** 更新会话状态（不可变；终态吸收；会话不存在忽略——列表刷新后自然对齐） */
function updateSessionStatus(sessionId: string, status: AgentStatus): void {
  useAppStore.setState((previous) => {
    const index = previous.sessions.findIndex((session) => session.id === sessionId);
    if (index === -1) return previous;
    const current = previous.sessions[index];
    if (current === undefined) return previous;
    if (!ACTIVE_STATUSES.includes(current.status)) return previous; // 终态吸收
    if (current.status === status) return previous;
    const sessions = [...previous.sessions];
    sessions[index] = { ...current, status };
    // 终态落地时清该会话的待批权限（进程已结束，弹层失效）
    const pendingPermissions =
      status === "stopped" || status === "error"
        ? previous.pendingPermissions.filter((p) => p.sessionId !== sessionId)
        : previous.pendingPermissions;
    return { ...previous, sessions, pendingPermissions };
  });
}

/** ProviderEvent 的渲染侧最小折叠（镜像 §8.1：活动事件→running、权限→waiting、边界→终态） */
function applyEventSideEffects(sessionId: string, event: ProviderEvent): void {
  switch (event.type) {
    case "status":
      updateSessionStatus(sessionId, event.status);
      return;
    case "permission_request":
      updateSessionStatus(sessionId, "waiting");
      useAppStore.setState((previous) => {
        if (previous.pendingPermissions.some((p) => p.requestId === event.requestId)) {
          return previous;
        }
        const entry = {
          sessionId,
          requestId: event.requestId,
          toolName: event.toolName,
          summary: event.summary,
        };
        return { ...previous, pendingPermissions: [...previous.pendingPermissions, entry] };
      });
      return;
    case "message":
    case "tool_use":
    case "tool_result":
      updateSessionStatus(sessionId, "running");
      return;
    case "session": {
      // starting 中 = 握手（→ready）；其余活跃态 = 会话结束信号（→stopped）
      const current = useAppStore.getState().sessions.find((session) => session.id === sessionId);
      if (current === undefined) return;
      updateSessionStatus(sessionId, current.status === "starting" ? "ready" : "stopped");
      return;
    }
    case "error":
      updateSessionStatus(sessionId, "error");
      return;
  }
}

const SESSION_EVENTS_PATTERN = /^session\.(.+)\.events$/;

/** 校验通过的 EventEnvelope 分发（topic 路由 → store；未消费 topic 静默忽略） */
export function applyEventEnvelope(envelope: EventEnvelope): void {
  const topic = envelope.topic;
  const sessionTopic = SESSION_EVENTS_PATTERN.exec(topic);
  if (sessionTopic !== null) {
    const sessionId = sessionTopic[1];
    if (sessionId === undefined) return;
    // 载荷过 ProviderEventSchema（wire 边界 fail-closed：非法载荷丢弃不破坏连接）
    const parsed = ProviderEventSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    mergeSessionEvents(sessionId, [parsed.data]);
    applyEventSideEffects(sessionId, parsed.data);
    return;
  }
  if (topic === STATIC_TOPIC.agentStatus) {
    const patch = parseAgentStatusPatch(envelope.payload);
    if (patch !== null) {
      updateSessionStatus(patch.sessionId, patch.status);
    }
    return;
  }
  if (topic === STATIC_TOPIC.taskUpdated) {
    applyTaskUpdate(envelope.payload);
    return;
  }
  // workspace.status / terminal.* / process.*：P0 驾驶舱不消费，静默忽略
}

/** task.updated 载荷（{task} 包装，contracts schema 校验）替换列表内同 id 项；非当前项目忽略 */
export function applyTaskUpdate(payload: unknown): void {
  const updated = parseTaskUpdate(payload);
  if (updated === null) return;
  useAppStore.setState((previous) => {
    const index = previous.tasks.findIndex((task) => task.id === updated.id);
    if (index === -1) return previous;
    const tasks = [...previous.tasks];
    tasks[index] = updated;
    return { ...previous, tasks };
  });
}
