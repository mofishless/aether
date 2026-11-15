# aether-mock-cli（P0-07b）

scripted 回放 mock CLI：读 fixture 脚本，按序向 stdout 回放 **Claude stream-json 事件流**或 **Codex JSON-RPC 响应**（形状中性），写完按脚本声明的退出码退出。零 npm 依赖、零构建步骤（纯 Node ESM），让适配器与状态机在**无真实 CLI、无网络**的条件下跑完完整任务旅程。同一套 fixture 供 P0-09（日志管道）/ P0-12（验收 E2E）复用。

## 运行形态

```sh
# 直接运行（调试）
AETHER_MOCK_SCRIPT=fixtures/aether-mock-cli/fixtures/happy-path.json \
  node fixtures/aether-mock-cli/cli.mjs
```

适配器侧标准用法（见 `packages/adapters/claude/tests/mock-cli-adapter.test.ts`）：

1. `createClaudeAdapter` 的 `cfg.config.cliPath` 指向本目录**平台包装器**——SDK（`pathToClaudeCodeExecutable`）会直接 spawn 它并附加自己的参数（`--output-format stream-json --verbose --input-format stream-json --resume <id>` 等），mock 对未知 flag 一律宽容忽略；
2. `ctx.env.AETHER_MOCK_SCRIPT` 指向 fixture 脚本（适配器把 `ctx.env` 叠加进子进程环境）。

### 平台包装器与平台选择

| 平台    | 包装器    | 说明                                                                                                                                                 |
| ------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | `cli.cmd` | 单行 `@node "%~dp0cli.mjs" %*`；经 process-host `spawnCommand` 的 `.cmd` 安全转义（cmd.exe `/d /s /c` + quoteWindowsArg）执行——端到端复验 P0-06 路径 |
| POSIX   | `cli.sh`  | `exec node "$(dirname "$0")/cli.mjs" "$@"`；**git 检出不带执行位**，测试/使用前 `chmod +x`（测试的 `beforeAll` 已运行时补）                          |

测试按 `process.platform === "win32" ? "cli.cmd" : "cli.sh"` 选择。

## 环境变量

| 变量                          | 必需 | 说明                                                                                                            |
| ----------------------------- | ---- | --------------------------------------------------------------------------------------------------------------- |
| `AETHER_MOCK_SCRIPT`          | 是   | fixture 脚本文件路径；缺失/不可读 → 退出码 64                                                                   |
| `AETHER_MOCK_STDIN_GATE`      | 否   | `0` 关闭 stdin 门控（默认开启：等第一条 stdin 行再回放，配合 SDK 先写 initialize 控制请求的时序；手工调试可关） |
| `AETHER_MOCK_PERM_TIMEOUT_MS` | 否   | `can_use_tool` 等应答超时（默认 30000；超时按 `timeout` 回填并继续回放）                                        |

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

| 文件                  | 旅程                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `happy-path.json`     | init → assistant 文本 → tool_use → tool_result → result success（code 0）                             |
| `follow-up.json`      | init（复用 `ext-mock-happy`）→ assistant 回显 `$MOCK_ARGV` → result（断言第二轮 spawn 带 `--resume`） |
| `permission-ask.json` | init → `can_use_tool` 控制请求 → assistant 回填 `$MOCK_LAST_PERM` → result                            |
| `error-exit.json`     | 帧流自报 success 但 `exitCode=3`（验证适配器排序契约：退出证明先判非零 → error 事件）                 |
| `codex-neutral.json`  | Codex JSON-RPC 形状中性应答（`initialize` / `turn`）                                                  |

## P1-01 扩展位

Codex 模式当前是**形状中性回放**：只做「请求 method → 脚本化响应」的管道，不实现真实 Codex app-server 语义。P1-01（Codex app-server 适配器）实测协议后：

- 在 `fixtures/*.json` 补充真实方法名与响应形状（`responses[].method` 语义化命名）；
- 如需请求参数敏感的应答（按 `params` 分支）或有状态往返，在 `lib/codex-replay.mjs` 扩展匹配策略——引擎的 readline/背压/token 基建（`lib/runtime.mjs`）可直接复用。

## 引用本目录的测试

- `packages/adapters/claude/tests/mock-cli.test.ts`——回放断言（fixture 脚本 → 期望 stdout 事件序列 + 归一化 ProviderEvent 序列 + 退出码/校验报错）；
- `packages/adapters/claude/tests/mock-cli-adapter.test.ts`——经真实 SDK `query()` + process-host 治理 spawn 的全旅程（事件序列 / 状态机 fold / ExitProof / `--resume` follow-up / 权限往返 / 非零退出）。
