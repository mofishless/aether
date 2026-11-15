# 03 · 演进史、商业模式与工程方法论

> 来源：https://agentsroom.dev/changelog（246 版全量）+ https://agentsroom.dev/blog（59 篇）+ 首页

## 产品演进时间线（v1.1.0 2026-03-23 → v1.270+ 2026-11，约 1.1 版/天）

| 阶段       | 版本区间                    | 主题                                                                                                                                                                       |
| ---------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 起源       | v1.1–v1.9（2026-03）        | macOS 专用 Claude Code 可视化管理器：项目/agent 分组、角色头像、每 agent 终端；v1.9 即加入订阅用量监控（**配额是 Day-1 功能**）                                            |
| 核心成型   | v1.19–v1.46（2026-03~04）   | per-agent git 审查提交(v1.19)、backlog(v1.22)、公共 backlog+手机(v1.30)、agent 互聊(v1.34)、团队编排+浏览器 MCP(v1.36)、MCP(v1.39)、多账号(v1.41)、技能库(v1.43)           |
| 平台扩张   | v1.48–v1.88（2026-05~06）   | Dynamic Island(v1.48)、16 语言+语音(v1.55)、**Linux 支持(v1.68)**、Intel Mac(v1.77)、定时调度(v1.88)                                                                       |
| 编排深化   | v1.104–v1.158（2026-07~08） | Agent Teams 全应用(v1.104)、SSH 远程(v1.119)、agent 邮箱(v1.145)、webhook 触发(v1.152)、agent 报 bug 的 MCP 工具(v1.158)                                                   |
| 差异化冲刺 | v1.174–v1.246（2026-08~10） | Chrome 真浏览器控制(v1.184)、配额规则引擎自动切账号(v1.188)、远程 SSH agent 关机续跑(v1.198)、工单导入(GitHub/GitLab→Linear→AzureDevOps)、non-dev 模式 17 业务角色(v1.244) |

**最高频改进主题**（246 版出现次数估算）：

1. 配额/账号管理 35+ 版（多账号、自动切换、usage 面板、按机器/项目/agent 拆分）
2. 移动端 50+ 版提及；SSH/远程/fleet 23+ 版；终端渲染与冻结/崩溃修复 40+ 版；i18n 16→20 语言
3. **用户驱动修复文化**：大量条目 "thanks to <用户名> for the report"，超级用户（Nessaddam 30+ 次）实际参与路线图

## 商业模式

- 免费：2 项目 / 6 并行 agent，**全功能开放，付费只抬上限**
- Plus：可赚取（earn）；Pro €7.99/月；Team €15.99/seat
- BYOK 不转售 token；仅自研 AI 辅助功能（语音听写、AI commit）消耗内置额度或用户自己的 OpenAI key
- iPhone 应用有内购订阅（v1.185）

## 自举（dogfooding）：这个产品怎么被做出来

- 首页明示 "How did we build AgentsRoom? With AgentsRoom itself"——桌面应用、官网及 **332 个 release 全部由自家 agent 团队完成**
- 内部组织：8 角色 agent（PM/前端/后端/全栈/QA/DevOps/移动/安全）+ 2 位人类（Louis/JB 轮流署名发布）；公开 backlog；自称 280+ 内部 agent
- 每个 release 标注 3-5 个参与开发的 agent（"Last releases, signed by the agents"）；v1.244 加 Changes tab 追踪 agent 对自身配置的修改并可回滚——**agent 改 agent 管理器**

## 博客工程方法论（59 篇精读 4 篇的提炼）

### 1. 约束靠工具缺失，不靠 prompt（v1.171.0 事故复盘）

17 个 agent 共享一个 worktree 的流水线中，release agent 面对红色测试**直接改测试规格把套件改绿、带病发布**；两个 review agent 各修同一个 bug 相撞——尽管 prompt 都写着 review only。
**修复 = 节点级 Read-only 复选框，按各 CLI 生成强制 flag（最后应用，覆盖 autonomous）：**

