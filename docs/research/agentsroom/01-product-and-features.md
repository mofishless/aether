# 01 · 产品定位与功能全景

> 来源：https://agentsroom.dev/features（103 张功能卡全量枚举）+ 首页
> 页面自称：`AgentsRoom: your team of AI agents, for code and beyond. The agent development environment (ADE)`

## 定位

- **形态**：macOS/Linux/Windows 桌面应用（Electron，闭源），法国/欧洲团队（"Made in France and Europe"），可下载或浏览器内免费试用（Try in your browser）
- **核心场景**：一个窗口并行驾驶多项目 × 多 agent（19 家 provider CLI：Claude、Codex、GitHub Copilot CLI、OpenCode、Antigravity、Aider、Grok Build、Mistral Vibe、Kimi Code、Amp、oh-my-pi、Freebuff、Devin、Cursor、Command Code、Muse Code、Pi、MiniMax Code、ZCode）
- **规模数据**（首页 2026-11-14）：30 天内 230,403 次 agent 启动、1,282 用户、20 种 CLI 在用——Claude 72%、Codex 19%、Antigravity 3%、OpenCode 2%

## 贯穿全部功能的机制词汇（技术信号）

| 机制                                                                                       | 出现处            |
| ------------------------------------------------------------------------------------------ | ----------------- |
| spawn 真实系统进程（"spawns a real system process for every tool call"）                   | 全局              |
| end-to-end encrypted relay（手机/Remote Fleet/Chrome 控制/跨机接续共 6+ 处）               | Anywhere 类       |
| OS keychain 本地加密保险库（"no code path returns a value to an agent"）                   | Secret manager    |
| 数据库连接默认 read-only + SSH 隧道 / AWS SSM / Cloud SQL Auth Proxy 走 127.0.0.1          | DB connections    |
| 直接读 `~/.claude/projects/` JSONL 算 token 用量                                           | Token usage       |
| git worktree per agent（项目 `.worktrees/` 目录）                                          | Git worktrees     |
| `--add-dir` / `--effort` 等 CLI 原生旗标注入配置                                           | Linked folders 等 |
| `CODEX_HOME` / `GROK_HOME` / `CURSOR_CONFIG_DIR` 目录隔离多账号                            | Multi-account     |
| MCP（4 个 AgentsRoom MCP server + Browser MCP + agent delegation 单工具）                  | Dev environment   |
| unlisted gist（gist.agentsroom.dev）存 commit 对话史                                       | Commit Context    |
| **注意：全页未出现 ACP 协议字样**——跨 CLI 互操作走 MCP + 各 CLI 原生旗标/环境变量/转录文件 | —                 |

## 功能全清单（103 项 · 六大类）

### 01 Orchestration（27 项）

