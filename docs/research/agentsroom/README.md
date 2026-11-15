# AgentsRoom 调研报告（复刻依据）

> 调研时间：2026-11-14 ~ 2026-11-15 · 方法：9+8 路 parallel agent 调研（官网/文档/博客/changelog/GitHub/11 个开源竞品 + 4 个仓库源码级深挖）
> 数据来源均标注原文 URL；star 数为抓取当日快照。

## 一句话结论

**AgentsRoom 是一个闭源商业 Electron 桌面应用（法国团队），定位 "Agent Development Environment (ADE)"：在一个窗口里编排多个项目 × 多个 AI agent CLI（19 家 provider），本地 spawn 真实 CLI 进程（BYOK、不代理 token），围绕它构建状态监控、沟通、审查、可靠性四层价值。** 它用自己开发自己（8 角色 agent 团队 + 2 位人类发布，332 个 release 全部署名参与 agent），约 1.1 版/天迭代。

## 核心思想（"它的思想"到底是什么）

复刻要继承的不是 103 项功能，而是以下 7 条设计公理——这也是全部 11 个开源竞品共同收敛出的范式：

1. **不做模型代理**：用户已付费的 CLI 订阅（Claude Code / Codex / Grok…）就是算力来源。应用只做编排层 + 驾驶舱 UI，从 PATH 检测 CLI、spawn 真实进程，不碰 token 转售。
2. **执行权归 daemon/server，UI 只是客户端**：Orca 的 orcad、T3 的 Environment server、Happy 的 happy-agent、Paseo 的 daemon、Herdr 的 daemon 全是这个结构。桌面壳可崩可升级，agent 会话活着。
3. **每任务/每 agent 一个 git worktree**：11 个项目无一例外的隔离标准；主 checkout 永远干净，diff/审查/合并以 worktree 分支为单位。
4. **agent 接入三层分类**：TUI-in-PTY（一个枚举接 46 家 CLI，广度）／厂商结构化协议（Claude Agent SDK stream-json、Codex app-server JSON-RPC，深度）／ACP 标准协议（长尾统一）。AgentsRoom 额外证明：走 PTY 就能全兼容，状态靠"终端流解析 + per-provider 规则 + CLI 原生 hooks + agent 自报 MCP"。
5. **IDE 能力经 MCP 反向开放给 agent**（agent 驱动 agent）：AgentsRoom 暴露 ~155 个 MCP 工具（backlog/mail/terminal/browser/ssh/db/secrets…），agent 可读写任务板、互发邮件、开终端、驱动浏览器自验——编排能力本身就是产品。
6. **可靠性是第一产品力**：消息先落盘再投递、进程守护（Process Guard 三条件判卡死）、quota 监控与账号自动切换、布局 15 秒快照、断线重连、self-healing。AgentsRoom 的 changelog 里 40+ 版都在修终端稳定性。
7. **E2E 加密 relay 打通一切远程场景**：手机遥控、多机 Fleet、跨机接续、Chrome 控制，全部走 X25519+XSalsa20-Poly1305 的 relay，服务器零知识。

## 它的护城河拆解（按功能演进时间线）

- **Day-1 核心**（2026-03~04）：多项目多 agent 网格、per-agent 终端与 git 审查、backlog 任务板、agent 互聊、团队编排、MCP、多账号
- **中期扩展**（2026-05~08）：Dynamic Island、i18n、Linux 支持、定时任务、Agent Teams、SSH 远程、agent 邮箱、webhook
- **近半年差异化**（2026-09~11）：**配额规则引擎**（35+ 版投入，quota 是最高频主题）、远程 SSH fleet、Chrome 真浏览器控制、Linear/Jira/AzureDevOps/YouTrack 工单导入、**non-dev 模式**（17 个业务角色，转向非开发者市场）

→ 复刻建议抓 Day-1 核心 + 少量中期功能；quota 自动化是非-dev 市场的钥匙但工程量大。

