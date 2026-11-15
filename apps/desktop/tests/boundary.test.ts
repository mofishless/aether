// P0-03 验收：主进程 import 边界 CI 静态检查（TASK_LIST P0-03 / SYSTEM_DESIGN §2 规则 3、4）。
// apps/desktop 主进程只许 @aether/contracts + 自带 daemon 启动器：
// 领域包（storage / core / daemon 包本体）一旦被主进程 import 即本测试 fail。
// 主进程与 daemon 只许经 launcher spawn 协议交互，不许直接引代码。
// 守卫 3（spec-review #1）：相对/动态 import 与 require 也逃不掉——说明符逐条解析，
// 相对说明符必须落在 src/main 内，非相对说明符只许白名单（堵死 "../../../daemon/src/server.js" 绕过）。
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mainSrcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main");

/** 显式黑名单（SYSTEM_DESIGN §2 依赖方向规则）；workspace 前缀另有白名单断言 */
const FORBIDDEN_SNIPPETS = ["@aether/storage", "@aether/daemon", "packages/core"] as const;

/** 守卫 3 扫描的扩展名（src/main 现全为 .ts；.js/.mjs/.cjs 为防御性口径，防后续混入脚本） */
const SOURCE_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs"] as const;

/** 非相对说明符白名单：主进程只许 Node 内建、electron、ws 与契约包 */
const ALLOWED_BARE_SPECIFIERS = [/^node:/, /^electron$/, /^ws$/, /^@aether\/contracts$/] as const;

// 只匹配 import/require 语句形态的说明符，不碰普通字符串字面量：
// src/main/index.ts 的 daemon dist 路径是 spawn 用的 path.resolve 参数（非 import），不会误伤。
const IMPORT_SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bimport\s[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]/g, // import … from "X"（含 import type）
  /\bimport\s*['"]([^'"]+)['"]/g, // 副作用 import "X"
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // 动态 import("X")
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require("X")
  /\bexport\s[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]/g, // re-export … from "X"
];

function listMainSourceFiles(): string[] {
  const entries = readdirSync(mainSrcDir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => join(entry.parentPath, entry.name));
}

function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

/** 相对说明符解析后必须落在 src/main 内（path.relative 规避盘符大小写/分隔符差异） */
function escapesMainSource(file: string, specifier: string): boolean {
  const rel = relative(mainSrcDir, resolve(dirname(file), specifier));
  return rel.startsWith("..") || isAbsolute(rel);
}

/** 守卫 3 本体：返回全部违规项（空数组 = 通过）；独立成函数供故障注入用例直接调用 */
function collectImportOffenders(files: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const specifier of extractImportSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        if (escapesMainSource(file, specifier)) {
          offenders.push(`${file} 相对 import 逃出 src/main："${specifier}"`);
        }
        continue;
      }
      if (!ALLOWED_BARE_SPECIFIERS.some((allowed) => allowed.test(specifier))) {
        offenders.push(`${file} 非白名单 import："${specifier}"`);
      }
    }
  }
  return offenders;
}

describe("主进程 import 边界（CI 静态检查）", () => {
  it("扫描到主进程源文件（守卫非空，防止检查静默空转）", () => {
    const files = listMainSourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files.some((file) => file.endsWith(join("main", "index.ts")))).toBe(true);
  });

  it("主进程源码不出现领域包标识（storage / core / daemon 包）", () => {
    const files = listMainSourceFiles();
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const snippet of FORBIDDEN_SNIPPETS) {
        if (source.includes(snippet)) {
          offenders.push(`${file} 含 "${snippet}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("workspace 包引用只允许 @aether/contracts", () => {
    const files = listMainSourceFiles();
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const references = source.match(/@aether\/[A-Za-z0-9._-]*/g) ?? [];
      for (const reference of references) {
        if (reference !== "@aether/contracts") {
          offenders.push(`${file} 引用 ${reference}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("import 说明符：相对 import 必须落在 src/main 内，非相对只许 node:*/electron/ws/@aether/contracts", () => {
    const offenders = collectImportOffenders(listMainSourceFiles());
    expect(offenders).toEqual([]);
  });

  it("故障注入：逃出 src/main 的相对 import 与白名单外裸包真实触发守卫 fail（守卫非摆设）", () => {
    const escapeProbe = join(mainSrcDir, "__guard_probe_escape__.ts");
    const bareProbe = join(mainSrcDir, "__guard_probe_bare__.ts");
    writeFileSync(
      escapeProbe,
      'import type { DaemonServer } from "../../../daemon/src/server.js";\n',
      "utf8",
    );
    writeFileSync(bareProbe, 'import { useState } from "react";\n', "utf8");
    try {
      const offenders = collectImportOffenders([escapeProbe, bareProbe]);
      expect(offenders).toHaveLength(2);
      // 逃逸相对 import：两条旧守卫（禁词/@aether 白名单）都抓不住，只有守卫 3 能抓
      expect(offenders[0]).toContain("__guard_probe_escape__");
      expect(offenders[0]).toContain("../../../daemon/src/server.js");
      expect(offenders[1]).toContain("__guard_probe_bare__");
      expect(offenders[1]).toContain("react");
    } finally {
      rmSync(escapeProbe, { force: true });
      rmSync(bareProbe, { force: true });
    }
  });
});
