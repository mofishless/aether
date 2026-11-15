# 05 · 四个参考仓库的源码级架构深挖

> 本文件是复刻时的"抄作业清单"。深挖了四个最具工程参考价值的仓库：Orca、T3 Code、Vibe Kanban、Happy（选题依据调研当日数据；Herdr 经 star 复核为 51k，属终端 daemon 路线、形态差异大，故未列入深挖，其设计要点见 [04 §⑥](04-competitor-landscape.md)）。
> 本地已有源码克隆：`D:\Code\Aether\.t3code-tmp\repo`（T3）、`.wf-vk-src\vibe-kanban-main`（VK）。

---

## A. Orca（stablyai/orca，124.8k★，MIT）

Electron 43 + TypeScript pnpm monorepo。四层进程模型：

### 架构

1. **渲染进程**：React 19.2 + zustand，无业务逻辑；状态由主进程推送的 "sync-runtime-graph"（graph-publication + 投影 + frameSeq 结算序号）驱动；终端 xterm.js 6.1.0-beta + WebGL/serialize 等 9 addon
2. **Electron 主进程**：OrcaRuntime 服务类（`src/main/runtime/orca-runtime.ts`）承载一切业务；**同一 runtime 可脱离 Electron 无头运行**（CLI、远程服务器、移动中继复用）
3. **终端守护进程 orcad**（`src/main/daemon/daemon-entry.ts`）：独立于 UI，独占全部 node-pty；主进程经 Unix socket/Windows 命名管道 NDJSON RPC 连接（hello 握手 + token + 协议版本号）。端点所有权协议：先绑私有名 → link 排他发布 → EEXIST 时连上证明旧端死亡 → 单次 rename 原子替换（7 轮评审修 23 个缺陷）。**收益：app 退出/升级/崩溃后终端仍活着，重开即恢复**
4. **agent 三种接入**：
   - **TUI-in-PTY**：46+ CLI（`src/shared/agent-launch/catalog/tui-agent.ts` 的 TuiAgent 类型联合）跑在 daemon 的 node-pty 里；支持启动命令注入、Windows ConPTY 预热、WSL distro 选择
   - **ACP**：`src/main/acp/process/acp-agent-connection.ts`——piped 子进程 stdin/stdout 上的 JSON-RPC（自研 peer，zod 校验，协议由 schema 生成）
   - **SDK**：`src/main/claude/` 用 @anthropic-ai/claude-agent-sdk stream-json 做原生 Chat UI；**注入自己的 spawn 钩子"拥有"子进程**（PID 级退出证明、POSIX supervisor 宿主死连带杀 agent、Windows .cmd 引号处理）
   - 卖点 "Chat or Terminal"：同一会话两种视图无损互切

### 进程治理（全仓最重的工程）

- `src/packages/process-host`（@orca/process-host）：统一 spawn/树杀/退出证明/cancel-acquisition
- `src/main/pty/process-retirement`：PTY 后代回收（POSIX 进程组 + libproc 前台组、Windows Job 式树杀、exit-proof 关闭阶梯、unproven-retirement 棘轮）
- 几十个 oxlint "ratchet" CI 脚本把架构决策变成硬约束（如渲染层只准写 id）

### 数据模型（SQLite = node:sqlite，WAL，手写 v2→v46 迁移链 + 触发器）

- 实体：Host（本机/SSH/云 VM/paired server）→ Repo → Worktree（agent 独立工作区；支持非 git 的 Folder Workspace）→ WorkspaceSession（布局）→ AgentSession（含 lineage 谱系、recovery capsule）
- **编排即数据**：Run → Worker dispatch（嵌套深度限制、consumer generation 防 fencing）→ Mailbox（邮箱行 + SQL 触发器派生投递状态）→ Task/Question/Decision gate → Federation peer runs（跨 paired server）
- 终端回放 = headless 仿真器快照 + 终端历史 journal（ConPTY viewport 记入会话 meta）
- profile 根 = Electron userData；另可**直接读 Claude Code 等第三方自己的 SQLite 会话库**（foreign-sqlite-readers）

### 最值得抄的 6 条

