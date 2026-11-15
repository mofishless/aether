import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// P0-11 驾驶舱全旅程 E2E（任务卡 TDD 顺序第一项；此刻 daemon 侧 RPC 由并行线1开发，
// 本剧本先行落盘——gate 阶段合跑）。需先 pnpm build（daemon dist + desktop out）。
//
// 旅程：临时 git 仓库 → mock CLI（aether-mock-cli，经 AETHER_AGENT_CLI_PATH 注入）→
// UI 新建项目/任务 → 启动 agent → 活动事件流 → 终态 stopped → worktree 写文件 →
// diff 视图非空 → 跟问一条消息 → follow-up 回放响应事件。
//
// data-testid 约定（与 src/renderer/src/components/ 实现一一对应）：
//   project-item / project-name-input / project-root-input / project-create-button
//   task-item / task-title-input / task-create-button
//   spawn-prompt-input / spawn-button / agent-card / agent-status
//   tab-activity / tab-diff / activity-event（data-event-type=7 类 ProviderEvent 之一）
//   follow-up-input / follow-up-send
//   permission-prompt / permission-approve / permission-deny
//   diff-refresh / diff-file / diff-patch
const appDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appDir, "..", "..");
const mockCliDir = path.join(repoRoot, "fixtures", "aether-mock-cli");
type ElectronLaunchOptions = Parameters<typeof _electron.launch>[0];

/** 在 cwd 执行 git（任意失败直接抛出——仓库准备是旅程前提，不静默重试） */
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** 建临时 git 仓库：mkdtemp 基座下 repo 子目录（init -b main + user/gpgsign 配置 + 首提交）。
 *  配置为仓库本地（worktree 共享）——worktree 内提交无需重复配置。 */
function createTempRepo(): string {
  const base = mkdtempSync(path.join(tmpdir(), "aether-cockpit-"));
  const repo = path.join(base, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "e2e@aether.local");
  git(repo, "config", "user.name", "Aether E2E");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(repo, "README.md"), "# cockpit e2e\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "init");
  return repo;
}

/** mock CLI 平台包装器：win32=cli.cmd（process-host .cmd 转义链路）；POSIX=cli.sh（git 检出不带执行位，运行时补 chmod）。 */
function mockCliWrapper(): string {
  const wrapper = path.join(mockCliDir, process.platform === "win32" ? "cli.cmd" : "cli.sh");
  if (process.platform !== "win32") {
    chmodSync(wrapper, 0o755);
  }
  return wrapper;
}

/**
 * 启动选项：mock CLI 注入链 = E2E env → 主进程 env 透传（spawnDaemon 继承 process.env）→
 * daemon（线1读 AETHER_AGENT_CLI_PATH 为 cliPath）→ CLI 子进程（AETHER_MOCK_SCRIPT 选 fixture）。
 * AETHER_DAEMON_DB_PATH 指到临时目录：隔离测试库（launcher 缺省 userData/aether.db 是持久的）。
 */
function cockpitLaunchOptions(repoRootPath: string, fixtureFile: string): ElectronLaunchOptions {
  return {
    args: [appDir],
    env: {
      ...process.env,
      AETHER_AGENT_CLI_PATH: mockCliWrapper(),
      AETHER_MOCK_SCRIPT: path.join(mockCliDir, "fixtures", fixtureFile),
      AETHER_DAEMON_DB_PATH: path.join(path.dirname(repoRootPath), "aether.db"),
    },
    ...(process.env.CI && process.platform === "linux" ? { chromiumSandbox: false } : {}),
  };
}

/**
 * 找 worktree 目录：按 packages/core/src/worktree/paths.ts 布局约定，主基座 =
 * 项目根同级 .aether-worktrees/<name>/（临时仓库在专属 mkdtemp 目录内，基座必可用、
 * 唯一 workspace = 首个出现的子目录）。daemon 建树异步 → 轮询等待。
 */
