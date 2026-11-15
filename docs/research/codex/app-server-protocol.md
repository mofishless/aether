# Codex app-server 协议定案（P1-01 权威输入）

> 状态：定案（2026-11-15）。本文档合并三源证据，作为 `packages/adapters/codex` 实现的唯一协议权威。
> 与 TASK_LIST P1-01、SYSTEM_DESIGN §6.2（AgentAdapter 端口）配套阅读。

## 0. 证据等级与来源

| 源                 | 内容                                                                                               | 可信度                              |
| ------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 官方 schema 生成物 | 本机 codex 0.169.0 `codex app-server generate-json-schema` 产出（schema/ 39 文件 + ts/ 100+ 类型） | wire 结构权威，但滞后于真实线上形状 |
| 本机实测 wire      | 0.169.0 手工 spawn 对话实测                                                                        | 帧形状/字段名实证                   |
| T3 生产实现侦察    | pingdotgg/t3code 的 effect-codex-app-server（60k★ 生产应用，锁 codex 0.166.0）                     | 生产时序/容错细节权威               |
| 上游源码语义       | openai/codex main + rust-v0.169.0 源码核对（2026-11-15；协议 schema 钉 commit 687a119f）           | 门控/语义/演进风险权威              |

版本事实：本机 0.169.0（2026-11-13 发布）方法面与 main 一致；v1 会话方法（newConversation / sendUserTurn / interruptConversation / resumeConversation）已从 ClientRequest **完全移除**，仅剩 4 个无命名空间遗留方法 + 2 个 DEPRECATED 审批请求。适配器只能走 v2 thread/turn 协议。

## 1. 传输与信封

- 子命令：`codex app-server`（默认 `--listen stdio://`；CLI help 标注 `[experimental]`）。
- stdio 上为 **LDJSON**：每行一个 JSON 对象，写出侧行尾 `\n`；读取侧须剥离行尾 `\r` 容错（Windows CRLF）。
- **非标准 JSON-RPC**：线上没有 `jsonrpc: "2.0"` 键（rpc.rs 注释明示"不发送也不期望"）。四种消息形状：

```
请求       {"id": 1, "method": "...", "params": {...}}          // id 可为字符串或整数
通知       {"method": "...", "params": {...}, "emittedAtMs": 123}  // 无 id；本机实测带 emittedAtMs
成功响应   {"id": 1, "result": {...}}
错误响应   {"id": 1, "error": {"code": -32602, "message": "...", "data": {...}}}
```

- 错误码：`-32600` invalid request（含 `Not initialized`、`serverShuttingDown{data.reason}`、实验门控拒绝）、`-32601` method not found、`-32602` invalid params、`-32603` internal、`-32001` overloaded。
- 字段命名总体 camelCase，**两个已知蛇形例外**：`UserInput.text.text_elements`、v1 ReviewDecision 枚举值（见 §9 陷阱）。

## 2. 启动与握手

### 2.1 进程 spawn（Windows 定案）

- 裸 spawn `codex.cmd` 在 node 24 是 **EINVAL**（CVE-2024-27980）。本机已验证的正确链路：
  - 读 `codex.cmd` 内容得真实入口：`node D:/Data/nodejs/node_modules/@openai/codex/bin/codex.js app-server`；
  - 或 T3 方案：`shell: true` + `escapeWindowsShellArg`（对整条命令行做两步转义）。
- `CODEX_HOME`：设置时目录**必须已存在**且为目录，否则启动报错；字面 `~` 会被拒（不会展开）。默认 `~/.codex`。
- 登录态（auth.json）不阻塞启动；推理请求才因认证失败报 error。判断登录态用 `account/read`（`getAuthStatus` 属 v1 遗留且 PAT 会话不返回 bearer token）。

### 2.2 握手时序

```
client → initialize {clientInfo:{name,title?,version}, capabilities:{experimentalApi:true}}
client → initialized {}（通知；服务端当前仅记日志，非硬性，礼貌发送）
server → {id, result:{userAgent, codexHome, platformFamily, platformOs}}
```

- **initialize 是唯一免检方法**：完成前任何其他请求返回 `-32600 "Not initialized"`。
- **`capabilities.experimentalApi: true` 必须声明**：否则 `thread/start.approvalPolicy`、`thread/start.permissions`、`thread/resume.path`、`turn/start` 部分字段等会以 `-32600 "<reason> requires experimentalApi capability"` 拒绝——Aether 定案固定声明 true，未知实验字段以容忍姿态透传（见 §10）。

## 3. 会话生命周期（thread / turn / item 三层）