1. 终端外置 daemon（orcad 模式）——多 agent 长任务桌面应用最核心的可靠性决策
2. 服务端权威终端仿真：daemon 内每 PTY 一个 @xterm/headless，快照可序列化，任何客户端 attach 拿快照+增量流；多客户端共享同一终端免费获得
3. agent 接入三层分类法（TUI/ACP/SDK）——一开始就按这三层设计适配器接口
4. 单一 Runtime 双形态（Electron 主进程/无头）复用
5. 编排即数据：协调者/工人/邮箱/决策门全是 SQLite 表行——天然崩溃恢复、审计、federation
6. spawn 做成"拥有子进程"的严肃工程 + CI 棘轮固化架构规则

---

## B. T3 Code（pingdotgg/t3code，60.2k★，MIT）

TypeScript pnpm monorepo（@t3tools）：apps/server（Node 服务器）+ desktop（Electron 44）+ web + mobile（RN/Expo）+ marketing；packages/contracts（RPC 契约）、client-runtime、provider-_、effect-acp/effect-codex-app-server、source-control-_、secret-provider-*、ssh、tailscale。

### 架构：Environment 所有权模型

- **Environment = 一个 server 进程及其拥有的 agent 进程、终端、Git、项目文件、凭据**；所有客户端（Web/桌面渲染进程/iOS/Android）是对等的认证 **Effect-RPC over WebSocket** 瘦客户端；桌面 app 只是把 server 作为子进程打包（DesktopBackendManager.ts），渲染进程与 Web 走同一边界，**Electron 主进程零领域逻辑**
- **agent spawn：一律 server 上直接子进程 + stdio 管道（不用 pty）**——Claude 走 claude-agent-sdk query()（SDK 自行 spawn CLI，自定义 spawn hook 做 env trampoline）；Codex 走自研 effect-codex-app-server（JSON-RPC over stdio）；任意 ACP agent 走 provider-acp 的 AcpSessionRuntime；Cursor @cursor/sdk、Muse @muse-code/sdk、OpenCode 其 HTTP chat server。**node-pty 只留给人类交互终端**
- **终端渲染不用 xterm.js**：Ghostty 的 libghostty-vt C ABI（Web/Android 编译 WASM）；server 拥有 PTY 与有界历史（每终端 5000 行/8MiB，客户端缓冲 512KiB 增量 chunk）；保留历史剥离终端 query/response 防回放污染

### 事件溯源 v2（orchestration-v2）

- Orchestrator 串行化命令、**无 I/O 纯函数**决定事件；EventSink 在**一个 SQLite 事务**里提交 event + projection + command receipt（幂等）+ outbox effect；EffectWorker 事务后才执行真副作用并把结果回喂为新命令
- provider 会话状态机：starting/ready/running/waiting/stopped/error（ProviderAdapter.ts，816 行 Effect Schema 契约）
- **事件日志只留约 1 天**（重连重放+去重所需），projection 是最终事实源；客户端 cursor 低于剪剪枝水位改从快照恢复
- Thread 是持久实体，provider 进程退出不删线程；checkpoint = **隐藏 git ref**（不产生用户可见 commit）

### 数据模型（SQLite，node:sqlite + WAL 128MiB 上限，114 个 migration）

- Environment > Project > Thread > Turn/Run（RunAttempt）> Activity；Worktree 是线程可用的独立 checkout
- Driver（一种集成）与 ProviderInstance（一套账号配置）分离——多账号同 driver 不共享会话状态
- 核心表：orchestration_events / command_receipts / projection_*（读模型）/ provider_session_runtime / checkpoint_diff_blobs / auth_sessions / peer_environment_links / scheduled_task_webhook_*

### 最值得抄的 6 条

1. **Environment 所有权模型**——彻底消除"桌面特权路径 vs Web 路径"双实现分叉，是复刻 AgentsRoom 最干净的骨架
2. 结构化协议优先的 agent spawn（三协议适配层都是独立包可单独复用）
3. 事件溯源 + 单事务提交 + Outbox：命令幂等、崩溃恢复确定、断线按 cursor 重放
4. ProviderAdapter 契约 + Driver/Instance 双层：新增 agent = 新增 adapter 包，零侵入
5. 终端三铁律：server 持有 + 有界历史；渲染不进 React 帧；保留历史剥离 query/response
6. 把 Git 当状态机用（worktree 隔离、隐藏 ref 检查点、turn/run 双里程碑）