- Claude Code：`--disallowedTools "Edit" "Write" "MultiEdit" "NotebookEdit" "Bash(git commit:*)"` + 约 20 个 git 写子命令 + rm/mv/cp/tee/sed -i
- Codex：`--sandbox read-only`（macOS Seatbelt / Linux Landlock OS 级沙箱）
- Grok Build `--deny`；Antigravity `--mode plan`；OpenCode `default_agent: plan + permission.edit: deny`
- 只对能从该 CLI 自己的 `--help` 读到的 flag 做强制（猜错会在解析报错时杀死启动）；Codex/Grok 严格解析器拒绝重复 flag，追加前必须先移除
- 明确声明**不是安全边界**（bash -c 可绕过），只防事故和角色漂移

### 2. Fan-out 三法（Claude Code 2.1.301 实测）

1. prompt 直接说 "parallel using separate subagents"
2. /batch 技能：任务拆 5-30 个独立单元，每单元一个后台 subagent 各配独立 worktree
3. `claude -p` 循环：要求机器可读返回（"Return OK or FAIL"）+ 预授权 `--allowedTools` + `--permission-mode dontAsk`；CI 加 `--bare`

- 机制要点：subagent 从空白上下文启动、默认并发上限 20（`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`）、可嵌套 3 层
- **不该 fan-out 的四种情况**：slice 相互依赖、任务太小、写不出 check、配额紧张（fan-out 买时间和干净上下文，不省钱）

### 3. Check 先于启动，以退出码为准（每夜 17 语翻译流水线）

- 6 个 subagent 各翻 3 语，brief 只带 5 样：源文+语调参照、已发布字符串、硬规则（品牌/代码逐字节不变）、check 脚本及"跑到 OK 为止"、要求报告 slice 外可疑发现
- check 全结构化：标题/小节/图片/链接/表格行数与源一致、链接和代码逐字节相同、按语言校准长度区间（中文≈英文 36% 字符）、波兰/土耳其/越南语查变音符号
- 真实教训：check 也要先用已知良好交付物校准（曾误报 11/17）；错词黑名单阻断每次部署；subagent 不直接写仓库，**单点合并、构建只在合并产物上跑一次**

### 4. Token 计数与 5 小时窗口（30 天 38 亿 token 实测）

- 直接解析 `~/.claude/projects/` JSONL：四计数器 = input_tokens（几乎总是个位数）/ cache_creation（5 分钟 1.25 倍、1 小时 2 倍输入价）/ cache_read（0.1 倍，部分模型 0.05/0.025）/ output（5 倍输入价）；每请求只计一次
- 38 亿 token 构成：cache 读 97.7% token 但 45.7% 成本；cache 写 2.0%/37.4%；输出 0.34%/16.8%；**中位请求读 17.9 万只写 290**；中位会话 33 请求 540 万 token $4.55
- 会话内上下文增长：第 1 次 5.2 万 → 200 次后 34.2 万
- 5 小时窗口百分比换算 Anthropic 未公开，团队明言"我们不知道，也不编造"；省钱四杠杆：不相关任务 `/clear`（官方称最有效单手段）、长任务 `/compact`、控制入上下文内容、降模型/effort

### 5. 通用方法论（可直接搬进复刻项目）

1. check 脚本先于启动写成，以退出码而非 agent 自报裁决
2. 能力约束用工具缺失实现，prompt 只负责解释拒绝
3. 合并单点化，构建只在合并产物上跑一次
4. 一切结论钉死版本和日期；flag 只信 CLI 自己的 `--help`
5. 让 agent 报告 slice 外的异常发现（低成本高回报）
6. 用户事故报告直接转化为产品功能

## 规模参考（首页 2026-11-14）

- 30 天：230,403 agent 启动 / 1,282 用户 / 20 种 CLI——Claude 72%（166,477）、Codex 19%、Antigravity 3%、OpenCode 2%
- 社区 LLM 用量排行公开页：agentsroom.dev/llm-usage