```
thread/start → {thread:{id: UUIDv7, ...}, model, sandbox, ...}
turn/start {threadId, input:[UserInput]} → {turn: Turn}
  通知流：turn/started → item/started → (delta…) → item/completed → … → turn/completed
turn/interrupt {threadId, turnId} → {}   // 中断结果经 turn/completed(status=interrupted) 体现
```

### 3.1 turn/start 关键语义

- `UserInput` tagged union（`type` 字段）：`text` / `image` / `localImage` / `audio` / `localAudio` / `skill` / `mention`。Aether 首期只用 `{type:"text", text}`。
- **text 变体的 `text_elements` 是蛇形且必填数组**（serde default 仅省略时生效，显式传 `null` 会失败）——构造时省略即可。
- 对活动中的 turn 发 `turn/start` 会被**转为 steer 语义**（turnTrigger 等字段被忽略）。显式插话用 `turn/steer {threadId, input, expectedTurnId}`（乐观并发：不匹配当前活动 turn 则失败）。适配器应靠 `turn/completed` 或 `thread/status/changed` 确认空闲再发新 turn。
- `turn/start` 可逐 turn 覆盖 `sandboxPolicy` / `approvalPolicy`（后者 exp 门控）。

### 3.2 Turn / ThreadItem 形状

- `Turn = {id: UUIDv7, rootTurnId, items: [ThreadItem], status: 'completed'|'interrupted'|'failed'|'inProgress', error: TurnError|null, startedAt, completedAt, durationMs}`。
- `turn/started` 与 `turn/completed` 的 payload 同构（内嵌完整 Turn+items）。
- `ThreadItem` tagged union 核心变体：`agentMessage` / `reasoning` / `plan` / `commandExecution` / `fileChange` / `mcpToolCall` / `webSearch` / `errorContext` / `userMessage`。
- 增量通知族（不重复全 item）：`item/agentMessage/delta`、`item/plan/delta`、`item/reasoning/summaryTextDelta`、`item/commandExecution/outputDelta`、`item/fileChange/outputDelta` 等，载荷 `{threadId, turnId, itemId, delta: string}`。
- `error` 通知：`{error:{message, codexErrorInfo, additionalDetails, misalignment}, willRetry: bool, threadId, turnId}`——**willRetry=true 表示瞬时错误自动重试，不打断 turn**。
- thread 级通知：`thread/status/changed`（`{threadId, status:{type:'notLoaded'|'idle'|'systemError'|'active'}}`）、`thread/closed`（thread 被卸载，收到后不能再对该 thread 发 turn）、`thread/tokenUsage/updated`（计费/用量）、`deprecationNotice`（官方弃用通道，适配器应监听记录）。

## 4. 审批（server→client 请求，双向 RPC）

服务端发**带 id 的请求**，客户端必须以 `{"id": ..., "result": {...}}` 应答（不是通知）。并发应答能力必须具备，否则阻塞 turn。

| v2 方法（现行）                         | 场景     | decision 值域 / 应答形状                                                                                                                                                  |
| --------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `item/commandExecution/requestApproval` | 命令执行 | `'accept'` \| `'acceptForSession'` \| `{acceptWithExecpolicyAmendment:{execpolicyAmendment:[...]}}` \| `{applyNetworkPolicyAmendment:{...}}` \| `'decline'` \| `'cancel'` |
| `item/fileChange/requestApproval`       | 文件写   | `'accept'` \| `'acceptForSession'` \| `'decline'` \| `'cancel'`                                                                                                           |
| `item/permissions/requestApproval`      | 权限扩展 | **应答形状特例（非 decision 字面量）**：`{permissions: GrantedPermissionProfile(必填), scope: 'turn'\|'session'(缺省 turn), strictAutoReview?}`（见下方 bullets）         |

- **decline ≠ cancel**：decline = 拒绝但 agent 继续 turn；cancel = 拒绝并**中断 turn**。
- **permissions 方法应答形状（官方 schema PermissionsRequestApprovalResponse，P1-01 评审 F1 定案）**：应答 = `{permissions: GrantedPermissionProfile(必填), scope: 'turn'|'session'(缺省 turn), strictAutoReview?}`；`GrantedPermissionProfile = {fileSystem: AdditionalFileSystemPermissions|null, network: AdditionalNetworkPermissions|null}`（全字段可空）——值域**没有 decline 字面量**：deny = 空授权 `{permissions: {fileSystem: null, network: null}, scope: 'turn'}`（唯一合法拒绝形状）；approve = 请求 `params.permissions` 原样回授（RequestPermissionProfile 与 GrantedPermissionProfile 同构：fileSystem/network 两键）。
- v1 遗留 `execCommandApproval` / `applyPatchApproval`（蛇形 ReviewDecision：`approved` / `approved_for_session` / `denied{rejection}` / `abort`…）已标 DEPRECATED——适配器以 v2 为主，v1 仅做兜底容错识别。
- 审批超时由服务端处理（TimedOut 按 Decline 处理）。
- Aether 映射定案：`allow→accept`、`always→acceptForSession`、`deny→decline`（commandExecution/fileChange 的 `{decision: <值>}` 应答）；permissions 方法按上一条 bullet 的授予形状应答。

