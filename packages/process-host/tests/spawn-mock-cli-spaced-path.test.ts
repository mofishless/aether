// P0-12 含空格路径冒烟（②spawn 包装器且可执行路径含空格）：把 fixtures/aether-mock-cli
// 整目录复制进含空格临时目录，经 spawnCommand 驱动平台包装器回放 happy-path：
// - win32 = cli.cmd：cmd.exe /d /s /c 包装 + 脚本自身路径引号 + "%~dp0" 展开含空格目录
//   + %* 透传含空格参数——三层引号/转义全链一次跑通（spawn-command.test.ts 已测自建
//   echo .cmd 的执行与参数送达，本测试换"真身"mock CLI 整目录复制，补 %~dp0 展开一步）；
// - POSIX = cli.sh：`exec node "$(dirname "$0")/cli.mjs" "$@"` 的 dirname 含空格展开
//   （git 检出不带执行位 → 复制品运行时 chmod +x，同 adapters/claude 测试模式）。
// skipIf 语义：两平台各跑本平台腿——cli.cmd 仅 Windows 有意义（cmd.exe 包装层），
// cli.sh 仅 POSIX 有意义（包装器真身）；另一侧包装路径已由各平台真身测试覆盖。
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { spawnCommand } from "../src/index.js";
import type { ExitProof } from "../src/index.js";
import { collectText } from "./helpers/process.js";

const IS_WIN = process.platform === "win32";
const MOCK_CLI_DIR = fileURLToPath(new URL("../../../fixtures/aether-mock-cli/", import.meta.url));
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不阻塞
    }
  }
}, 20_000);

/** 复制 mock CLI 整目录（含 lib/ 与 fixtures/）到含空格临时目录，返回复制品根路径 */
function copyMockCliIntoSpacedDir(): string {
  const spacedDir = join(mkdtempSync(join(tmpdir(), "aether-space-")), "mock cli lab");
  const target = join(spacedDir, "dir with space");
  mkdirSync(target, { recursive: true });
  cpSync(MOCK_CLI_DIR, target, { recursive: true });
  tempDirs.push(spacedDir);
  return target;
}

/** 驱动复制品包装器回放 happy-path：stdin 门控关闭、含空格参数透传，断言帧送达 + 退出码 0 */
async function runCopiedWrapper(target: string, wrapperName: string): Promise<void> {
  const wrapper = join(target, wrapperName);
  const handle = spawnCommand(wrapper, ["--print", "value with space"], {
    env: {
      ...process.env,
      AETHER_MOCK_SCRIPT: join(target, "fixtures", "happy-path.json"),
      AETHER_MOCK_STDIN_GATE: "0",
    },
  });
  const stdout = handle.stdout;
  if (stdout === null) throw new Error("stdout 应默认可读");
  const textPromise = collectText(stdout);
  const proof: ExitProof = await handle.exited;
  const text = await textPromise;
  expect(proof.code).toBe(0);
  expect(text).toContain('"subtype":"init"');
  expect(text).toContain('"type":"result"');
}

describe("spawnCommand × mock CLI × 含空格可执行路径（P0-12 冒烟）", () => {
  it.skipIf(!IS_WIN)(
    "win32：cli.cmd 路径含空格 → 回放 happy-path、退出码 0",
    async () => {
      await runCopiedWrapper(copyMockCliIntoSpacedDir(), "cli.cmd");
    },
    30_000,
  );

  it.skipIf(IS_WIN)(
    "POSIX：cli.sh 路径含空格 → 回放 happy-path、退出码 0",
    async () => {
      const target = copyMockCliIntoSpacedDir();
      // 复制品不带执行位（cpSync 不保源 mode）：运行时补上，只改复制品不动仓库 fixture
      chmodSync(join(target, "cli.sh"), 0o755);
      await runCopiedWrapper(target, "cli.sh");
    },
    30_000,
  );
});