## 竞品格局速览（详见 [04](04-competitor-landscape.md)）

| 项目        | star   | 许可证          | 路线          | 一句话                                               |
| ----------- | ------ | --------------- | ------------- | ---------------------------------------------------- |
| Orca        | 124.8k | MIT             | 桌面编排 IDE  | 工程最重：终端 daemon + 三层 agent 接入 + 编排即数据 |
| T3 Code     | 60.2k  | MIT             | server 优先   | 事件溯源编排 + Environment 所有权模型，架构最严谨    |
| Vibe Kanban | 28.7k  | Apache-2.0      | 看板 + 浏览器 | Rust 后端 + npx 分发；已停运可自由搬代码             |
| Happy       | 24.6k  | MIT             | 手机伴侣      | E2EE 零知识 relay + Ghostty 终端协议最完整           |
| Paseo       | 24.0k  | Apache-2.0      | 全端 ADE      | daemon/client + ACP 目录 + Expo 全功能手机端         |
| Herdr       | 51k    | Apache-2.0      | TUI daemon    | Rust 单二进制 + socket API，UI 可插拔                |
| OpenBot     | 7.7k   | PolyForm 非商业 | 持久队友      | 事件溯源 + 聊天网关；架构可学、代码不可搬            |
| Jean        | 1.4k   | Apache-2.0      | Tauri 桌面    | 形态与 AgentsRoom 最接近的唯一 Rust/Tauri 实现       |
| AMUX        | ~560   | MIT             | tmux 面板     | 最小可行架构参考                                     |
| Paradev     | 16k    | MIT             | worktree IDE  | Electron+Turborepo，superset CLI/SDK/MCP 三层接口    |
| Cloudroom   | 1.7k   | Apache-2.0      | 云沙箱        | harness 与编排核心分离，Teleport 会话迁移            |

> star 数已用 shields.io 于 2026-11-15 复核（初轮调研有 agent 遇 GitHub API 限流，Herdr/Paradev/Cloudroom 三个数字以复核为准）。

## 复刻蓝图（详见 [06](06-reimplementation-blueprint.md)）

- **骨架**：Electron（或 Tauri）壳 + 独立 daemon 拥有全部执行；SQLite 单库；MVP 四件套 = worktree + spawn + diff 审查 + commit/PR
- **agent 接入**：Claude Agent SDK（stream-json）+ Codex app-server + ACP 兜底，后期补 TUI-in-PTY 广度层
- **可直接复用的开源件**：`electron-mcp-server`（AgentsRoom 自家、MIT、CDP 控制 Electron 应用）、Vibe Kanban 的 executor 适配层（Apache-2.0）、`agent-client-protocol`、`@anthropic-ai/claude-agent-sdk`
- **本地已克隆供参考的源码**：`D:\Code\Aether\.t3code-tmp\repo`（T3 全库）、`.wf-vk-src\vibe-kanban-main`（VK 全库）

## 文件目录

| 文件                                                                     | 内容                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| [01-product-and-features.md](01-product-and-features.md)                 | 产品定位 + 103 项功能全清单（含机制描述）                                |
| [02-architecture-internals.md](02-architecture-internals.md)             | 技术实现细节：进程/终端/状态推断/存储/MCP/relay/云 agent/权限/agent 邮件 |
| [03-evolution-and-business.md](03-evolution-and-business.md)             | 246 版演进史、商业模式、自举方法论、博客工程实践                         |
| [04-competitor-landscape.md](04-competitor-landscape.md)                 | 11 个开源竞品逐个分析 + 五条路线对比                                     |
| [05-deep-architecture-references.md](05-deep-architecture-references.md) | Orca / T3 Code / Vibe Kanban / Happy 源码级架构深挖                      |
| [06-reimplementation-blueprint.md](06-reimplementation-blueprint.md)     | 复刻决策建议：技术选型、架构分层、MVP 范围、风险                         |
