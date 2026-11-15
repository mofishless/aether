// 启动 agent 面板（P0-11）：选中任务 → prompt 输入 → "启动 agent"（agents.spawn；
// agentProfileId 缺省走 daemon 种子默认 profile）。
import { useState, type FormEvent, type ReactElement } from "react";
import { spawnAgent, useAppStore } from "../state/app-store.js";

export function SpawnAgentPanel(): ReactElement {
  const selectedTaskId = useAppStore((state) => state.selectedTaskId);
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

  return (
    <section className="panel" data-testid="spawn-panel">
      <h2 className="panel-title">启动 agent</h2>
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
