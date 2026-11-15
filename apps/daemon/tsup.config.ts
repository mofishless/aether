import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig } from "tsup";

// 全部 @aether/* workspace 包以 TS 源码形态被消费（exports 指向 src/index.ts）。
// 必须内联进 dist：否则 dist 在运行时 import 会命中 .ts 源文件，而 daemon 由
// Electron 以 ELECTRON_RUN_AS_NODE 拉起（Node 22.x，无原生 type-stripping）。
// node-pty（native）/ @anthropic-ai/claude-agent-sdk（运行时 require.resolve 探测
// 平台 CLI 二进制，打包会破坏解析基点）/ ws 保持 external；zod 不入 dependencies
// （devDependencies 仅供电测/构建解析）→ esbuild 自动内联，dist 无额外解析依赖。
const noExternal = [
  "@aether/contracts",
  "@aether/core",
  "@aether/process-host",
  "@aether/storage",
  "@aether/adapter-claude",
  "@aether/adapters-codex",
  "@aether/terminal",
];

// 解析本次构建的输出目录：默认 dist；desktop 生命周期测试以自定义 --out-dir
// 构建隔离副本（apps/desktop/.tmp/daemon-dist），本配置会被 tsup 合并生效。
function resolveOutDir(): string {
  const argv = process.argv;
  const flagIndex = argv.indexOf("--out-dir");
  if (flagIndex !== -1 && typeof argv[flagIndex + 1] === "string") {
    return resolve(argv[flagIndex + 1] as string);
  }
  return resolve("dist");
}

/**
 * 构建后修复（必须随任何 --out-dir 生效）：tsup 内置 node-protocol 插件会把
 * 外置的 node: 内建模块改写成裸名（node:sqlite → sqlite），而实验性内建模块
 * 在 Node ESM 下裸名不可解析（Node 22.5+/24 实测 ERR_MODULE_NOT_FOUND；
 * fs/path 等稳定内建裸名可用，不受影响）。@aether/storage（node:sqlite）
 * 随 P0-10 首次进入 daemon bundle，故需此修复。
 */
function restoreNodePrefix(outDir: string): void {
  const file = resolve(outDir, "index.js");
  const source = readFileSync(file, "utf8");
  const fixed = source
    .replaceAll('from "sqlite"', 'from "node:sqlite"')
    .replaceAll("from 'sqlite'", "from 'node:sqlite'");

  if (fixed !== source) {
    writeFileSync(file, fixed);
    console.log("[daemon-build] 已恢复 node:sqlite 导入前缀");
  } else if (source.includes('"sqlite"')) {
    // 出现了未预料的 sqlite 引用形态（如动态 import）：显式失败，防静默带病出包
    console.error("[daemon-build] dist 中存在未处理的裸 sqlite 引用，请检查 restoreNodePrefix");
    process.exitCode = 1;
  }
}

/** 本包 dependencies 中保持 external 的包名（dependencies − noExternal） */
function externalPackageNames(): string[] {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(pkg.dependencies ?? {}).filter((name) => !noExternal.includes(name));
}

/**
 * 隔离输出目录的 externals 解析缝：desktop 生命周期测试把入口构建到
 * apps/desktop/.tmp/daemon-dist（自定义 --out-dir），该位置向上走查不到
 * apps/daemon/node_modules。为每个 external 包在输出目录建 junction，指向其
 * realpath（pnpm 的包链接是相对符号链接，直接 junction 整个 node_modules 目录
 * 会让相对目标在链接视角下失效——必须逐包取物理路径）。Windows junction 无需
 * 特权；Node fs.rm recursive 对 junction 只删链接不删目标（实测目标存活）。
 */
function linkExternalsForIsolatedOutDir(outDir: string): void {
  if (outDir === resolve("dist")) {
    return; // 常规构建：dist 就在本包内，解析天然可用
  }
  for (const name of externalPackageNames()) {
    const physicalPath = realpathSync(resolve("node_modules", name));
    const linkPath = resolve(outDir, "node_modules", name);
    if (existsSync(linkPath)) {
      continue;
    }
    mkdirSync(dirname(linkPath), { recursive: true });
    try {
      symlinkSync(physicalPath, linkPath, "junction");
    } catch (cause) {
      console.error(`[daemon-build] 无法链接 external 包 ${name}（${linkPath}）：${String(cause)}`);
    }
  }
  console.log("[daemon-build] 已为隔离输出目录链接 externals 解析缝");
}

/** 构建后处理：前缀修复 + 隔离目录 externals 链接 */
function postBuild(): void {
  const outDir = resolveOutDir();
  restoreNodePrefix(outDir);
  linkExternalsForIsolatedOutDir(outDir);
}

export default defineConfig({
  noExternal,
  onSuccess: postBuild,
});