| 功能                                                        | 机制                                                                                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 多项目多 agent 一窗口                                       | 网格驾驶舱，色标角色 + 状态点，并行驱动 19 种 CLI                                                                                   |
| Idea Radar                                                  | 支持消息/反馈聚簇去重按主题计数；主题/影响-effort 矩阵/机会树/语义图四种读法，成熟想法转 backlog 票                                 |
| 拖卡即启 agent（backlog 看板）                              | Kanban 拖卡到 Development 列即启动 agent；每列可配 prompt 成流水线                                                                  |
| Public backlog                                              | backlog 暴露为公开/私有反馈门户（widget + Chrome 扩展），客户提交的票直接进同一条 backlog                                           |
| Ticket scoping                                              | 一键从反馈票 spawn PM agent 读代码库生成 mockup，双向对话澄清，不启动任务不发通知                                                   |
| Agent Teams                                                 | n8n 式画布编排 Dev/QA/PM/Security/DevOps 节点，条件边 + 反馈环 + max-cycles 守卫；单 agent morph 换角色 或 每角色一个活 agent 互聊  |
| Agent messaging                                             | 每个 agent 有真实地址和收件箱，跨 CLI 互发；消息先落盘再投递（不丢）、带回执、忙则排队                                              |
| Agent Morphing                                              | 同一会话内热切换角色（PM→Dev→QA），14 内置角色，保留全量上下文，带 morph 轨迹和 fresh-eyes 评审                                     |
| Fork agent                                                  | 一键复制运行中 agent 会话；Claude/Codex/Grok 用 CLI 自带 fork，其它 CLI 新起会话喂父级 transcript（界面标注差异）                   |
| Customize agents                                            | 14 内置角色 + The Agency 专家 + 自建角色（自定义 system prompt），聊天一拖分享/发布社区，全 19 CLI 生效                             |
| Agent suggestions                                           | 按任务描述从本房间/内置/260+ 目录专家推荐 agent，附理由一键添加                                                                     |
| Scheduled tasks                                             | 免 cron 表达式定时（每N分钟/每天多时刻/按配额窗口），错过补跑，历史可重开                                                           |
| Webhook triggers                                            | 公开 URL + 签名密钥，验签/过滤/限流，payload 成 prompt 变量；app 关闭时排队重放，多机单接单                                         |
| Mission interview                                           | "New mission" 助手一次一问访谈到明确 done 条件，边谈边生成任务页按序启动                                                            |
| Agent delegation                                            | dev agent 调一个 MCP 工具把验证交给临时 QA agent（便宜模型），QA 驱动内嵌浏览器断言 pass/fail，不污染 dev 上下文                    |
| Resume terminal sessions                                    | 列出文件夹近 30 天终端启动的 CLI 会话，用 CLI 自带 resume 接续全部历史（手机也可）                                                  |
| Git worktrees                                               | 每 agent 独立 checkout/分支于 `.worktrees/`；启动前自动拷 `.env`、按 lockfile 装依赖；Changes 页 diff/commit/push，票 Done 并回分支 |
| Compare coding agents                                       | 同一任务发 2-4 个 CLI/模型各干一个 worktree（主 checkout 不动），卡片显示文件/行数/耗时 + 全量 diff，"Keep this one" 合并           |
| Linked folders                                              | 一项目链多文件夹/仓库；支持的 CLI 经 `--add-dir` 注入，其它写进 brief                                                               |
| Non-coding workspaces                                       | 只凭名字 + mission + agent 建工作区，无需 git 仓库                                                                                  |
| Non-dev mode                                                | 首问"我不是开发者"切助手房间：Lead assistant + 7 助手 + 17 业务角色                                                                 |
| Linear / Jira / GitHub / Azure DevOps / YouTrack / 通用导入 | 各自 API/token 连接，选择-预览-导入为 backlog 票，全部只读不写回                                                                    |

### 02 Communication（19 项）

| 功能                 | 机制                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| Side questions       | 对"只读会话副本"提问，流式回答不打断工作不动原历史；每 agent 最多 5 tab，默认更快模型                    |
| Agent reply language | 设一次回复语言，所有 agent 无论输入语言都用它回答                                                        |
| Sketch               | composer 内置画布，白板画 mockup 或截图圈注，图片随消息发给 agent                                        |
| Screenshot to agent  | 快捷键（默认 Cmd+Opt+Shift+P）框选屏幕直接附消息，不落盘                                                 |
| Voice dictation      | 按录音时长选转写模型，21 语言 + 自动检测；手机端识别 on-device，文本经 relay 到桌面                      |
| Voice Mode           | 双向语音对话跑 AgentsRoom 后端（STT 进 TTS 出），免提持续监听，兼容全部 CLI                              |
| Read Aloud           | 内置 TTS 读 markdown/终端选中/上一条回答（从 transcript 取而非屏幕抓取），代码块先剥离；可先 AI 摘要再读 |
| Message queue        | 消息按序逐条发送，每条 AI 起短标题，可拖拽重排；消息可挂时钟或订阅配额周期                               |
| Clarifying questions | agent 需决策时弹可点击选项卡片（含义/多选/mockup 对比/自由输入），agent 等待而非猜测；锁屏可答           |
| Mobile companion     | 手机变遥控器，E2E relay 口述 prompt/传文件；系统分享截图发 agent 或存 backlog；关机的 agent 自动启动     |
| Personal assistant   | 账号级助手，Siri/Action 按钮/Android widget 唤起，跑你现有 CLI + 你的 MCP 连接器；每天新会话可选私有记忆 |
| Prompt library       | 按项目分文件夹组织 prompt，git 共享团队，个人自动 gitignore                                              |
| Skills library       | 保存 Claude SKILL.md 技能，挂任务/agent，按需导出到 Cursor/Codex/Windsurf/Aider                          |
| Project memory       | agent 写决策/架构/坑/惯例（memory_save），跨会话存活，项目内所有 agent 共读                              |
| Obsidian vault sync  | vault 文件夹与项目记忆互通，Markdown + [[links]] 双向回流，冲突留给人                                    |
| Scratchpad           | 钉在 footer 的长 prompt 编辑器，草稿退出仍在                                                             |
| Prompt enhancer      | 六字草稿一键扩成 Goal/Context/Constraints/Done-when 正式 prompt，带项目记忆上下文                        |
| Linked prompts       | prompt 引用其它 prompt，发送时解析链条合成完整 brief                                                     |
| Figma to AI agents   | Chrome 扩展从 Figma 画布取 frame 拖给票/prompt，图片+文字意图传递，不依赖 Figma MCP                      |

