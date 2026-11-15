# 04 · 开源竞品格局（11 个项目）

> 数据抓取于 2026-11-14/15。star 为当日快照。这个赛道在 2026 年已经从" Ideas "变成"红海"，但每家走出了一条不同路线。

## 五条路线总览

| 路线             | 代表                            | 核心决策                                                                |
| ---------------- | ------------------------------- | ----------------------------------------------------------------------- |
| ① 桌面编排 IDE   | **Orca**、Paradev、Jean         | Electron/Tauri 单体，每任务一 worktree + 多 CLI 并行 + diff/PR 审查闭环 |
| ② 服务器优先     | **T3 Code**、Vibe Kanban、Paseo | 本地 server/daemon 拥有进程，桌面/网页/手机是认证 RPC 瘦客户端          |
| ③ 终端 daemon    | **Herdr**、AMUX                 | Rust 单二进制守护进程 + socket/Web UI，UI 可插拔甚至无 GUI              |
| ④ 云沙箱         | Cloudroom                       | 执行在云端隔离沙箱，桌面只是控制器，会话可迁移（Teleport）              |
| ⑤ 聊天式持久队友 | OpenBot、Happy                  | local-first 工作区 + 聊天网关/手机伴侣，agent 是"同事"不是"任务"        |

**共性规律**（11 家收敛，即赛道事实标准）：

- git worktree-per-task 是标准隔离；**都不沙箱化进程本身**（只隔离文件）
- "agent 驱动 agent"成为趋势：CLI/SDK/MCP/socket API 开放编排（Paradev 的 superset CLI、Herdr 的 socket、AMUX 的原子任务认领、Orca 的 orca CLI）
- 持久化路线分化：SQLite 事件溯源（OpenBot/Orca/T3/Happy）vs 云 Postgres/Neon（Paradev）
- daemon/client 分离是多数派（Paseo daemon:6767、Happy 私有 socket、Jean jean-server:3456、Herdr socket）

---

## ① Orca（stablyai/orca）— 124.8k★ · MIT · 赛道工程天花板

- **形态**：Electron 43 "并行 agentic 开发 IDE"，TypeScript pnpm monorepo，2026-03 创建，日更（v1.4.214）
- **技术栈**：React 19 + Tailwind 4 + radix-ui + zustand + monaco；node-pty 1.1 + xterm.js 6 beta（9 个 addon 含 WebGL/headless/serialize）；playwright-core 内嵌浏览器；React Native/Expo 手机端；Windows 走 WSL；自研 `orca` CLI
- **三大看点**：
  1. **headless xterm + serialize**：同一会话在结构化 Chat UI 与原始 CLI 终端间**无损互切**（多 agent 编排的核心交互难题）
  2. **coordinator/worker 编排**：主 agent 经一等公民的 Orca CLI 拆解任务并在独立 worktree 启动 worker agent——CLI 即 API，agent 自己当 orchestrator
  3. **执行位置可插拔**：本机 / SSH 主机 / Remote Orca Server / 每 worktree 独享云 VM；笔记本睡眠 agent 继续跑
- 行内 diff 批注直接回送 agent 会话；CI 失败与 PR 评论也回传修复
- 详见 [05 深挖](05-deep-architecture-references.md)

## ② T3 Code（pingdotgg/t3code）— 60.2k★ · MIT · 架构最严谨

- **形态**：TypeScript monorepo（@t3tools）：t3 server（Node）+ Electron 44 桌面 + Web + 原生 iOS/Android；v0.1.9 早期但迭代极快
- **核心模型**："Environment = 一个 server 进程及其拥有的 agent/终端/Git/文件/凭据"；**所有客户端对等，Electron 主进程零领域逻辑**（桌面只是把 server 打包成子进程）
- **事件溯源 v2 编排**：命令→事件→投影，单 SQLite 事务提交，命令幂等回执，EffectWorker 事务后才做副作用；隐藏 git ref 做检查点；无客户端连接也能自动结算 thread
- 架构文档明言第一约束："远程客户端绝不能用自己的文件系统、凭据或机器状态替代执行环境的"
- 详见 [05 深挖](05-deep-architecture-references.md)

## ③ Vibe Kanban（BloopAI/vibe-kanban）— 28.7k★ · Apache-2.0 · 产品形态最贴、已停运可自由搬

- **形态**：`npx vibe-kanban` 一键启动——Node CLI 下载预编译 Rust 后端（axum + WebSocket + SQLite）并打开浏览器；Tauri 2 壳可选
- **管线**：看板 issue → workspace（git worktree + 终端 + dev server）→ agent 执行 → 行内评论 diff 审查 → PR
- **executor 适配层**（Rust trait + 每家一个文件 + ACP 兜底 + 本机自动发现登录态）是支持 10+ agent 的最简可行插件模型；ts-rs 从 Rust 结构体生成前端 TS 类型
- **注意**：Bloop 公司 2026-04-10 官宣关闭，仓库转社区维护（最近推送仍活跃）；Apache-2.0 无传染，**适合直接搬代码/fork，但要准备接盘**
- 详见 [05 深挖](05-deep-architecture-references.md)

## ④ Happy（slopus/happy + happy-agent + happy-desktop）— 24.6k★ · MIT · E2EE 与远程终端最深

