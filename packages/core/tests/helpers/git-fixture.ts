import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 真 git fixture：tmp 内 git init + 首 commit 的"项目根"。
 *  randomUUID 命名保证可重复并行安全；.env / pnpm-lock.yaml 一并 commit，
 *  保证主 checkout `git status --porcelain` 断言在 fixture 层面就是干净的。 */
export interface GitProjectFixture {
  readonly projectRoot: string;
  readonly baseDir: string;
  git(args: readonly string[], cwd?: string): string;
  /** 尽力清理（Windows 句柄延迟时重试后放弃，残留在系统 tmp）。 */
  dispose(): void;
}

export function createGitProject(): GitProjectFixture {
  const baseDir = mkdtempSync(join(tmpdir(), `aether-core-${randomUUID().slice(0, 8)}-`));
  const projectRoot = join(baseDir, "project");
  mkdirSync(projectRoot);
  const git = (args: readonly string[], cwd: string = projectRoot): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
  git(["init"]);
  git(["config", "user.email", "aether@test.local"]);
  git(["config", "user.name", "Aether Test"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(projectRoot, "README.md"), "# aether core fixture\n");
  git(["add", "-A"]);
  git(["commit", "-m", "init"]);
  return {
    projectRoot,
    baseDir,
    git,
    dispose(): void {
      removeBestEffort(baseDir);
    },
  };
}

/** 带 .env + pnpm-lock.yaml（已 commit）的 fixture：驱动拷贝与包管理器探测断言。 */
export function createGitProjectWithEnvAndPnpm(): GitProjectFixture {
  const fixture = createGitProject();
  const projectRoot = fixture.projectRoot;
  writeFileSync(join(projectRoot, ".env"), "AETHER_TEST=1\n");
  writeFileSync(join(projectRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  fixture.git(["add", "-A"]);
  fixture.git(["commit", "-m", "env + pnpm lock"]);
  return fixture;
}

/** 主 checkout 干净断言：`git status --porcelain` 必须为空（主 checkout 永远干净，验收标准）。 */
export function expectMainClean(fixture: GitProjectFixture): void {
  const status = fixture.git(["status", "--porcelain"]);
  if (status !== "") {
    throw new Error(`主 checkout 不干净：\n${status}`);
  }
}

function removeBestEffort(target: string): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      // Windows 句柄释放有延迟：短暂等待后重试
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  }
}
