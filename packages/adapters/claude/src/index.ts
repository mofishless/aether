// @aether/adapter-claude —— L1 Claude 适配器（SYSTEM_DESIGN §6.2 AgentAdapter 的
// @anthropic-ai/claude-agent-sdk 实现，P0-07）：
// query() stream-json 驱动、事件归一化（normalize 纯函数，normalizeLogs 旁路共用）、
// --resume follow-up、canUseTool 权限桥、进程治理经 @aether/process-host
// （SDK spawnClaudeCodeProcess 钩子注入 spawnCommand）。
// 枚举/端口/事件类型唯一来源：@aether/contracts 与 @aether/core（本包零重复定义）。
export { createClaudeAdapter, resolveBundledCliPath } from "./adapter.js";
export type { ClaudeAdapterDeps, QueryFn } from "./adapter.js";
export { EPOCH_PLACEHOLDER, mapSdkMessage, normalizeStream, vendorTimestamp } from "./normalize.js";
export type {
  MappedMessage,
  MessageContext,
  NormalizeStreamInput,
  NormalizeStreamResult,
  TerminalIntent,
} from "./normalize.js";
export { createProcessHostSpawn, wrapProcessHandle } from "./spawn-bridge.js";
export type { ProcessHostSpawnDeps } from "./spawn-bridge.js";