---

## C. Vibe Kanban（BloopAI/vibe-kanban，28.7k★，Apache-2.0，已停运）

### 架构：Rust 本地后端 + Web 前端，无 Electron 依赖

- `npx vibe-kanban`：Node CLI 检测平台/架构（含 Rosetta）→ 从 Cloudflare R2 下载预编译 Rust 后端 → 启动并打开浏览器；URL 特意用 `localhost` 而非 127.0.0.1（macOS ATS 例外）
- 后端：axum 绑 127.0.0.1 + 自动端口；**SQLite 为唯一事实源 + 写库钩子生成 JSON Patch + 单条 SSE "history+live" 合并流**——前端状态严格等于 DB 状态，断线重连天然全量重放再续增量，省掉自研状态同步协议
- 桌面 = Tauri 2 壳内嵌同一后端同一 URL，仅加原生通知/updater

### agent spawn：tokio::process + 进程组，无 pty

- 所有 agent CLI 直接 spawn，stdio 全 piped，`kill_on_drop(true)`，command_group 的 AsyncGroupChild（进程组，Windows 隐藏控制台窗口）
- **双通道接入**：头部 agent 各写一个 stdio JSON 适配器（Claude stream-json，follow-up 用 `--resume <session_id>` + `--resume-session-at <message_id>`；Codex stdio JSON-RPC）；长尾统一走 ACP（agent-client-protocol crate）共享 harness（SETUP_TIMEOUT 120s、CANCEL_GRACE 4s）
- **ACP 活体能力发现**：临时目录 spawn agent → initialize + session/new → 读它广播的 models/reasoning/modes → 5 分钟 TTL 内存 + 磁盘双级缓存——**新 agent 接入成本从"写适配器"降到"填一条命令"**
- 执行器抽象：StandardCodingAgentExecutor trait（spawn/spawn_follow_up/spawn_review/normalize_logs/discover_options）+ enum_dispatch；SpawnedChild{AsyncGroupChild, exit_signal, CancellationToken} 双向退出/取消契约
- **交互式终端只有"给人用的 shell"才开 pty**（portable-pty 0.8，PtyService HashMap<Uuid, PtySession>）；前端 xterm.js 5.5 经 WebSocket（typed input/resize/output + base64）

### 数据模型（SQLite，sqlx + WAL，60+ 迁移）

- projects → tasks（kanban 卡片，status: todo/inprogress/done/cancelled/inreview，parent_task 自引用）→ workspaces（git worktree，container_ref 支持未来换容器）→ sessions（executor 如 'CLAUDE_CODE'）→ execution_processes（run_reason: setup/cleanup/dev_server/coding_agent）+ execution_process_logs（**JSONL 原样落库，每 vendor 一个 normalize_logs 旁路转换器**）
- executor_sessions 表存外部 session id 供 `--resume`；worktree 创建按路径全局锁防并发
- **Rust 结构体三派生（FromRow + ts-rs::TS + schemars）自动生成 TS 类型与 JSON Schema——前后端类型单一来源**

### 生命周期

ContainerService（1426 行）：setup 脚本 → coding agent → try_commit_changes → cleanup；启动跑 cleanup_orphan_workspaces()，每 1800s 清理过期；进程组孤儿（如 MCP server）等 5s 再 SIGKILL

### 最值得抄的 7 条

1. 单一 Rust 后端 + Web 前端 + 可选 Tauri 壳——一套代码覆盖浏览器与桌面
2. executor trait + 进程组 + 双向取消契约
3. 双通道接入（头部深度适配 + ACP 长尾 + 活体能力发现）
4. SQLite 唯一事实源 + DB 写钩子 → JSON Patch → SSE 合并流
5. 日志先存原始再归一化（vendor 格式变化只改一个文件）
6. 任务/执行环境/会话三层拆开的数据模型
7. 终端通道分离：agent 走结构化管道，人用 shell 才开 pty

