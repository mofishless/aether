# aether-mock-cli（P0-07b；codex 引擎 P1-01 支撑件）

scripted 回放 mock CLI：读 fixture 脚本，按序向 stdout 回放 **Claude stream-json 事件流**或 **Codex JSON-RPC 响应**（形状中性），写完按脚本声明的退出码退出。另有第二入口 **codex 引擎**：按 `docs/research/codex/app-server-protocol.md` 定案的 **codex app-server 协议模拟器**（有状态 thread/turn/item 回放，供 P1-01 适配器与 E2E 用）。零 npm 依赖、零构建步骤（纯 Node ESM），让适配器与状态机在**无真实 CLI、无网络**的条件下跑完完整任务旅程。同一套 fixture 供 P0-09（日志管道）/ P0-12（验收 E2E）复用。

## 运行形态

```sh
# 直接运行（调试）
AETHER_MOCK_SCRIPT=fixtures/aether-mock-cli/fixtures/happy-path.json \
  node fixtures/aether-mock-cli/cli.mjs

# codex 引擎（P1-01 支撑件）
AETHER_MOCK_SCRIPT=fixtures/aether-mock-cli/fixtures/codex-happy-path.json \
  node fixtures/aether-mock-cli/codex-server.mjs
```

适配器侧标准用法（见 `packages/adapters/claude/tests/mock-cli-adapter.test.ts`）：

1. `createClaudeAdapter` 的 `cfg.config.cliPath` 指向本目录**平台包装器**——SDK（`pathToClaudeCodeExecutable`）会直接 spawn 它并附加自己的参数（`--output-format stream-json --verbose --input-format stream-json --resume <id>` 等），mock 对未知 flag 一律宽容忽略；
2. `ctx.env.AETHER_MOCK_SCRIPT` 指向 fixture 脚本（适配器把 `ctx.env` 叠加进子进程环境）。

codex 适配器（P1-01）同理：`cliPath` 指向 `codex-server.cmd` / `codex-server.sh`，`AETHER_MOCK_SCRIPT` 指向 `protocol: "codex-app-server"` 的 fixture。

### 平台包装器与平台选择

| 平台    | 包装器（cli / codex-server）   | 说明                                                                                                                                                    |
| ------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | `cli.cmd` / `codex-server.cmd` | 单行 `@node "%~dp0<入口>.mjs" %*`；经 process-host `spawnCommand` 的 `.cmd` 安全转义（cmd.exe `/d /s /c` + quoteWindowsArg）执行——端到端复验 P0-06 路径 |
| POSIX   | `cli.sh` / `codex-server.sh`   | `exec node "$(dirname "$0")/<入口>.mjs" "$@"`；**git 检出不带执行位**，测试/使用前 `chmod +x`（测试的 `beforeAll` 已运行时补）                          |

测试按 `process.platform === "win32" ? "<名>.cmd" : "<名>.sh"` 选择。

## 环境变量

| 变量                                | 必需 | 适用入口         | 说明                                                                                                            |
| ----------------------------------- | ---- | ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `AETHER_MOCK_SCRIPT`                | 是   | 两者             | fixture 脚本文件路径；缺失/不可读 → 退出码 64                                                                   |
| `AETHER_MOCK_STDIN_GATE`            | 否   | cli.mjs          | `0` 关闭 stdin 门控（默认开启：等第一条 stdin 行再回放，配合 SDK 先写 initialize 控制请求的时序；手工调试可关） |
| `AETHER_MOCK_PERM_TIMEOUT_MS`       | 否   | cli.mjs          | `can_use_tool` 等应答超时（默认 30000；超时按 `timeout` 回填并继续回放）                                        |
| `AETHER_MOCK_CODEX_PERM_TIMEOUT_MS` | 否   | codex-server.mjs | 审批请求等待超时（默认 30000；超时按 `decline` 处理——协议 §4 TimedOut 语义）                                    |

## fixture 脚本格式

顶层（手工校验、中文报错，校验失败 → 退出码 65）：

```jsonc
{
  "protocol": "claude-stream-json", // 或 "codex-json-rpc"
  "exitCode": 0, // 0..255，默认 0
  "description": "…", // 可选说明
  "events": [], // claude 用；codex 用 "responses"
}
```

### claude-stream-json 事件条目

