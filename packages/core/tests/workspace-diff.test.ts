// workspace diff 单测（P0-11）：真临时 git 仓库端到端——init+commit+分支+改动，
// 校验 added/modified/deleted 解析、patch 文本归属、二进制/中文/空格路径、空差异与
// 缺失 base 分支错误。双平台语义一致（git 行为与平台无关；仅路径分隔由 git 归一）。
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorktreeError, computeWorkspaceDiff } from "../src/index.js";

interface DiffFixture {
  readonly projectRoot: string;
  readonly baseDir: string;
  git(args: readonly string[], cwd?: string): string;
  dispose(): void;
}

function createDiffRepo(): DiffFixture {
  const baseDir = mkdtempSync(join(tmpdir(), `aether-diff-${randomUUID().slice(0, 8)}-`));
  const projectRoot = join(baseDir, "project");
  mkdirSync(projectRoot);
  const git = (args: readonly string[], cwd: string = projectRoot): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
  git(["init"]);
  git(["config", "user.email", "aether@test.local"]);
  git(["config", "user.name", "Aether Test"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(projectRoot, "README.md"), "# aether diff fixture\n");
  mkdirSync(join(projectRoot, "src"));
  writeFileSync(join(projectRoot, "src", "old.ts"), "export const old = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-m", "init"]);
  git(["branch", "-m", "main"]); // 基准分支名确定化（不依赖 git 版本默认名）
  return {
    projectRoot,
    baseDir,
    git,
    dispose(): void {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          rmSync(baseDir, { recursive: true, force: true });
          return;
        } catch {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        }
      }
    },
  };
}

describe("computeWorkspaceDiff：真临时 git 仓库端到端", () => {
  let fixture: DiffFixture;

  beforeAll(() => {
    fixture = createDiffRepo();
    // 工作区分支：改 README + 新增 src/new.ts + 删除 src/old.ts + 中文/空格路径 + 二进制
    fixture.git(["checkout", "-b", "aether/diff-test"]);
    writeFileSync(join(fixture.projectRoot, "README.md"), "# aether diff fixture v2\n");
    writeFileSync(join(fixture.projectRoot, "src", "new.ts"), "export const next = 2;\n");
    writeFileSync(join(fixture.projectRoot, "中文文档.md"), "# 中文内容\n");
    writeFileSync(join(fixture.projectRoot, "has space.txt"), "with space\n");
    writeFileSync(join(fixture.projectRoot, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
    fixture.git(["rm", "-q", "src/old.ts"]);
    fixture.git(["add", "-A"]);
    fixture.git(["commit", "-m", "branch changes"]);
  });

  afterAll(() => {
    fixture.dispose();
  });

  it("base...branch：added/modified/deleted 清单与 patch 归属（含中文/空格路径）", async () => {
    const files = await computeWorkspaceDiff({
      cwd: fixture.projectRoot,
      branch: "aether/diff-test",
      baseBranch: "main",
      workspaceId: "w-diff",
    });
    const byPath = new Map(files.map((file) => [file.path, file]));

    const readme = byPath.get("README.md");
    expect(readme?.status).toBe("modified");
    expect(readme?.patch).toContain("diff --git a/README.md b/README.md");
    expect(readme?.patch).toContain("-# aether diff fixture");
    expect(readme?.patch).toContain("+# aether diff fixture v2");

    const added = byPath.get("src/new.ts");
    expect(added?.status).toBe("added");
    expect(added?.patch).toContain("+++ b/src/new.ts");
    expect(added?.patch).toContain("+export const next = 2;");

    const deleted = byPath.get("src/old.ts");
    expect(deleted?.status).toBe("deleted");
    expect(deleted?.patch).toContain("--- a/src/old.ts");
    expect(deleted?.patch).toContain("+++ /dev/null");
    expect(deleted?.patch).toContain("-export const old = 1;");

    // core.quotepath=false：中文路径原样（非 C 风格引号形态）
    const chinese = byPath.get("中文文档.md");
    expect(chinese?.status).toBe("added");
    expect(chinese?.patch).toContain("+++ b/中文文档.md");

    const spaced = byPath.get("has space.txt");
    expect(spaced?.status).toBe("added");
    expect(spaced?.patch).toContain("has space.txt");

    // 二进制：无 ---/+++ 行，回退 diff --git 头解析归属；patch 含 Binary files 提示
    const binary = byPath.get("bin.dat");
    expect(binary?.status).toBe("added");
    expect(binary?.patch).toContain("Binary files");
  }, 30_000);

  it("无差异分支 → 空数组（不抛错）", async () => {
    fixture.git(["checkout", "-q", "-b", "aether/empty", "main"]);
    const files = await computeWorkspaceDiff({
      cwd: fixture.projectRoot,
      branch: "aether/empty",
      baseBranch: "main",
    });
    expect(files).toEqual([]);
  });

  it("未提交改动不计入（三点 diff 只看分支已提交内容，任务定案口径）", async () => {
    writeFileSync(join(fixture.projectRoot, "uncommitted.txt"), "工作区未提交\n");
    try {
      const files = await computeWorkspaceDiff({
        cwd: fixture.projectRoot,
        branch: "aether/diff-test",
        baseBranch: "main",
      });
      expect(files.some((file) => file.path === "uncommitted.txt")).toBe(false);
    } finally {
      rmSync(join(fixture.projectRoot, "uncommitted.txt"), { force: true });
    }
  });

  it("base 分支不存在 → WorktreeError（git 非零退出包装）", async () => {
    await expect(
      computeWorkspaceDiff({
        cwd: fixture.projectRoot,
        branch: "aether/diff-test",
        baseBranch: "no-such-base",
      }),
    ).rejects.toBeInstanceOf(WorktreeError);
  });
});