---

## D. Happy（slopus/happy 24.6k★ MIT + happy-agent + happy-desktop）

### 架构：桌面纯客户端 + Bun 单二进制 daemon

- Electron 主进程**不含任何 agent 逻辑**，只负责下载/管理独立的 happy-agent 二进制（desktopDaemonController：版本门控、数据版本降级保护、`happy-agent reload` 平滑升级）
- happy-agent：Bun 打包的单文件 TypeScript daemon，监听私有 Unix socket `~/.happy/agent/server.sock`，同 socket 上 HTTP API + WebSocket 升级，bearer token 鉴权，PID 文件 + drain 排水
- 桌面状态：zustand + yjs，经 @slopus/happy-agent-client 先 getDesktopBootstrap 快照再增量投影

### 终端：canonical Ghostty 模拟器 + ghostty-web 协议

- 每终端 = 宿主 PTY + daemon 内**唯一 canonical Ghostty 模拟器**实例；渲染端嵌 Ghostty WASM 作 replica
- 自研二进制协议：包长受限、版本号、可选 deflate、单调字节偏移/网格修订号；**两种模式自动降级**——(a) VT 回放（原始字节，客户端消化完才 ACK）+ credit 流控；(b) 语义网格（keyframe + 行级 patch，慢客户端/重连/几何变更后永久切换）
- 重连带 terminal epoch + 服务端 lease；resize 先排水再广播 barrier；exit 等 ACK 覆盖后才下发；scrollback 10000 行分页
- 终端按 scope（projectId / projectId+workspaceId）**归属文件夹而非打开者**——同项目所有人看同一组终端

### provider 接入（happy-providers）

- Claude Code 经 claude-agent-sdk（Happy 工具经 MCP 桥 AcpToolBridgeServer 接入，权限模式映射 read_only→plan / workspace_write→acceptEdits / auto→auto；凭证 CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_API_KEY/CLAUDE_CONFIG_DIR 注入）
- Codex 走 codexAppServer、Gemini 走 Antigravity；任意 ACP agent node:child_process 直接 spawn（JSON-RPC stdio + processTree 杀树）
- **agent 跑命令默认管道 + `TERM=dumb NO_COLOR=1 PAGER=cat` 抑制 TUI，仅人类交互终端 tty:true**（ProcessTransport 统一 pipe|pty）

### 数据模型

- 本地 SQLite（libsql + drizzle，单连接 FIFO 序列化 + 进程锁 + durableCommit）：Project（身份=规范化绝对路径）、Workspace（受管 worktree，**持久预留先行**：先写唯一 name/storage_key/branch 行再动 Git——并发碰撞安全、崩溃可恢复）、Terminal（**刻意无持久化**："终端是活进程+活屏幕"）、**History（append-only，与模型上下文分离——上下文会被 compaction/模型切换重置，history 不丢；发送者溯源 messageOrigin：真人记 user，agent 合成记 agent+senderAgentId，fail-closed）**、Runner（本机/远程机器）、Surfaces（多人共享类型化功能实例）
- 云端 relay（happy-server：Fastify + Prisma + **PGlite 内嵌 Postgres**，单容器 Docker）：Session/Project 均密文 metadata + DEK 字段，socket.io 同步；AccountPushToken 走 Cloudflare Worker 加密推送（APNs/FCM）

### 最值得抄的 6 条

1. 桌面纯客户端化 + 单二进制 daemon（Bun 打包）——UI 技术栈可随时替换，multiplayer/手机接管是同一协议的副产品
2. canonical 模拟器 + replica 协议（多客户端共看同一终端的状态同步天花板）
3. 持久预留先行（先写库行再动 Git）
4. 外来 agent 当 harness 而非重造（一个 ForeignAgent 接口收敛"编排多家 CLI"）
5. 上下文与历史分离 + 发送者溯源
6. 零知识 relay 全套（本地生钥/密文 blob/公钥签名认证/加密推送/QR 配对/单容器自托管）
