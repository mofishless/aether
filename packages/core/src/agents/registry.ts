import type { ProviderKind } from "@aether/contracts";
import type { AgentAdapter, ResolvedProviderConfig } from "./port.js";

// ===== 适配器注册表（SYSTEM_DESIGN §6.4）=====
// daemon 启动时注册内置 kind（registerAdapter("claude-sdk", createClaudeAdapter) 等）；
// 未来 acp/tui 包以新 kind 进入同一注册表，零侵入（调研 05.B #4）。
// core 自身不预置任何实现（P0 口径）；P0 阶段实现 = 模块级 Map，同 kind 重复注册以后者替换
// （供测试与未来热替换）。

/** §6.4：工厂 = (已解析配置) → Adapter 实例。 */
export type AdapterFactory = (cfg: ResolvedProviderConfig) => AgentAdapter;

const factories = new Map<ProviderKind, AdapterFactory>();

/** 注册（或替换）某个 provider kind 的适配器工厂。 */
export function registerAdapter(kind: ProviderKind, factory: AdapterFactory): void {
  factories.set(kind, factory);
}

/** 按配置的 kind 创建适配器；未注册的 kind 抛错（消息含已注册清单，便于排障）。 */
export function createAdapter(cfg: ResolvedProviderConfig): AgentAdapter {
  const factory = factories.get(cfg.kind);
  if (factory === undefined) {
    const registered = [...factories.keys()].sort().join(", ");
    const registeredHint = registered.length > 0 ? registered : "（无）";
    throw new Error(
      `未注册的 provider kind '${cfg.kind}'（已注册：${registeredHint}）；` +
        "内置 kind 由 daemon 启动时注册（SYSTEM_DESIGN §6.4）",
    );
  }
  return factory(cfg);
}