数组每项是**裸帧对象**（原样 JSONL 回放到 stdout）或 `{ "delayMs": 5, "emit": { …帧… } }` 包装（`delayMs` 默认 0，测试建议 0-5ms）。帧形状对齐 `@anthropic-ai/claude-agent-sdk@0.3.325` stream-json：`system/init`（含 `session_id`）、`assistant`（text / tool_use content 块）、`user`（tool_result）、`result/success` 等——样本见 `packages/adapters/claude/src/normalize.ts` 与 `tests/adapter.test.ts`。

控制协议行为（与 SDK stdio 传输对齐）：

- **stdin 门控**：SDK 以 `--input-format stream-json` 先写 `initialize` 控制请求与 prompt，mock 等第一条 stdin 行（或 stdin 关闭）再回放；
- **SDK→CLI `control_request`**（`initialize` 等）：一律自动回 `control_response`（`subtype: "success"`，`request_id` 原样回显）——不应答会让 SDK 初始化承诺挂死；
- **CLI→SDK `control_request(can_use_tool)`**（脚本帧）：写出后阻塞等 stdin 上匹配 `request_id` 的 `control_response`（即 SDK `canUseTool` 桥/适配器 `resolvePermission` 的应答），决策写入 `$MOCK_LAST_PERM`。

token 替换（发出时求值，可嵌在任意字符串字段里）：

| token             | 展开为                                                       |
| ----------------- | ------------------------------------------------------------ |
| `$MOCK_ARGV`      | mock 收到的 argv（空格连接；断言 `--resume` 用）             |
| `$MOCK_LAST_PERM` | 最近一次权限决策 behavior（`allow`/`deny`/`timeout`/`none`） |

### codex-json-rpc 响应条目

```jsonc
{ "responses": [{ "method": "initialize", "result": { "…": "…" }, "delayMs": 0 }] }
```

stdin 逐行读 JSON-RPC 请求，**method 匹配优先、按序兜底**（未声明 `method` 的条目按消费顺序补位），响应 `{jsonrpc, id, result}` 或 `{jsonrpc, id, error}` 写 stdout；无可配响应则静默跳过；stdin EOF 后按 `exitCode` 退出。

## fixture 清单

| 文件                         | 旅程                                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `happy-path.json`            | init → assistant 文本 → tool_use → tool_result → result success（code 0）                                                                                                  |
| `follow-up.json`             | init（复用 `ext-mock-happy`）→ assistant 回显 `$MOCK_ARGV` → result（断言第二轮 spawn 带 `--resume`）                                                                      |
| `permission-ask.json`        | init → `can_use_tool` 控制请求 → assistant 回填 `$MOCK_LAST_PERM` → result                                                                                                 |
| `error-exit.json`            | 帧流自报 success 但 `exitCode=3`（验证适配器排序契约：退出证明先判非零 → error 事件）                                                                                      |
| `codex-neutral.json`         | Codex JSON-RPC 形状中性应答（`initialize` / `turn`；带 `jsonrpc` 键，旧引擎专用）                                                                                          |
| `codex-happy-path.json`      | codex 引擎全旅程：initialize → thread/start → turn/start（agentMessage 增量 + commandExecution + 一次审批请求）→ turn/completed；附 `resume` 段（thread-1 跨进程恢复历史） |
| `codex-happy-path-slow.json` | codex 全旅程慢速副本：首条 agentMessage 前置 5000ms 延时（UI 稳定观测 running 中途态用，对照 claude `happy-path-slow.json`）；其余旅程同上                                 |

## codex 引擎（P1-01 支撑件）

入口 `codex-server.mjs` + 引擎 `lib/codex-server-engine.mjs`：**有状态 codex app-server 协议模拟器**，帧形状唯一规范是 `docs/research/codex/app-server-protocol.md`（三源定案）。与旧的形状中性回放（`lib/codex-replay.mjs`，帧带 `jsonrpc` 键）刻意分离——旧引擎服务既有 claude 测试，勿混用。

实现语义（对照协议定案章节）：