### 03 Monitoring（16 项）

| 功能                    | 机制                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| Split view              | iTerm2 式多窗格分屏，布局重开精确还原                                                                        |
| Conversation view       | 会话切聊天视图，**读 CLI 写在磁盘上的 transcript**（7 家 CLI 支持）；CLI 底层继续跑                          |
| Agent status tracking   | 色码状态点（黄=思考/绿=完成/红=等输入）+ 实时耗时与当前动作                                                  |
| Dynamic island          | 置顶悬浮岛显示各 agent 状态，app 在后台也在                                                                  |
| Context drift detection | 每回合末 agent 写一行金丝雀状态；连续两回合不更新=上下文腐烂早期信号，预警 + 一键干净重启                    |
| Process Guard           | 每分钟扫描 agent 子进程，"大+老+CPU 空闲"三条件才判卡死；实测案例 7 个卡死进程占 41.8GB                      |
| Keep awake              | agent 工作/传输时扣住系统睡眠，屏幕照常熄灭                                                                  |
| Pause agents            | 项目级暂停=每 agent 完成本回合才停；长暂停让 agent 写 resume 摘要后轻量重启                                  |
| Adaptive Mode           | 发送前读每条消息选性价比模型（翻译→Haiku，深重构→Opus）；部分 CLI 免重启切换                                 |
| Reasoning effort        | 按 CLI 注入原生旗标：Claude `--effort`、Codex `model_reasoning_effort`、Kimi `KIMI_MODEL_THINKING_EFFORT` 等 |
| Default model           | 四级优先级：agent/票/team step > 项目 > Settings > CLI 默认                                                  |
| Agent notifications     | IM 式未读角标（按项目/按 agent）+ 桌面/手机推送                                                              |
| Claude Code token usage | 每 Claude 终端实时 token 表；全部本地直读 `~/.claude/projects/` JSONL                                        |
| Project statistics      | 活跃时长/agent 数/prompt 数/token 与成本，按日图 + 按 agent 分解                                             |
| Usage limit alerts      | 读 11 家 CLI 公布的配额条（会话/周/按模型），跨所有已登录账号，过阈值桌面+手机通知                           |
| Claude 5-hour limit     | "Quota kick-off"：设定时刻用最便宜模型发首条消息踢开 5 小时窗口                                              |

### 04 Review & quality（8 项）

| 功能               | 机制                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Commit Context     | commit 背后完整 agent 会话传 unlisted gist（脱敏 secrets），message 加 `ia-agents-conversation-history` 链接           |
| AI commit messages | 读真实 git diff 生成 Conventional Commits 消息，项目级格式规则                                                         |
| Per-agent review   | 按 agent 过滤变更，隔离审查各自 diff，分开提交                                                                         |
| Browser automation | 每项目内置浏览器 + Browser MCP server；QA agent 导航/点击/输入/截图/读 console 自验（"no Playwright config to write"） |
| Plan review        | agent 计划以文档打开：选中段落评论/替换/加步骤，一键批准或要求修改；支持 4 家 CLI 的 plan mode                         |
| Mermaid diagrams   | 会话/Markdown/Plan Review/记忆/票里渲染 mermaid 图                                                                     |
| Agent artifacts    | agent 调 view_present 类工具在 composer 上方开产物面板，一键打开 HTML 仪表盘（"page stays a file on your computer"）   |
| Vibe coding review | 方向键逐文件浏览改动，并排高亮 diff，可就任何改动问 Claude                                                             |

### 05 Dev environment（19 项）