## 5. 恢复（thread/resume）与 fork

- `thread/resume {threadId, excludeTurns?, cwd?, model?, …}`；默认响应**内嵌 thread.turns 全量历史**；分页线程推荐 `excludeTurns: true` + 游标（`turnsBackwardsCursor` / `itemsBackwardsCursor`）+ `thread/turns/list` / `thread/items/list` 分页拉取。
- thread id 来源：`thread/start`/`thread/fork` 响应、`thread/started` 通知、`thread/list`（可按 cwd / 时间 / currentAccountOnly 过滤；includedThreadIds/excludedThreadIds 各上限 100）。
- 对**正在运行的 thread**，resume 语义是 rejoin（重新接入并收后续事件），不是重放。
- `thread/fork {threadId, lastTurnId?}`：从任意 turn 处分叉成**新 thread**（新 id）。
- 未登录/令牌过期时 resume 本身可成功，输入类请求被拒（interrupt 仍可用）。

### 与 Claude --resume 的差异（UI 标注依据）

| 维度                             | Claude (SDK)                       | Codex (app-server)                      |
| -------------------------------- | ---------------------------------- | --------------------------------------- |
| 恢复目标                         | CLI 参数选会话（`Options.resume`） | RPC 字段（`threadId`），一等参数        |
| 历史水合                         | SDK 内部                           | 响应内嵌 turns / 游标分页，客户端自己拼 |
| 运行中会话                       | 不支持 rejoin                      | rejoin 语义                             |
| canResume（AdapterCapabilities） | true（P0-07 定案）                 | **true**                                |

## 6. autonomy → 双维映射

Aether 单一 autonomy 枚举映射到 Codex 二元组：

| Aether autonomy | sandbox              | approvalPolicy |
| --------------- | -------------------- | -------------- |
| read_only       | `read-only`          | `untrusted`    |
| workspace_write | `workspace-write`    | `on-request`   |
| auto            | `danger-full-access` | `never`        |

- `sandbox` 值域：`'read-only' | 'workspace-write' | 'danger-full-access'`；`approvalPolicy` 值域：`'untrusted' | 'on-request' | 'never' | {granular:{...}}`（exp 门控）。
- sandbox 与 `permissions` 字段互斥（同传报错）——Aether 只用 sandbox 维度。

## 7. 进程治理与停机

- **stdio 单客户端模式：stdin EOF 即服务端退出**——适配器崩溃关闭管道会连带杀掉服务端与运行中 thread。优雅退出须保持 stdin 打开至收到最终状态。
- SIGTERM 有 45 秒关闭期限；优雅停机期间新请求返回 `-32600 data.reason='serverShuttingDown'`。
- T3 生产参数（Aether 采纳）：启动 `-c thread_unload_delay_secs=0`（thread 即用即卸，防内存膨胀）；stdin EOF 后 **250ms 宽限**再判死；stderr tail 保留 **8KB** 摘录入诊断；通知缓冲 32 条 sliding queue（慢消费不丢整流——不能假设零丢失，靠 item/completed 全量帧兜底对账）。
- 进程治理复用 `@aether/process-host`（树杀 / ExitProof 语义与 claude adapter 一致）。

## 8. 版本漂移与兼容策略

- 协议在 main 上高频演进（ClientRequest 110+ 方法、ServerNotification 88 个），历史上发生过 v1→v2 破坏性换代。T3 锁 0.166.0；协议 schema 钉 commit 687a119f。
- Aether 策略：
  1. **方法白名单 + 未知方法容忍**：帧路由只认白名单方法，未知 method 静默忽略并计数（不崩、不丢整流）。
  2. **契约测试从当机二进制取 schema**：集成测试可跑 `codex app-server generate-json-schema` 校验目标版本的 wire 契约。
  3. mock 回放引擎按本文档帧形状构造，不依赖真 codex（CI 零外部依赖）。
  4. 真机冒烟（本机 0.169.0）只跑关键路径，不进 CI。