- **信封**：stdin JSONL 逐行（剥 `\r` 容错）；四分支帧路由（客户端请求 / 客户端通知 / 客户端应答 / 非法行丢弃）。写出侧**全部帧无 `jsonrpc` 键**；通知帧带 `emittedAtMs`，请求/响应帧回传请求原 id（§1）。
- **握手**：`initialize` 唯一免检（之前任何带 id 请求 → `-32600 "Not initialized"`）；未声明 `capabilities.experimentalApi:true` 时 initialize 仍成功，但 `thread/start` 携带 `approvalPolicy`/`sandbox`/`permissions` → `-32600 "<field> requires experimentalApi capability"`（§9 陷阱 2 的真实门控，非 -32602）；`initialized` 通知仅日志（§2.2）。
- **生命周期**：`thread/start` → `thread-<n>` 自增；`turn/start` → 先应答 `{turn: Turn(inProgress)}` 再发通知流 `turn/started → item/started → (delta…) → item/completed → … → turn/completed`（§3）；活动 turn 中再发 `turn/start` → `-32602`（mock 不实现 steer，逼适配器等 `turn/completed`，§9 陷阱 5）。
- **审批**：fixture 条目声明 `approval` 即在该 item 处发服务端带 id 请求 `item/commandExecution/requestApproval`，等客户端 `{id,result:{decision}}`：accept 系/修订案对象 → 继续回放；`decline` → 拒绝该 item 但 turn 继续；`cancel` → 拒绝并 `turn/completed(status=interrupted)`；超时按 `decline`（§4 TimedOut）。
- **中断**：`turn/interrupt` → `{id,result:{}}` 应答；活动回放任务随后发 `turn/completed(status=interrupted)`（含审批等待中的 turn——挂起审批按 cancel 唤醒）。
- **恢复**：`thread/resume {threadId}` → 同进程已完成 turn 内存记录优先；无记录回退 `resume` 段声明的历史（跨进程恢复素材）；两者皆无 → 空 turns（§5）。
- **退出**：stdin EOF → 中止挂起审批与回放任务（不再写帧），按脚本 `exitCode` 干净退出（§7）；未知方法 → `-32601`。

fixture 格式（`protocol: "codex-app-server"`，手工校验中文报错，失败 → 退出码 65）：

```jsonc
{
  "protocol": "codex-app-server",
  "exitCode": 0,
  "initialize": {
    /* 可选：initialize 应答四字段覆盖（userAgent/codexHome/platformFamily/platformOs）*/
  },
  "turns": [
    /* 每个 turn/start 按序消费一项；耗尽后用最小缺省 turn */
    {
      "delayMs": 1, // turn/started 前延时（帧级延时机制保留）
      "items": [
        { "type": "agentMessage", "text": "…", "deltas": 2, "delayMs": 1 }, // 均分 N 段增量
        {
          "type": "commandExecution",
          "command": "echo aether",
          "cwd": "…",
          "exitCode": 0,
          "output": "aether",
          "approval": { "reason": "…" },
          "delayMs": 1,
        }, // 声明 approval 即发审批请求
      ],
    },
  ],
  "resume": { "threadId": "thread-1", "turns": [/* Turn 全量历史（跨进程 resume 素材）*/] },
}
```

协议未定字段的 mock 选择（自洽约定，适配器侧按此断言）：item 对象内嵌 `id`（`item-<n>`）；增量通知载荷 `{threadId, turnId, itemId, delta}`；审批请求 `id` 为字符串 `req-<n>`，`params.call` 携带 `{command, cwd?}`。

### 自测（node:test，零依赖）

```sh
node --test fixtures/aether-mock-cli/tests/codex-server.test.mjs
```

覆盖：握手门控（Not initialized / experimentalApi 陷阱 2）、全旅程帧序（无 jsonrpc 键 / emittedAtMs / id 回传）、审批三分支（accept/decline/cancel）、turn/interrupt、thread/resume（跨进程回退 + 同进程内存优先）、未知方法、EOF 干净退出、fixture 校验负例、平台包装器冒烟。注意：fixtures 目录不在根 vitest include 内，此自测不进 `pnpm test`——接入 CI 由 P1-01 建 `packages/adapters/codex` 时迁移（见任务报告 risks）。

## 引用本目录的测试

- `packages/adapters/claude/tests/mock-cli.test.ts`——回放断言（fixture 脚本 → 期望 stdout 事件序列 + 归一化 ProviderEvent 序列 + 退出码/校验报错）；
- `packages/adapters/claude/tests/mock-cli-adapter.test.ts`——经真实 SDK `query()` + process-host 治理 spawn 的全旅程（事件序列 / 状态机 fold / ExitProof / `--resume` follow-up / 权限往返 / 非零退出）；
- `fixtures/aether-mock-cli/tests/codex-server.test.mjs`——codex 引擎自测（node:test，见上节）。