async function findWorktreeDir(repoRootPath: string, timeoutMs: number): Promise<string> {
  const base = path.join(path.dirname(repoRootPath), ".aether-worktrees");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let entries: string[] = [];
    try {
      entries = readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(base, entry.name));
    } catch {
      // 基座尚未创建：继续轮询
    }
    if (entries.length > 0) return entries[0] as string;
    if (Date.now() > deadline) {
      throw new Error(`findWorktreeDir 超时 ${timeoutMs}ms：${base} 下未出现 worktree 目录`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** UI 建项目 + 建任务（两剧本共用前置） */
async function createProjectAndTask(window: Page, repoRootPath: string): Promise<void> {
  await window.locator('[data-testid="project-name-input"]').fill("cockpit-e2e");
  await window.locator('[data-testid="project-root-input"]').fill(repoRootPath);
  await window.locator('[data-testid="project-create-button"]').click();
  await expect(window.locator('[data-testid="project-item"]')).toHaveText(/cockpit-e2e/, {
    timeout: 15_000,
  });

  await window.locator('[data-testid="task-title-input"]').fill("驾驶舱旅程任务");
  await window.locator('[data-testid="task-create-button"]').click();
  await expect(window.locator('[data-testid="task-item"]')).toHaveText(/驾驶舱旅程任务/, {
    timeout: 15_000,
  });
}

test("全旅程：建项目/任务 → 启动 agent → 活动可观察 → diff 非空 → 跟问有响应", async () => {
  // CI 慢机预算（任务卡）：含 daemon spawn、worktree 创建、mock 回放与两轮 RPC 往返
  test.setTimeout(120_000);
  const repo = createTempRepo();
  const app: ElectronApplication = await _electron.launch(
    // 慢速副本：tool_use 帧前 5000ms 延时——message 先行到达置位 running，
    // 挂起窗口内 UI 可稳定观测 running 中途态（任务卡 TDD"观察到 running"逐字覆盖）
    cockpitLaunchOptions(repo, "happy-path-slow.json"),
  );
  const window: Page = await app.firstWindow();

  try {
    // ① daemon 就绪（连接徽标 = 类型化通道活着）
    await expect(window.locator('[data-testid="connection-badge"]')).toHaveText("已连接", {
      timeout: 30_000,
    });

    // ② 新建项目 + 任务
    await createProjectAndTask(window, repo);

    // ③ 启动 agent（prompt 一句话；agentProfileId 缺省走 daemon 种子默认 profile）
    await window.locator('[data-testid="spawn-prompt-input"]').fill("请完成 mock 任务");
    await window.locator('[data-testid="spawn-button"]').click();
    await expect(window.locator('[data-testid="agent-card"]')).toBeVisible({ timeout: 30_000 });

    // ④ 观察到 running（中途态断言，任务卡 TDD 原文步骤）：message 事件已置位
    //    running，慢速 fixture 的 5000ms 挂起窗口内状态点稳定可测
    await expect(window.locator('[data-testid="agent-status"]')).toHaveText("running", {
      timeout: 30_000,
    });

    // ⑤ 活动可观察：mock 回放事件流入活动视图（message 气泡 + tool_use 工具行）
    //    → 回放收尾 → 终态 stopped
    await expect(
      window.locator('[data-testid="activity-event"][data-event-type="message"]'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      window.locator('[data-testid="activity-event"][data-event-type="tool_use"]'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(window.locator('[data-testid="agent-status"]')).toHaveText("stopped", {
      timeout: 30_000,
    });

    // ⑤ E2E Node 侧向 worktree 写新文件并提交（路径发现按 worktree/paths.ts 布局约定；
    //    diff 口径 = 三点 diff 只见分支已提交变更——任务卡定案，未提交改动 P0 不可见）
    const worktree = await findWorktreeDir(repo, 30_000);
    writeFileSync(path.join(worktree, "cockpit-e2e.md"), "# 驾驶舱 E2E 新文件\n");
    git(worktree, "add", ".");
    git(worktree, "commit", "-m", "cockpit-e2e agent 产出");

    // ⑥ diff 视图：unified 单栏显示该文件（非空 patch）。
    //    断言口径：git 对新增行的前缀是单个 "+"（内容行 "# …" → "+# …"，+ 后无空格）；
    //    patch 按行渲染为 block span，文本匹配时行间无分隔符——断言单行自身内容即可。
    await window.locator('[data-testid="tab-diff"]').click();
    await window.locator('[data-testid="diff-refresh"]').click();
    await expect(
      window.locator('[data-testid="diff-file"]', { hasText: "cockpit-e2e.md" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(window.locator('[data-testid="diff-patch"]')).toContainText(
      "+# 驾驶舱 E2E 新文件",
      { timeout: 15_000 },
    );

    // ⑦ 跟问一条消息 → follow-up 回放产生新的 message 事件（happy-path 二轮回放）
    await window.locator('[data-testid="tab-activity"]').click();
    const messages = window.locator('[data-testid="activity-event"][data-event-type="message"]');
    const before = await messages.count();
    await window.locator('[data-testid="follow-up-input"]').fill("继续下一步");
    await window.locator('[data-testid="follow-up-send"]').click();
    await expect(messages).toHaveCount(before + 1, { timeout: 30_000 });
  } finally {
    await app.close().catch(() => undefined);
  }
});

test("权限批准：permission_request 弹层 → 批准 → 会话续跑到终态", async () => {
  test.setTimeout(120_000);
  const repo = createTempRepo();
  const app: ElectronApplication = await _electron.launch(
    cockpitLaunchOptions(repo, "permission-ask.json"),
  );
  const window: Page = await app.firstWindow();

  try {
    await expect(window.locator('[data-testid="connection-badge"]')).toHaveText("已连接", {
      timeout: 30_000,
    });
    await createProjectAndTask(window, repo);

    await window.locator('[data-testid="spawn-prompt-input"]').fill("触发权限请求的任务");
    await window.locator('[data-testid="spawn-button"]').click();

    // ① permission_request 事件 → 批准弹层（阻塞回放期间 waiting 态稳定可观测）
    const prompt = window.locator('[data-testid="permission-prompt"]');
    await expect(prompt).toBeVisible({ timeout: 30_000 });
    await expect(window.locator('[data-testid="agent-status"]')).toHaveText("waiting", {
      timeout: 15_000,
    });

    // ② 点批准 → 弹层消失 → mock 收到应答继续回放 → 终态 stopped
    await window.locator('[data-testid="permission-approve"]').click();
    await expect(prompt).toBeHidden({ timeout: 15_000 });
    await expect(window.locator('[data-testid="agent-status"]')).toHaveText("stopped", {
      timeout: 30_000,
    });
    await expect(
      window.locator('[data-testid="activity-event"][data-event-type="message"]'),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await app.close().catch(() => undefined);
  }
});
