# 02 · 技术实现细节（从官方文档逆向）

> 文档站真实地址：https://agentsroom.dev/docs（226 页，全量可从 `/llms-full.txt` 下载；documentation.agentsroom.dev 是 502 的旧壳）
> 本文件回答"如果复刻，每个子系统怎么做"——全部条目带出处。

## a) 进程管理：如何启动并管理 agent CLI

- **从不捆绑二进制**：agent = 第三方 CLI（claude/codex/grok/agy…14+ 提供商 + Ollama 等目录提供商），从 PATH 检测后用**引导脚本在真实终端里启动**；CLI 缺失则不启动并给安装卡片（`/docs/cli-doctor.md`）
- **自研终端（AgentsRoom owns the terminal）**：不用外部终端模拟器，自带 **GPU 渲染器**（Settings > Terminal > GPU acceleration）；MCP 的 `commands_list` 返回 `completedPtyIds/runningPtyIds` → 底层是 **PTY**（`/docs/terminal-environment.md`、`/docs/agentsroom-mcp.md`）
- **会话恢复**：布局快照持续落盘（每次变更后最多 15 秒），重启后重 spawn 进程并续接对话；仅 **7 个 CLI 能真正重开自己的会话**（Claude Code、Codex、Grok、Antigravity、Cursor、Kimi Code、oh-my-pi——走各自会话文件/resume 标志；oh-my-pi 由 AgentsRoom 指定会话文件、Cursor 从其 chat 目录读会话 id、Codex 跳过子 agent 会话文件）；换模型保留对话，换 provider 才新开（`/docs/restore-session.md`）
- 多账号隔离：每账号独立 HOME 目录（`CODEX_HOME`、`GROK_HOME`、`CURSOR_CONFIG_DIR`），Claude 用 profile（`/docs/multi-account.md`）

## b) 状态推断：怎么知道 agent 在干嘛

- **UI 四态** Working/Done/Needs input/Idle；**底层 API 枚举** `offline/starting/idle/busy/waiting_input/blocked/rate_limited/degraded/failed`
- **三通道融合**（FAQ 原话："Status is detected from the terminal stream of each CLI (tool calls, file writes, prompts, completion) with per-provider rules"）：
  1. 终端输出流解析（每提供商一套规则）
  2. CLI 原生 status hooks（仅 Claude Code、Grok Build、Cursor、OpenCode 有；首轮对话后才证明生效）
  3. `agents_report_status` MCP 工具（agent 自报进度/阻塞）
- **未用 stream-json**：全部文档未出现 `--output-format json` 字样——它选择了"全兼容 PTY + 解析"而非"结构化输出"
- **turn 级 API**：每个回答有 `turnId/turnState(working→ended)/turnStartedAt/turnEndedAt/lastTurnFiles(≤500 文件路径)`，ended 在回答结束约 1 秒内切换；纯轮询（1 秒粒度），无事件流（`/docs/local-status-api.md`）

## c) 数据存储：三层

| 层         | 位置                                                                                                                                                                                            | 内容                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 本地       | app data 目录（可用 `AGENTSROOM_DATA_DIR` 迁移）+ `~/.agentsroom/`（local-api.json、mcp-host 令牌）+ 项目内 `.agentsroom/`（project.json 含项目 id 会提交进仓库；memory/ 是 markdown 只读镜像） | 配置、布局、会话令牌                                                                                                                        |
| 账号服务器 | OVH（欧盟）                                                                                                                                                                                     | backlog/memory/团队/统计；分"传输加密"与"at-rest 加密"（assistant 记忆、项目 memory、服务器凭据、Cloud Agents 令牌）两档；每晚 dump 留 4 份 |
| E2E relay  | 多区域                                                                                                                                                                                          | 只见密文和匿名 room id（见 e 节）                                                                                                           |

- **project memory 实现**：markdown 笔记两根目录 `features/`（每 feature 一条）+ `global/`，wiki-link 互联，60 天不碰变淡；服务端每项目一把密钥 at-rest 加密；本地只读镜像供 grep；版本历史留 50 版（`/docs/project-memory.md`）
- **decisions**：backlog 票上的结构化附件（选项+推荐+决策人）（`/docs/decisions.md`）
- Codex 每个 project×account 生成独立 `CODEX_HOME`（会话/日志/图片，默认 90 天轮转）（`/docs/codex-data-storage.md`）

## d) AgentsRoom MCP：把 IDE 暴露给 agent

- **注入方式**：每个 agent 启动时按各 CLI 配置格式写入（Claude `.mcp.json`、Codex 生成的 CODEX_HOME、Cursor `.cursor/mcp.json`）
- **呈现**：AgentsRoom-MCP 主服务器 + AgentsRoom-Browser(QA) + Test-Runner + QA-Tester；**约 155 个工具、25 个家族**（backlog/memory/mail/agents/teams/ssh/databases/kubernetes/secrets/triggers/qa…）
- **Shared 模式**：全机一个后台 Node 进程走 127.0.0.1 HTTP + 每 console 独立 session token（旧方式每 console 4-5 个 Node 进程约 140MB）
- **读写礼仪**：读免确认、写需明确请求、删除必须点名；**agent 不能改自己配置/关自己**
- 工具可按家族/单个关闭并改写 description（`/docs/agentsroom-mcp.md`、`/docs/agentsroom-tools-settings.md`）

## e) E2E 加密 relay：手机/多机/Chrome 的统一传输层

