// 项目栏（P0-11）：项目列表 + 新建表单（name/rootPath）。数据经 app-store 动作，
// 组件不直接触碰 RPC 客户端（渲染层纪律）。
import { useState, type FormEvent, type ReactElement } from "react";
import { createProject, selectProject, useAppStore } from "../state/app-store.js";

export function ProjectList(): ReactElement {
  const projects = useAppStore((state) => state.projects);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (name.trim().length === 0 || rootPath.trim().length === 0 || submitting) return;
    setSubmitting(true);
    const ok = await createProject(name.trim(), rootPath.trim());
    setSubmitting(false);
    if (ok) {
      setName("");
      setRootPath("");
    }
  };

  return (
    <section className="panel" data-testid="project-panel">
      <h2 className="panel-title">项目</h2>
      <ul className="item-list">
        {projects.map((project) => (
          <li key={project.id}>
            <button
              type="button"
              data-testid="project-item"
              className={`item-row${project.id === selectedProjectId ? " item-row--active" : ""}`}
              onClick={() => void selectProject(project.id)}
            >
              <span className="item-name">{project.name}</span>
              <span className="item-sub">{project.rootPath}</span>
            </button>
          </li>
        ))}
        {projects.length === 0 && <li className="item-empty">暂无项目，先新建一个</li>}
      </ul>
      <form className="inline-form" onSubmit={(event) => void onSubmit(event)}>
        <input
          data-testid="project-name-input"
          placeholder="项目名"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          data-testid="project-root-input"
          placeholder="仓库根目录（绝对路径）"
          value={rootPath}
          onChange={(event) => setRootPath(event.target.value)}
        />
        <button type="submit" data-testid="project-create-button" disabled={submitting}>
          新建项目
        </button>
      </form>
    </section>
  );
}
