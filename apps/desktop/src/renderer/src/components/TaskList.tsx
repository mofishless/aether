// 任务栏（P0-11）：选中项目的任务列表 + 新建表单（title）。看板交互留 P1-02。
import { useState, type FormEvent, type ReactElement } from "react";
import { createTask, selectTask, useAppStore } from "../state/app-store.js";

export function TaskList(): ReactElement {
  const tasks = useAppStore((state) => state.tasks);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const selectedTaskId = useAppStore((state) => state.selectedTaskId);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (title.trim().length === 0 || submitting) return;
    setSubmitting(true);
    const ok = await createTask(title.trim());
    setSubmitting(false);
    if (ok) setTitle("");
  };

  return (
    <section className="panel" data-testid="task-panel">
      <h2 className="panel-title">任务</h2>
      <ul className="item-list">
        {tasks.map((task) => (
          <li key={task.id}>
            <button
              type="button"
              data-testid="task-item"
              className={`item-row${task.id === selectedTaskId ? " item-row--active" : ""}`}
              onClick={() => void selectTask(task.id)}
            >
              <span className="item-name">{task.title}</span>
              <span className="item-sub">{task.status}</span>
            </button>
          </li>
        ))}
        {selectedProjectId !== null && tasks.length === 0 && (
          <li className="item-empty">该项目暂无任务</li>
        )}
        {selectedProjectId === null && <li className="item-empty">先选择项目</li>}
      </ul>
      <form
        className="inline-form"
        onSubmit={(event) => void onSubmit(event)}
        hidden={selectedProjectId === null}
      >
        <input
          data-testid="task-title-input"
          placeholder="任务标题"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <button type="submit" data-testid="task-create-button" disabled={submitting}>
          新建任务
        </button>
      </form>
    </section>
  );
}