- **密码学**：X25519 换钥 + XSalsa20-Poly1305 加密；relay 只见密文和匿名 room id
- **部署**：多区域 relay，桌面自动选最近；`relayWsUrl` 可换（可自建）
- **Remote Fleet**：同账号机器经 relay 互相发现（纯出站连接，无 VPN/无端口转发），远端机器本地 spawn agent 并回传终端流——**代码不移动**
- **设备配对**：两端 8 字符配对码；批准设备按各自密钥免问重连（`/docs/mobile-desktop-sync.md`、`/docs/remote-fleet.md`）
- 账号体系：邮箱密码 + Google/Apple/Microsoft/GitHub OAuth；桌面可匿名（数据留本机）；Local Mode 可让 backlog+memory 完全离线（`/docs/local-mode.md`）

## f) Cloud Agents：云上跑任务

- 一次 run = 一次性 job：临时机器（**Fly.io**）从 git remote 克隆 → headless 跑 Claude Code 或 Codex → commit 推专用分支 → 写报告 → **自毁**
- 本机可关机，**git 是汇合点**；结束时三选一：取分支/云端重跑/本地接手（上下文已填好）
- 凭证三类：agent automation token、git host 令牌、Fly 令牌；回复超时默认 15 分钟自动推送关机（`/docs/cloud-agents.md`）

## g) persona / permissions / hooks

- **persona**：≤约 6000 字符直接写进 CLI 的 system prompt（每轮重发，抗压缩）；超长部分写入文件让 agent 用文件读取工具打开并在每次 compaction 后重读；Minimal system prompt 开关 = 只留 CLI 本身 + 项目规则(CLAUDE.md/AGENTS.md) + 标题所需（`/docs/customize-agents.md`）
- **Autonomous 模式 = 传各 CLI 自己的 bypass 旗标**（17 个 CLI 各有映射）：Claude `--dangerously-skip-permissions`、Codex `--sandbox danger-full-access -a never`、Grok `--always-approve`、oh-my-pi `--yolo`…Claude 另有 4 个预答开关（bypass 警告/文件夹信任/删除检查/账号邮箱检查）；用户自己的 permissions.ask/deny 规则和 hook 不被触碰（`/docs/agent-permissions.md`）
- **与原生配置的关系**：默认不改你的 `.mcp.json`（preserveMcpJson 可完全不写）；可合并 `claude mcp add` 的个人配置（`/docs/mcp-servers.md`）

## h) Agent Messaging：agent 互发邮件的完整协议

- **存投分离**：消息先落项目邮箱再投递（离线/崩溃/重启不丢）
- **投递时机**：等收件人空闲间隙（思考中/等答复/你在打字都 hold，打字后 30 秒-10 分钟防混入）
- **已读语义**：终端里只落短通知（发件人+主题+预览），agent 调 `agents_read_inbox` 读正文才算已读
- **状态链**：Queued→Delivered→Read→Accepted/Declined→Answered
- **防循环**：默认 12 条/30 收件人每 10 分钟（Coordinator 36/90）；同主题未答复 1 小时内禁重发；单会话默认 12 条上限且 **80% 处强制 checkpoint**（state/decisions/evidence/blockers/nextAction）
- `agents_recover` 让 coordinator 可 Esc 打断或重启卡死队友；消息可跨项目、跨机器（经 fleet relay，`relayed:true`）、跨人（服务器明文暂存 ≤14 天）（`/docs/agent-messaging.md`）

## i) Electron 分发链（从 GitHub org 逆向）

> AgentsRoomDev 是 **GitHub 用户账号（非 org）**，7 个公开仓库，桌面应用本体闭源。

- **确认 Electron**：electron-builder 打包（dmg/exe/AppImage/deb 全矩阵，自托管 agentsroom.dev/downloads）+ electron-updater/Squirrel.Mac（`latest-mac.yml` feed，含 `com.agentsroom.desktop.ShipIt`）+ Homebrew cask `:electron_builder` livecheck
- macOS 公证 + `brew install --cask agentsroomdev/tap/agentsroom`；winget 分发筹备中；发布节奏极快（latest-mac.yml 当前 1.271.0，2026-11-14 当天即有发布）
- **electron-mcp-for-agentsroom**（npm `electron-mcp-server`，MIT，与应用同版本线）：基于 **CDP** 的零侵入 Electron 控制器——目标应用以 `--remote-debugging-port=N` 启动即可；60KB CDP client，无 Playwright 不打包浏览器；17 个 MCP 工具（Observe: screenshot/dom_query/console_logs/get_state/get_route/list_targets/switch_target；Interact: click/type/press_key/navigate/scroll/wait_for_selector；Assert: assert_text/assert_visible/assert_count/assert_route）；技术栈 @modelcontextprotocol/sdk + chrome-remote-interface + zod + tsup。**复刻项目可直接复用**
- **running-performance-coach**（MIT 模板仓库）揭示 agent 生态三层格式：①persona 系统提示 ②CLAUDE.md 操作契约 ③trigger 提示模板；trigger 机制 = webhook 端点 + HMAC-SHA256 签名头（对原始字节签名），未签名拒绝
- **agency-agents**（fork）表明生态兼容 Claude Code subagent markdown 格式（安装到 `~/.claude/agents/`）

## 文档未公开的点（复刻时需自行决策）

- 终端底层库名（xterm.js/node-pty 等未写明，只确认自研 GPU 渲染器 + PTY）
- 各 CLI 终端流解析规则细节（正则/锚点）
- 本地是否用 SQLite 等数据库引擎
- relay 的 WebSocket 消息格式
- Claude status hooks 具体注册为哪些 hook 事件
- 所用 Electron 大版本、UI 框架（React/Vue）
