import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types.js";

/**
 * v1 = SYSTEM_DESIGN §4.2 DDL 的 P0 子集，逐表逐索引照抄文档：
 * project / task / workspace / provider_config / agent_profile / session /
 * execution_process / execution_process_log + 全部 CREATE INDEX。
 * 不含 mailbox / layout_snapshot / session_snapshot —— P2 编排期以增量迁移补齐。
 */
const V1_DDL = `
CREATE TABLE project (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  root_path          TEXT NOT NULL UNIQUE,   -- 规范化绝对路径即身份（见调研 05.D）
  git_default_branch TEXT NOT NULL DEFAULT 'main',
  settings_json      TEXT NOT NULL DEFAULT '{}',  -- per-project 设置（MCP 家族开关等）
  created_at         TEXT NOT NULL,
  archived_at        TEXT
);

CREATE TABLE task (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  parent_task_id          TEXT REFERENCES task(id) ON DELETE SET NULL,  -- 自引用（见调研 05.C）
  title                   TEXT NOT NULL,
  description             TEXT NOT NULL DEFAULT '',
  status                  TEXT NOT NULL DEFAULT 'todo'
                          CHECK (status IN ('todo','in_progress','in_review','done','cancelled')),  -- 见调研 05.C
  assignee_agent_profile_id TEXT REFERENCES agent_profile(id) ON DELETE SET NULL,
  position                REAL NOT NULL DEFAULT 0,   -- 看板排序
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX idx_task_project_status ON task(project_id, status);

CREATE TABLE workspace (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  task_id       TEXT REFERENCES task(id) ON DELETE SET NULL,
  name          TEXT NOT NULL UNIQUE,      -- 持久预留先行：先插行再动 Git（见调研 05.D #3）
  branch        TEXT NOT NULL,
  worktree_path TEXT NOT NULL UNIQUE,   -- 项目同级 .aether-worktrees/<name>/（repo 外，不弄脏主 checkout）；不可写时回退 userData/aether/worktrees/<id>/
  storage_key   TEXT NOT NULL,             -- 崩溃恢复用的存储键
  status        TEXT NOT NULL DEFAULT 'reserved'
                CHECK (status IN ('reserved','creating','ready','archived','deleting','failed','orphaned')),
                -- 枚举唯一来源 @aether/contracts（WorkspaceStatus）；崩溃恢复扫描 creating/deleting/orphaned
  created_at    TEXT NOT NULL,
  released_at   TEXT
);
CREATE INDEX idx_workspace_project ON workspace(project_id, status);

CREATE TABLE provider_config (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('claude-sdk','codex-app-server','custom')),
  display_name TEXT NOT NULL,
  config_json  TEXT NOT NULL DEFAULT '{}',  -- kind=custom 时存 §6.3 的 schema（zod 校验后入库）
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
-- Driver(kind) 与 Instance(配置行) 分离：同一 kind 可挂多套配置（见调研 05.B #4）

CREATE TABLE agent_profile (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT REFERENCES project(id) ON DELETE CASCADE,  -- NULL=全局可用
  name               TEXT NOT NULL,
  provider_config_id TEXT NOT NULL REFERENCES provider_config(id) ON DELETE RESTRICT,
  model              TEXT,                  -- 覆盖 provider 默认模型
  persona            TEXT NOT NULL DEFAULT '',   -- 系统 prompt 增量（约 6000 字符内每轮重发，见调研 02.g）
  autonomy_json      TEXT NOT NULL DEFAULT '{}', -- 权限/bypass 旗标映射（见调研 02.g）
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE session (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  agent_profile_id    TEXT NOT NULL REFERENCES agent_profile(id) ON DELETE RESTRICT,
  external_session_id TEXT,                -- 供 --resume（见调研 05.C executor_sessions）
  status              TEXT NOT NULL DEFAULT 'starting'
                      CHECK (status IN ('starting','ready','running','waiting','stopped','error')),  -- T3 状态机，见调研 05.B
  lineage_parent_id   TEXT REFERENCES session(id) ON DELETE SET NULL,  -- 会话谱系（见调研 05.A）
  checkpoint_ref      TEXT,                -- 隐藏 git ref，不产生用户可见 commit（见调研 06 §4）
  created_at          TEXT NOT NULL,
  last_active_at      TEXT NOT NULL
);
CREATE INDEX idx_session_workspace ON session(workspace_id, status);

CREATE TABLE execution_process (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  run_reason   TEXT NOT NULL
               CHECK (run_reason IN ('setup','cleanup','dev_server','coding_agent','follow_up')),  -- 见调研 05.C
  pid          INTEGER,
  command_json TEXT NOT NULL,              -- argv + env 变量名列表（不含密钥值）
  status       TEXT NOT NULL DEFAULT 'running'
               CHECK (status IN ('running','exited','killed','failed')),
  exit_code    INTEGER,
  started_at   TEXT NOT NULL,
  ended_at     TEXT
);
CREATE INDEX idx_process_session ON execution_process(session_id, started_at);

CREATE TABLE execution_process_log (
  id              INTEGER PRIMARY KEY,     -- rowid，append-only
  process_id      TEXT NOT NULL REFERENCES execution_process(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,        -- 进程内单调序号
  raw_json        TEXT NOT NULL,           -- JSONL 原样落库（见调研 05.C #5）
  normalized_json TEXT,                    -- normalizeLogs 旁路回填；NULL=尚未归一化
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_logs_process_seq ON execution_process_log(process_id, seq);
`;

export const V1_MIGRATION: Migration = {
  version: 1,
  name: "p0_core_tables",
  up: (db: DatabaseSync): void => {
    db.exec(V1_DDL); // 静态 DDL 常量，db.exec 唯一豁免点（SYSTEM_DESIGN §4）
  },
};
