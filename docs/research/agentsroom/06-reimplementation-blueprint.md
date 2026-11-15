# 06 · 复刻蓝图：决策建议

> 依据：AgentsRoom 逆向（[01](01-product-and-features.md)/[02](02-architecture-internals.md)）+ 11 竞品规律（[04](04-competitor-landscape.md)）+ 4 仓库深挖（[05](05-deep-architecture-references.md)）。
> 原则：复刻"思想"（七条设计公理，见 [README](README.md)），不复刻 103 项功能。

## 0. 先回答的定位问题（影响全部选型）

| 问题     | 选项                                                                      | 建议                                                                                                                         |
| -------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 形态     | 桌面 IDE（AgentsRoom/Orca 形态）vs 浏览器面板（VK）vs TUI daemon（Herdr） | 桌面 IDE——与 AgentsRoom 思想最一致，且用户已有同类项目经验                                                                   |
| 桌面框架 | Electron（Orca/T3/Happy/Paradev）vs Tauri（Jean/VK 壳）                   | **Electron**：4/6 头部项目的选择，node-pty/xterm/Agent SDK 生态全在 JS；Tauri 更轻但 Windows 成熟度是 Jean 的前车之鉴        |
| 后端语言 | TypeScript（5/6 头部）vs Rust（VK/Herdr/Cloudroom）                       | **TypeScript**：claude-agent-sdk、ACP、MCP SDK 全是 TS 一等公民；Rust 的收益（单二进制分发/性能）在 MVP 阶段不构成决定性优势 |

## 1. 架构骨架（第一决策：daemon 分离）

所有头部项目的共同答案——**Electron 壳只是客户端，独立 daemon 拥有全部执行**：

```
┌─ Electron 渲染进程（React UI，无业务逻辑）
│    └─ 终端视图 / agent 卡片 / diff 审查 / backlog
├─ IPC/WS 边界（类型化契约，单一来源）
└─ Daemon（独立进程，可无头运行 = 同时代码给 CLI/远程/手机用）
     ├─ Provider 适配层（三层，见 §2）
     ├─ 终端子系统（PTY 池 + headless 仿真器，见 §3）
     ├─ Orchestration（worktree 生命周期 + 任务/邮箱表，见 §4）
     ├─ 状态推断（见 §5）
     └─ SQLite（唯一事实源，WAL）
```

- 参考实现：T3 的 DesktopBackendManager（桌面把 server 当子进程拉起）最干净；Happy 的"Electron 只管下载/升级 daemon 二进制"最彻底；Orca 的 orcad（终端单独再拆一个 daemon）最重
- **MVP 取 T3 式**（server 作为桌面子进程 + 契约包），终端并入 daemon；Orca 式终端独立 daemon 留给可靠性阶段

## 2. Provider 适配层（第二决策：三层分类法）

```
Adapter 接口（spawn / spawn_follow_up / resume / normalize_logs / capabilities）
 ├─ L1 SDK 适配：Claude Agent SDK（stream-json，原生 Chat UI、会话谱系）
 ├─ L2 专有协议适配：Codex app-server（JSON-RPC over stdio）
 └─ L3 广度层：
     ├─ ACP（agent-client-protocol，JSON-RPC over stdio）+ 活体能力发现
     └─ TUI-in-PTY（一个枚举接任意 CLI，终端流解析兜底）
```

- **MVP 只做 L1+L2**（Claude + Codex = AgentsRoom 实际用量的 91%）；ACP 在 P1；TUI-in-PTY 在 P2（需要终端流解析 per-provider 规则，AgentsRoom 的隐性苦活）
- 直接复用：`@anthropic-ai/claude-agent-sdk`、VK 的 `executors` crate 结构（若 TS 则照搬其 trait 形状）、`agent-client-protocol`
- 关键细节（各家都踩过的坑）：进程组杀树（Windows 隐藏控制台窗口）、`--resume <session_id>` 续聊、flag 只信 CLI 自己的 `--help`、严格解析器拒绝重复 flag

## 3. 终端子系统

| 阶段   | 方案                                                                                                           | 来源    |
| ------ | -------------------------------------------------------------------------------------------------------------- | ------- |
| MVP    | xterm.js + node-pty（PTY 在 daemon），每 agent 一个终端 pane                                                   | Jean/VK |
| 进阶   | daemon 内 @xterm/headless 权威仿真 + SerializeAddon 快照 → 多客户端 attach 拿快照+增量；Chat↔Terminal 无损互切 | Orca    |
| 天花板 | canonical Ghostty 模拟器 + replica 协议（VT 回放 credit 流控 / 语义网格降级）                                  | Happy   |

- 学习 AgentsRoom：终端是 agent 的家——它连状态推断都建立在终端流上；学习 VK/Happy：**结构化管道优先，TUI 只留给需要交互式 TUI 的 CLI 和人类 shell**

## 4. Orchestration 与数据模型

- **SQLite 单库（WAL）**，核心表参考 VK + Orca 合并：
  `project → task(backlog 票) → workspace(git worktree，持久预留先行) → session(某 provider 的会话) → execution_process(run_reason 区分) + logs(JSONL 原样落库+旁路归一化)`
  再加 Orca 的编排表：`run / worker_dispatch / mailbox(SQL 触发器派生投递状态) / decision_gate`
- **事件溯源可选**：T3 证明其价值（幂等/崩溃恢复/断线重放），但 MVP 阶段"SQLite 投影 + outbox"的简化版即可，不必一步到 v2
- checkpoint 用**隐藏 git ref**（不产生用户可见 commit）
- agent 邮箱照抄 AgentsRoom 协议（见 [02 §h](02-architecture-internals.md)）：落盘投递、空闲间隙、read 语义、防循环限额、80% 强制 checkpoint

