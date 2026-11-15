// 启动 agent 面板（P0-11）：选中任务 → prompt 输入 → "启动 agent"（agents.spawn；
// agentProfileId 缺省走 daemon 种子默认 profile）。
// P1-01 支撑件：provider kind 选择器 + 会话恢复能力差异标注（静态能力表，
// 见 state/provider-capabilities.ts）。P1-01 评审 F2 已接线：选择经 agents.spawn
// 显式 providerKind 真实驱动 daemon 路由（不再只是标注）。
import { useState, type FormEvent, type ReactElement } from "react";
import type { ProviderKind } from "@aether/contracts";
import { spawnAgent, selectProviderKind, useAppStore } from "../state/app-store.js";
import { PROVIDER_CAPABILITIES, SPAWN_PROVIDER_KINDS } from "../state/provider-capabilities.js";

export function SpawnAgentPanel(): ReactElement {
  const selectedTaskId = useAppStore((state) => state.selectedTaskId);
  // 基元选择器（string）：无新建对象引用，规避 React #185 无限重渲染（P0-11 教训）
  const selectedProviderKind = useAppStore((state) => state.selectedProviderKind);
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (prompt.trim().length === 0 || selectedTaskId === null || submitting) return;
    setSubmitting(true);
    const ok = await spawnAgent(prompt.trim());
    setSubmitting(false);
    if (ok) setPrompt("");
  };

  const capability = PROVIDER_CAPABILITIES[selectedProviderKind];

  return (
    <section className="panel" data-testid="spawn-panel">
      <h2 className="panel-title">启动 agent</h2>
      <fieldset className="provider-fieldset" data-testid="spawn-provider">
        <legend className="provider-legend">provider</legend>
        {SPAWN_PROVIDER_KINDS.map((kind: ProviderKind) => {
          const option = PROVIDER_CAPABILITIES[kind];
          return (
            <label key={kind} className="provider-option">
              <input
                type="radio"
                name="spawn-provider-kind"
                data-testid={`spawn-provider-option-${kind}`}
                checked={selectedProviderKind === kind}
                onChange={() => selectProviderKind(kind)}
              />
              {option.label}
            </label>
          );
        })}
        <span data-testid="spawn-provider-label" className="provider-chip">
          {capability.label}
        </span>
      </fieldset>
      <ul className="capability-list" data-testid="provider-capabilities">
        {capability.badges.map((badge) => (
          <li key={badge} className="capability-badge">
            {badge}
          </li>
        ))}
      </ul>
      <form className="inline-form" onSubmit={(event) => void onSubmit(event)}>
        <textarea
          data-testid="spawn-prompt-input"
          placeholder={selectedTaskId === null ? "先选择任务" : "给 agent 的一句话 prompt"}
          value={prompt}
          rows={2}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <button
          type="submit"
          data-testid="spawn-button"
          disabled={selectedTaskId === null || submitting}
        >
          启动 agent
        </button>
      </form>
    </section>
  );
}
