// diff 视图（P0-11）：unified 单栏——文件列表 + patch 文本（+/- 行着色）。
// 并排高亮移 P1-03；对比基准 = 项目 gitDefaultBranch（daemon 决定）。
import { useEffect, useState, type ReactElement } from "react";
import { refreshDiff, useAppStore } from "../state/app-store.js";

/** patch 文本按行渲染：+ 行绿、- 行红、其余上下文灰 */
function PatchLines(props: { patch: string }): ReactElement {
  const lines = props.patch.split("\n");
  return (
    <pre data-testid="diff-patch" className="diff-patch">
      {lines.map((line, index) => {
        const marker = line.charAt(0);
        const cls =
          marker === "+"
            ? "diff-line--add"
            : marker === "-"
              ? "diff-line--remove"
              : "diff-line--context";
        return (
          <span key={index} className={`diff-line ${cls}`}>
            {line}
          </span>
        );
      })}
    </pre>
  );
}

export function DiffView(): ReactElement {
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const diff = useAppStore((state) => state.diff);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 进入 diff 页自动拉一次（active 会话切换后 diff 缓存已被清空）
  useEffect(() => {
    if (activeSessionId === null || diff !== null) return;
    setLoading(true);
    void refreshDiff().then(() => setLoading(false));
  }, [activeSessionId, diff]);

  const files = diff?.files ?? [];
  const selected = files.find((file) => file.path === selectedPath) ?? files[0];

  if (activeSessionId === null) {
    return (
      <div data-testid="diff-empty" className="empty-state">
        选择一个 agent 会话后查看 diff
      </div>
    );
  }

  return (
    <div data-testid="diff-view" className="diff-view">
      <div className="diff-toolbar">
        <button
          type="button"
          data-testid="diff-refresh"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            void refreshDiff().then(() => setLoading(false));
          }}
        >
          刷新 diff
        </button>
        {diff !== null && <span className="item-sub">基准 {diff.baseBranch}</span>}
      </div>
      <div className="diff-body">
        <ul className="diff-files">
          {files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                data-testid="diff-file"
                className={`diff-file-row${selected?.path === file.path ? " diff-file-row--active" : ""}`}
                onClick={() => setSelectedPath(file.path)}
              >
                <span className={`diff-status diff-status--${file.status}`}>{file.status}</span>
                {file.path}
              </button>
            </li>
          ))}
          {files.length === 0 && (
            <li className="item-empty">{loading ? "拉取中…" : "无差异文件"}</li>
          )}
        </ul>
        {selected !== undefined && <PatchLines patch={selected.patch} />}
      </div>
    </div>
  );
}