## 5. 状态推断

- L1/L2 agent 有结构化事件，状态直接来自协议（starting/ready/running/waiting/stopped/error——抄 T3 状态机）
- L3 TUI agent 才需要 AgentsRoom 的三通道：终端流解析（per-provider 规则）+ CLI 原生 hooks + `report_status` MCP 自报
- 对外暴露本地状态 API（AgentsRoom 的 local-status-api 是好范本：turn 级 1 秒粒度轮询）

## 6. MCP 反向开放（AgentsRoom 思想的精髓之一）

- daemon 起 MCP host（127.0.0.1 HTTP + 每 console session token），注入各 CLI 配置文件
- 工具家族分期：P1 = backlog（读写票）+ terminal（跑命令）+ memory（项目记忆）；P2 = browser（QA 自验）+ mail + delegation
- **礼仪**：读免确认、写需请求、删除点名；agent 不能改自己/关自己
- 可直接复用：AgentsRoom 自家的 `electron-mcp-server`（MIT，CDP 控内嵌浏览器做 QA）

## 7. 分期建议

| 阶段                   | 范围                                                                                                                              | 验收                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **P0 骨架**（~2-3 周） | Electron + daemon 子进程 + SQLite + 契约包；Claude Agent SDK 单 agent 跑通；xterm 终端；worktree 生命周期（创建/清理/持久预留）   | 拖一张票 → worktree → Claude 执行 → diff 展示 |
| **P1 核心四件套**      | Codex app-server；backlog 看板；diff 行内评论回传 agent；commit/PR；项目记忆；MCP host（backlog+terminal）                        | 两 agent 并行 + 审查闭环 + agent 能读 backlog |
| **P2 编排**            | ACP + 能力发现；agent 邮箱；多 agent 团队（画布可后置，先用配置）；定时/webhook；quota 读取（`~/.claude/projects/` JSONL 直读法） | agent 驱动 agent（delegation/Mail）           |
| **P3 可靠性+广度**     | TUI-in-PTY 广度层；headless xterm 快照；布局恢复；self-healing；账号多开（HOME 目录隔离）                                         | 崩溃恢复演示                                  |
| **P4 远程**（可选）    | E2E relay（X25519+XSalsa20，抄 Happy 零知识模式）+ 手机伴侣；或先做 Web 客户端                                                    | 手机答题                                      |

## 8. 可直接复用的开源件清单

| 组件                                        | 许可证     | 用途                                                                  |
| ------------------------------------------- | ---------- | --------------------------------------------------------------------- |
| `electron-mcp-server`（AgentsRoomDev 自家） | MIT        | CDP 控制内嵌浏览器/Electron 应用做 QA（17 个现成工具）                |
| Vibe Kanban `crates/executors`              | Apache-2.0 | executor trait 形状 + Claude/Codex/ACP 适配器参考（Rust，逻辑可移植） |
| `@anthropic-ai/claude-agent-sdk`            | —          | L1 接入 + stream-json + 会话管理                                      |
| `agent-client-protocol`                     | —          | L3 ACP 标准协议                                                       |
| T3 `packages/contracts` 模式                | MIT        | RPC 契约单一来源 + 多端复用                                           |
| Happy ghostty-web 协议设计文档              | MIT        | 终端多客户端同步的规格参考                                            |
| Orca `@orca/process-host` 思路              | MIT        | 进程树治理/退出证明                                                   |

## 9. 风险与坑（各仓库用血泪验证过的）

1. **Windows 终端**：ConPTY 预热、.cmd 引号、进程树击杀、隐藏控制台窗口——Orca 专门有 wsl-guest 和 native 插件；AgentsRoom 40+ 版在修终端
2. **会话恢复只有 7 家 CLI 真正支持**；其它只能"新会话+喂 transcript"（AgentsRoom 的诚实做法：界面标注差异）
3. **prompt 约束不可靠**：read-only 必须落到 flag/工具缺失（v1.171.0 事故）
4. **上游死亡**：VK 停运教训——选 Apache/MIT 依赖，准备接盘
5. **配额换算不可知**：Anthropic 不公布 5h 窗口百分比公式，只能监控不能预测（AgentsRoom 的态度：不知道就不编）
6. **agent 改测试把红改绿**：check 以退出码为准，先于启动写好

## 10. 差异化机会（相对 AgentsRoom 的空白）

1. **开源 + 本地优先**（AgentsRoom 闭源、账号服务器在 OVH；Local Mode 只是选项）——Happy/Paseo 证明开源能拿到 24k★
2. **中文生态/本土 provider**：Qwen Code、Kimi、GLM/ZCode、MiniMax——AgentsRoom 支持但体验面向欧美；文档、角色、记忆全中文化
3. **非 Electron 路线的轻量版**：Herdr 式 daemon + 任意 UI，或 VK 式 npx 一键启动
4. **把 quota 自动化做成开源标配**（AgentsRoom 35+ 版打磨的闭源功能）
5. **AI-native 审查**：AgentsRoom 的审查仍是人读 diff；可做"review agent + 结构化批注回传"的自动化闭环（Orca 已有雏形）

## 11. 留给项目所有者的未决问题

1. 桌面框架最终拍板（本报告建议 Electron；若团队有 Rust 偏好，Jean 证明 Tauri 可行但 Windows 需补课）
2. MVP 的 provider 范围（建议 Claude+Codex 起步，是否要第一天就含本土 CLI？）
3. 是否做账号/云侧（决定 E2E relay 与 mobile 的优先级；纯本地则 P4 可无限期推迟）
4. 商业意图（开源引流 vs 直接商业化——影响许可证选择与"是否抄 VK 的 npx 分发"）
