// @aether/adapters-codex —— L1 Codex 适配器（SYSTEM_DESIGN §6.2 AgentAdapter 的
// 自研 app-server JSONL RPC 实现，P1-01）：
// 四分支帧路由（无 jsonrpc 键信封）、initialize 握手（experimentalApi）、
// thread/turn/item 事件归一化（normalize 纯函数，normalizeLogs 旁路共用）、
// 审批双向应答桥、thread/resume 恢复与全量水合、进程治理经 @aether/process-host
// （Windows .cmd shim 解析为 node 一等进程；树杀/ExitProof 与 claude adapter 同语义）。
// 枚举/端口/事件类型唯一来源：@aether/contracts 与 @aether/core（本包零重复定义）。
export { createCodexAdapter } from "./adapter.js";
export type { CodexAdapterDeps } from "./adapter.js";
export { RpcError, RpcTimeoutError, RpcTransportError, createJsonlRpcClient } from "./client.js";
export type {
  JsonlRpcClient,
  JsonlRpcClientOptions,
  RpcClientInfo,
  ServerRequestOutcome,
} from "./client.js";
export {
  classifyFrame,
  createFrameRouter,
  createFrameRouterCounters,
  parseFrameLine,
} from "./frame-router.js";
export type {
  ClassifiedFrame,
  FrameRouter,
  FrameRouterCounters,
  FrameRouterOptions,
  ParsedFrameLine,
  RpcErrorShape,
  ServerNotificationFrame,
  ServerRequestFrame,
} from "./frame-router.js";
export {
  approvalEventFor,
  approvalSummary,
  approvalToolName,
  autonomyToCodexPolicy,
  extractApprovalKey,
  isApprovalMethod,
  isoFromEmittedAt,
  mapNotification,
  mapResumeTurns,
  mapThreadItem,
  normalizeFrames,
  textUserInput,
  v1ApprovalDecision,
  v2ApprovalDecision,
  EPOCH_PLACEHOLDER,
  V1_APPROVAL_METHODS,
  V2_APPROVAL_METHODS,
} from "./normalize.js";
export type {
  ApprovalChoice,
  ApprovalEventContext,
  CodexMessageEvent,
  CodexPolicy,
  HydrationContext,
  ItemEventContext,
  ItemMapped,
  ItemPhase,
  NotificationContext,
  NotificationMapped,
  NotificationSignals,
} from "./normalize.js";
export {
  DEFAULT_CODEX_SERVER_ARGS,
  launchCodexServer,
  parseCmdShimContent,
  prepareCodexHome,
  resolveCodexLaunch,
} from "./spawn.js";
export type { LaunchSpec, LaunchCodexServerOptions, ShimReader, ShimResolution } from "./spawn.js";
