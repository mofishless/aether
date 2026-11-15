import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// P1-01 Codex 驾驶舱全旅程 E2E（对照 cockpit.spec.ts 风格；需先 pnpm build）。
//
// 旅程：临时 git 仓库 → mock codex 引擎（fixtures/aether-mock-cli codex-server 包装器，
// AETHER_AGENT_CLI_PATH 注入 cliPath 覆盖）→ UI 选 Codex provider（恢复能力差异标注
// 可见，协议定案 §5 差异表）→ 新建项目/任务 → 启动 agent（P1-01 评审 F2 接线：
// agents.spawn 载荷显式 providerKind=codex-app-server 驱动 daemon 路由——本剧本
// 不再用 AETHER_AGENT_PROVIDER_KIND env 覆盖缝；该缝保留给 daemon 集成测试）→
// running 中途态（慢速 fixture 5000ms 挂起窗口）→ 审批服务端请求弹层 →
// 批准（{id,result:{decision:"accept"}} 应答链）→ 完成消息可见 → 跟问同 thread 新 turn。
//
// 与 claude 剧本的关键差异（协议定案 §3/§7）：codex app-server 是长活服务端——
// turn/completed 不发终态、会话在完成消息后保持 running（终态归 cancel 后的退出
// 证明），故本剧本以完成消息与 follow-up 续流收口，不断言 stopped。
const appDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appDir, "..", "..");
const mockCliDir = path.join(repoRoot, "fixtures", "aether-mock-cli");
type ElectronLaunchOptions = Parameters<typeof _electron.launch>[0];

/** 在 cwd 执行 git（任意失败直接抛出——仓库准备是旅程前提，不静默重试） */
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** 建临时 git 仓库：mkdtemp 基座下 repo 子目录（init -b main + user/gpgsign 配置 + 首提交）。 */
function createTempRepo(): string {
  const base = mkdtempSync(path.join(tmpdir(), "aether-codex-cockpit-"));
  const repo = path.join(base, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "e2e@aether.local");
  git(repo, "config", "user.name", "Aether E2E");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(repo, "README.md"), "# codex cockpit e2e\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "init");
  return repo;
}

/** mock codex 引擎平台包装器：win32=codex-server.cmd；POSIX=codex-server.sh（运行时补执行位）。 */
function mockCodexWrapper(): string {
  const wrapper = path.join(
    mockCliDir,
    process.platform === "win32" ? "codex-server.cmd" : "codex-server.sh",
  );
  if (process.platform !== "win32") {
    chmodSync(wrapper, 0o755);
  }
  return wrapper;
}

/**
 * 启动选项：mock codex 注入链 = E2E env → 主进程 env 透传（spawnDaemon 继承
 * process.env）→ daemon（cliPathOverride；provider 路由走 agents.spawn 显式
 * providerKind 入参，P1-01 评审 F2）→ codex 引擎子进程（AETHER_MOCK_SCRIPT 选
 * codex-app-server fixture）。
 */
function codexLaunchOptions(repoRootPath: string, fixtureFile: string): ElectronLaunchOptions {
  return {
    args: [appDir],
    env: {
      ...process.env,
      AETHER_AGENT_CLI_PATH: mockCodexWrapper(),
      AETHER_MOCK_SCRIPT: path.join(mockCliDir, "fixtures", fixtureFile),
      AETHER_DAEMON_DB_PATH: path.join(path.dirname(repoRootPath), "aether.db"),
    },
    ...(process.env.CI && process.platform === "linux" ? { chromiumSandbox: false } : {}),
  };
}