- **形态**：四仓库体系——主仓库（原生 iOS Swift / Android Kotlin / happy-cli / happy-server relay / push server）+ happy-agent（Bun 单二进制无头 daemon，基于 Pi）+ happy-desktop（Electron 壳，只是客户端）
- **零知识 relay**：客户端本地生钥（tweetnacl/noble ed25519），服务端只存加密 blob + DEK，公钥签名认证无密码，推送内容也加密，QR 配对，单容器自托管（PGlite 内嵌 Postgres）
- **终端天花板**：daemon 内唯一 canonical Ghostty 模拟器 + ghostty-web 二进制协议（VT 回放配 credit 流控 / 语义网格 keyframe+行 patch 双模式降级，取经 Mosh/VNC/RDP/tmux）
- ForeignAgent 接口：Claude Code 走 Agent SDK（权限模式映射 read_only→plan）、Codex 走 app-server、任意 ACP agent 即插即用
- multiplayer 多人共驾会话；详见 [05 深挖](05-deep-architecture-references.md)

## ⑤ Paseo（getpaseo/paseo）— 24.0k★ · Apache-2.0 · daemon/client 全端范本

- **形态**：TypeScript monorepo——packages/server（daemon，编排+WS API+MCP）+ desktop（Electron）+ app（**Expo iOS/Android/Web 同码，手机是完整功能 App**）+ cli + relay（官方 relay 为 Elixir，可自托管 Docker 单容器）
- **两层 provider 策略**：原生 7 家（Claude/Codex/Copilot/OpenCode/Pi/Antigravity/Muse）+ **ACP 目录接数十家**——成本最低覆盖最广，值得直接效仿
- 每工作区全功能面板（编辑器+终端+diff+浏览器+PR）；插件跑在 daemon 一次全端生效；@getpaseo/client SDK 展示如何开放编排能力
- 零遥测、无强制登录

## ⑥ Herdr（ogulcancelik/herdr）— 51k★ · Apache-2.0 · 终端 daemon 路线（star 复核修正：初报 18.1k 有误）

- Rust 单二进制 TUI（无 Electron 无 Node）：workspaces > tabs > panes，每 pane 一个 agent；detach 后任意终端/SSH reattach，**daemon 保活会话重启仍存活**
- `herdr socket` 暴露 socket API——agent 自己也能生成 pane、读其它 pane 输出、互相等待
- 启示：**桌面壳与编排核心分离，核心可独立于 GUI 运行**；插件+主题市场；winget 支持 Windows

## ⑦ OpenBot（nightly-labs/openbot）— 7.7k★ · PolyForm 非商业 · 架构可学代码不可搬

- Electron + SolidJS + Bun + SQLite（事件溯源：追加命令日志+读投影）；3820 commits
- **provider 适配层三类协议**统一封装：Codex App Server（stdio JSONL）、Claude Agent SDK（stream JSON）、其余经 ACP——"多 agent 内核"的核心抽象
- per-agent 工作区目录 + 共享目录；Slack 网关；WebRTC 远程；Expo 手机
- ⚠️ PolyForm Noncommercial（≤0.1.11 曾 Apache-2.0）——只借鉴思想

## ⑧ Jean（coollabsio/jean）— 1.4k★ · Apache-2.0 · 形态最像 AgentsRoom 的 Tauri 实现

- Tauri v2（Rust 后端）+ React 19 + Tailwind 4 + shadcn/ui + Zustand + xterm.js
- worktree-per-task 全生命周期自动化；**本地+多远程服务器统一侧栏**（"操作在拥有项目的服务器上执行"）；headless jean-server（Linux 二进制/Docker）+ 内嵌 Web UI（3456 端口 token 认证）
- Magic Commands：可编辑提示词任务库（审查/commit msg/PR 内容/冲突解决/release notes，每条指定后端+模型+effort+模式）——产品化功能模板
- Plan/Build/Yolo 三执行模式 + 计划审批流；Mr. Robot 轮询 GitHub issue 自动建 worktree 执行
- ⚠️ Windows 标注 "Not fully tested"

## ⑨ AMUX（mixpeek/amux）— ~560★ · MIT · 最小可行架构参考

- Rust 单二进制 + tmux（3.2+）+ Web 仪表盘（localhost:8824）
- 每 agent 一个 git worktree 沙箱；**共享任务板 + 原子任务认领**；schedules/loops；origin-stamped 消息溯源；self-healing（失败/限额自动恢复重启）
- 体量最小，适合作为 MVP 的架构起点参考

## ⑩ Paradev（ParadevAI/paradev）— 16k★ · MIT · Electron 编排 IDE（前 Superset 团队）

- Electron + React + Tailwind + Bun + Turborepo + tRPC + Drizzle/Neon；CLI 为 `superset`（brew/curl）+ @superset_sh/sdk + MCP server——**CLI/SDK/MCP 三层外部接口**让 agent 编排 agent
- 每任务 workspace = worktree + 分支 + 终端；diff/PR/浏览器三面板；automations；iPhone/iPad 伴随（Pro）
- macOS 优先，Linux AppImage 实验，**Windows 暂无**

## ⑪ Cloudroom（davidondrej/cloudroom）— 1.7k★ · Apache-2.0 · 云沙箱路线

- gui/ 桌面 + core/ Rust 服务；**职责分离**：harness 保留自己的 agent 循环/工具/登录，core 只管沙箱/进程/队列/会话录制与恢复
- 每会话线程一个隔离云沙箱（独立 git 分支）；**Teleport 冻结运行中会话、在 Mac 与云之间迁移**（保留相同 chat/model/effort）
- agent 以无管理员权限的独立 Linux 用户运行；API 仅 localhost + secret token；自托管/托管双模式

## 对复刻的组合建议（竞品组 1 的结论）

> 以 **T3 的"服务器拥有执行 + 事件溯源编排"为骨架**，搬 **VK 的 executor 适配器模式与看板式多项目 UX**，学 **Orca 的 chat↔terminal 无缝互切**（headless xterm + serialize）、行内 diff 批注回传、coordinator 经 CLI 派生 worker 的编排方式；移动端与 E2EE 抄 **Happy**；provider 覆盖面抄 **Paseo 的两层策略**。