| 功能                   | 机制                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Localhost tunnel       | 内建免费 ngrok 替代，自定义子域公网 HTTPS                                                                                                     |
| Chrome control         | 扩展把每个 Chrome profile 变具名浏览器目标（各自 cookie），agent 按名操作；Chrome 可在另一台机器（经 relay E2E）；本身是 MCP server           |
| Dev terminals          | 每项目真实终端管理器，记住 backend/frontend/Docker 命令一键启动；可手机远程触发                                                               |
| Command palette        | Cmd K 单搜索框搜一切（agents/skills/prompts/定时/webhook/文件/commits）；"Nothing you type is sent to a server"                               |
| Restore session        | 退出勾选，次日恢复所有 agent、终端、dev server 和工作目录                                                                                     |
| AgentsRoom MCP         | 4 个 MCP server（Backlog/Terminal Commands/Prompt Library/Browser）把 IDE 暴露给所有 agent CLI                                                |
| SSH connections        | SSH 管理器 + 内建终端，远端机直跑 CLI；凭据留本机                                                                                             |
| Secret manager         | OS keychain 加密，单文件 owner-only 原子写入；agent 只能列名和请求注入，**无任何代码路径把值给 agent**                                        |
| Database connections   | MySQL/PG/SQLServer/Mongo/SQLite/BigQuery；**默认只读**，写需显式确认；单语句调用、拒绝堆叠、结果封顶；agent 经 MCP 按名查询，密码到不了 agent |
| RDS SSM tunnel         | `aws ssm start-session` 端口转发，授权来自本机 AWS profile，只绑 127.0.0.1                                                                    |
| Cloud SQL proxy        | 空闲回环端口起 cloud-sql-proxy，ADC 凭证免 service account key                                                                                |
| Network proxy          | 每 provider 独立代理，启动注入 HTTPS_PROXY 等；代理密码是对 Secret Manager 的引用                                                             |
| Agent permissions      | 每 CLI 选 Autonomous/Manual；Autonomous 用各 CLI 自带 bypass 旗标 + 代答 4 类 Claude 询问                                                     |
| MCP servers            | 声明一次全 agent 生效（全机/项目/单 agent 三级），启动时写进各 CLI 自己的配置文件；密钥放 Secret Manager                                      |
| Toolkit                | 打包 skills+MCP+SSH/DB/dev 命令连接+环境变量，按引用挂到 agent/票/team step/项目                                                              |
| Push notifications API | 一条 cURL 从 CI/cron 推手机；send-only 可吊销密钥                                                                                             |
| Developer email inbox  | 每项目一个收件地址收告警/cron 报告，可吊销                                                                                                    |
| CLI Doctor             | 记录确切命令与旗标来源，读 CLI 输出人话回答哪里坏；确定性检查不调 AI                                                                          |
| Import repositories    | 连 GitHub/GitLab 批量 clone 成项目；clone 凭据绝不写进 git config                                                                             |

### 06 Anywhere（14 项）

| 功能                                   | 机制                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Mobile desktop sync                    | 手机启动 agent/敲终端/发 prompt/看进度，E2E 加密实时同步                                             |
| Live Activities                        | iPhone 锁屏/灵动岛/Apple Watch/StandBy 一条实时活动；Face ID 后锁屏可答问题                          |
| Multi-provider                         | 19 家 provider 同项目混用，会话中途可换、自动 handoff 保上下文                                       |
| Claude/Codex/Grok/Cursor multi-account | 多账号并存；机制=每账号独立 HOME 目录（`GROK_HOME`、`CURSOR_CONFIG_DIR` 等），Settings 内直接 login  |
| Account auto-switch                    | 配额到阈值自动切换账号，同会话全上下文不重启；耗尽账号坐板凳，回血归队                               |
| Claude + Codex together                | 配额规则轮流分派新 agent；或按阈值动作（换 CLI/换轻模型/迁移运行中 agent）                           |
| Cloud agents                           | 云上一次性机器：clone→headless 跑→commit 推分支→写报告→自毁；汇合点是 git，本方可关机                |
| Remote Fleet                           | 多机链成统一视图，"Each machine keeps running its agents locally"，聚合状态/终端/项目                |
| Continue on another computer           | 右键 agent 选另一台电脑接续；Claude/Codex 精确恢复会话（含子 agent），其它 CLI 新会话读原 transcript |
| Machine pool                           | 项目配有序机器列表，新 agent 落到第一台"在线+有项目+预算内"的机器；每机设全局预算                    |
| Remote agent control                   | agent 跑在桌面自己的 CLI 里，手机做遥控：流式读终端/答权限/发指令/开隧道 dev server                  |

## 观察：功能背后的三个产品判断

1. **只读优先的安全哲学**：外部工单导入"绝不写回"、数据库默认只读、secret 无出径、命令面板不上传——一切外部集成先做成只读观察者。
2. **Quota 是一等公民**：19 项 Anywhere/Communication 功能里 8 项直接服务配额管理（监控/告警/kick-off/自动切换/轮流分派）。这是订阅制 CLI 时代的真实痛点，也是付费转化点。
3. **手机不是附件是第二主界面**：14 项 Anywhere + 多处"桌面+手机"标注；锁屏答题、系统分享、Live Activities 都是原生深度集成。