test("codex 全旅程：provider 恢复标注 → 启动 → running 中途态 → 审批批准 → 完成消息 → 跟问续流", async () => {
  // CI 慢机预算：含 daemon spawn、worktree 创建、5000ms 慢速窗口、审批往返与两轮 RPC
  test.setTimeout(120_000);
  const repo = createTempRepo();
  const app: ElectronApplication = await _electron.launch(
    codexLaunchOptions(repo, "codex-happy-path-slow.json"),
  );
  const window: Page = await app.firstWindow();

  try {
    // ① daemon 就绪（连接徽标 = 类型化通道活着）
    await expect(window.locator('[data-testid="connection-badge"]')).toHaveText("已连接", {
      timeout: 30_000,
    });

    // ② 选 Codex provider → 恢复能力差异标注可见（协议定案 §5 差异表的 UI 静态映射）
    await window.locator('[data-testid="spawn-provider-option-codex-app-server"]').check();
    await expect(window.locator('[data-testid="spawn-provider-label"]')).toHaveText(
      "Codex app-server",
    );
    // F7 限定语口径：徽标带"入口随 P3-01 落地"（与渲染层单测同文案，不放话）
    await expect(window.locator('[data-testid="provider-capabilities"]')).toContainText(
      "支持会话恢复（thread/resume，入口随 P3-01 落地）",
    );
    await expect(window.locator('[data-testid="provider-capabilities"]')).toContainText(
      "运行中会话：支持 rejoin（重新接入并收后续事件）",
    );

    // ③ 新建项目 + 任务
    await window.locator('[data-testid="project-name-input"]').fill("codex-cockpit-e2e");
    await window.locator('[data-testid="project-root-input"]').fill(repo);
    await window.locator('[data-testid="project-create-button"]').click();
    await expect(window.locator('[data-testid="project-item"]')).toHaveText(/codex-cockpit-e2e/, {
      timeout: 15_000,
    });
    await window.locator('[data-testid="task-title-input"]').fill("Codex 驾驶舱旅程任务");
    await window.locator('[data-testid="task-create-button"]').click();
    await expect(window.locator('[data-testid="task-item"]')).toHaveText(/Codex 驾驶舱旅程任务/, {
      timeout: 15_000,
    });

    // ④ 启动 agent（P1-01 评审 F2：spawn 载荷显式 providerKind=codex-app-server 驱动
    //    daemon 路由；agent 卡片 provider 标签 = "Codex app-server"，旅程走通本身即
    //    codex 引擎真被拉起的证明——claude-sdk 路由下 mock codex 引擎不会被 spawn）
    await window.locator('[data-testid="spawn-prompt-input"]').fill("请完成 mock codex 任务");
    await window.locator('[data-testid="spawn-button"]').click();
    await expect(window.locator('[data-testid="agent-card"]')).toBeVisible({ timeout: 30_000 });
    await expect(window.locator('[data-testid="agent-provider-kind"]')).toHaveText(
      "Codex app-server",
      { timeout: 15_000 },
    );

    // ⑤ running 中途态：turn/started 已置位 running，慢速 fixture 首条 agentMessage 的
    //    5000ms 挂起窗口内状态点稳定可测
    await expect(window.locator('[data-testid="agent-status"]')).toHaveText("running", {
      timeout: 30_000,
    });

    // ⑥ 审批服务端请求 → permission 弹层（等待应答期间 waiting 态稳定可观测）
    const prompt = window.locator('[data-testid="permission-prompt"]');
    await expect(prompt).toBeVisible({ timeout: 30_000 });
    await expect(window.locator('[data-testid="agent-status"]')).toHaveText("waiting", {
      timeout: 15_000,
    });

    // ⑦ 点批准 → {decision:"accept"} 应答 → 弹层消失 → mock 续放 → 完成消息可见
    //    （codex 长活服务端：turn 完成后会话保持 running，完成以消息内容为证）
    await window.locator('[data-testid="permission-approve"]').click();
    await expect(prompt).toBeHidden({ timeout: 15_000 });
    await expect(
      window.locator('[data-testid="activity-event"][data-event-type="message"]', {
        hasText: "mock：任务完成",
      }),
    ).toBeVisible({ timeout: 30_000 });

    // ⑧ 跟问一条消息 → 同 thread 新 turn（fixture turns 耗尽 → 缺省回放）→ 新 message
    const messages = window.locator('[data-testid="activity-event"][data-event-type="message"]');
    const before = await messages.count();
    await window.locator('[data-testid="follow-up-input"]').fill("继续下一步");
    await window.locator('[data-testid="follow-up-send"]').click();
    await expect(messages).toHaveCount(before + 1, { timeout: 30_000 });
  } finally {
    await app.close().catch(() => undefined);
  }
});
