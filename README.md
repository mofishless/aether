# Aether

**本地优先的多 agent 编排驾驶舱** —— 在一个桌面应用里，为多个项目并行驱动多个 coding agent（Claude Code / Codex / 自定义端点），每个 agent 在独立 git worktree 中工作，可观察、可审查、可续聊。

> Local-first multi-agent orchestration cockpit. Electron + TypeScript, pure local, no accounts, no cloud.

## 设计公理（继承自 AgentsRoom 调研，前六条）

1. **不做模型代理**：复用你已付费的 CLI 订阅或自有 API key，Aether 只从 PATH 检测并 spawn 真实进程。
2. **执行权归 daemon**：独立 daemon 子进程拥有全部执行（agent / Git / PTY / 存储）；Electron 主进程零领域逻辑。
3. **每 agent 一个 git worktree**：主 checkout 永远干净，diff 审查天然隔离。
4. **agent 接入分层**：SDK（L1）/ 专有协议（L2）/ 自定义端点（L3），统一 `AgentAdapter` 接口。
5. **IDE 能力经 MCP 反向开放给 agent**（P1 起）：backlog / terminal / memory。
6. **可靠性第一**：树杀无孤儿、日志先原样落库、崩溃可恢复。

调研全文见 [docs/research/agentsroom/](docs/research/agentsroom/README.md)。

## 项目状态

P0 骨架开发中（任务分解见 [docs/TASK_LIST.md](docs/TASK_LIST.md)）。

| 文档                                           | 内容                     |
| ---------------------------------------------- | ------------------------ |
| [docs/PRD.md](docs/PRD.md)                     | 产品需求与四期里程碑     |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)   | 架构与 ADR 登记          |
| [docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md) | 系统设计（接口唯一权威） |
| [docs/TECH_STACK.md](docs/TECH_STACK.md)       | 技术选型定案             |
| [docs/TASK_LIST.md](docs/TASK_LIST.md)         | P0-P3 任务卡             |

## 开发

要求：Node ≥ 22.5（`node:sqlite`）、pnpm ≥ 11。

```bash
pnpm install          # 安装依赖
pnpm test             # vitest 单元/集成测试
pnpm lint             # oxlint + oxfmt --check
pnpm typecheck        # tsc --noEmit（全仓）
pnpm dev              # 启动 Electron 壳（开发热载）
pnpm build            # 构建桌面应用
pnpm test:e2e         # Playwright Electron 冒烟
pnpm spike:node-sqlite  # 验证 node:sqlite @ ELECTRON_RUN_AS_NODE
```

## 仓库结构

```
apps/
  desktop/        # Electron 壳：主进程（零领域逻辑）+ 渲染进程
  daemon/         # 独立 daemon：RPC 入口，组装全部领域包（P0-03 建）
packages/         # contracts / core / adapters / terminal / storage / process-host（按任务增量创建）
fixtures/         # 测试夹具（aether-mock-cli 等，非 workspace 包）
docs/             # 调研与规划文档
```

## License

[MIT](LICENSE)