## 9. 实现陷阱清单（必读）

1. `text_elements` 蛇形 + 必填数组：构造 text 输入时**省略**该字段，勿传 null。
2. `experimentalApi: true` 不声明 → approvalPolicy/sandbox 等常用字段随机被拒（错误是 -32600 不是 -32602，易误诊）。
3. 帧路由四分支（request/notification/response/error）都必须处理；`{"id","result"}` 与 `{"id","error"}` 靠键判别（无 jsonrpc 键可依赖）。
4. 服务端请求（审批）与客户端请求的 id 空间独立；应答必须回传原 id。
5. 活动 turn 中发 turn/start 变 steer（字段被忽略）——发新 turn 前确认 turn/completed 已到。
6. 通知 `emittedAtMs` 可作为事件时间戳来源，但 P0-11 已定案事件去重键 = eventId@occurredAt 复合——codex 侧 eventId 映射见 §10。
7. `thread/closed` 后不能再对该 thread 发 turn（daemon 重启/workspace 切换场景）。
8. v1 审批 decision 是蛇形（`approved` 系），与 v2 camelCase 混存——解析层分开。
9. `-32600` 的 data 里可能带 `serverShuttingDown{reason}`，属正常停机非故障。
10. Windows：spawn 链见 §2.1；CODEX_HOME 必须预创建。

## 10. Aether 实现决策定案

| 决策点                        | 定案                                                                                                                                                                                                                                     | 依据                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 传输客户端                    | 自研 JSONL RPC（读行→剥 \r→JSON.parse→四分支路由），不引 SDK                                                                                                                                                                             | codex 无官方 TS SDK；T3 同为自研                                       |
| 帧形状                        | 无 jsonrpc 键；id 字符串/整数皆可（内部统一 number 自增，应答回传原值）                                                                                                                                                                  | §1                                                                     |
| 握手                          | initialize（experimentalApi: true）→ initialized 通知，10s 超时                                                                                                                                                                          | §2.2                                                                   |
| 会话创建                      | thread/start（cwd = worktree 根；sandbox/approvalPolicy 由 autonomy 映射）                                                                                                                                                               | §6                                                                     |
| 用户输入                      | `{type:"text", text}`，省略 text_elements                                                                                                                                                                                                | §3.1                                                                   |
| ProviderEvent 归一            | agentMessage→message；commandExecution→tool_use+tool_result（started→usage, completed→result）；reasoning/plan→agent_reasoning（若 contracts 无对应类型则归入 message 附 kind 标注）；error 通知→error 事件（willRetry=false 才置 fail） | 对照 P0-07 SDKMessage 归一                                             |
| eventId 映射                  | notification: `{method}:{threadId}:{itemId                                                                                                                                                                                               | turnId}:{emittedAtMs}`；ServerRequest: `approval:{approvalId\|itemId}` | P0-11 去重键约束 |
| 审批                          | v2 三个 requestApproval 为主，v1 两个 DEPRECATED 兜底识别；allow→accept / always→acceptForSession / deny→decline                                                                                                                         | §4                                                                     |
| 取消                          | turn/interrupt（非 v1 interruptConversation）                                                                                                                                                                                            | §3                                                                     |
| 续聊                          | 同 thread 新 turn/start（codex 天然多轮）；followUpAtMessage 如实 false（thread/fork 可达但语义是分叉新会话，不符）                                                                                                                      | §5                                                                     |
| 恢复                          | thread/resume {threadId}（excludeTurns: false 默认全量水合）；canResume: true                                                                                                                                                            | §5                                                                     |
| 退出                          | cancel 时 turn/interrupt + 等 turn/completed（≤5s）→ 关 stdin → killTree 兜底；EOF 后 250ms 宽限                                                                                                                                         | §7                                                                     |
| AdapterCapabilities.protocols | `["codex-app-server"]`；permissionFlags 按审批类型枚举                                                                                                                                                                                   | contracts ProviderKind                                                 |

## 11. 参考实现对照

- T3 effect-codex-app-server（npm）：帧路由、sliding queue、Windows shell:true 方案、错误六类型分类。
- 上游源码锚点（openai/codex）：`codex-rs/app-server-protocol/src/rpc.rs`（信封）、`protocol/v2/{thread,turn,item,permissions}.rs`（方法语义）、`app-server/src/message_processor.rs`（initialize/experimentalApi 门控）、`app-server-transport/src/transport/stdio.rs`（LDJSON/45s）、`app-server/src/error_code.rs`（错误码表）、`schema/typescript/`（112 ClientRequest / 88 ServerNotification / 10 ServerRequest 全表）。
