// P0-10 验收②：渲染进程 import 边界 CI 静态检查（验收①"全部数据经类型化通道"的静态面）。
// src/renderer 只准 import：react 系 / zustand / @aether/contracts / 渲染层内部相对路径 / CSS。
// 禁 node 内置、禁 electron（渲染拿宿主能力只经 preload 注入的 window 对象）、禁其他 @aether/* 包
// （领域数据一律经 daemon 契约通道推送，渲染层直接引领域包即架构违规）。
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rendererSrcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "renderer");

/** 渲染层白名单裸说明符（react 运行时三件套 + zustand + 契约包） */
const ALLOWED_BARE_SPECIFIERS = [
  /^react$/,
  /^react\/jsx-runtime$/,
  /^react-dom$/,
  /^react-dom\/client$/,
  /^zustand$/,
  /^@aether\/contracts$/,
] as const;

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"] as const;

const IMPORT_SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bimport\s[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bexport\s[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]/g,
];

function listRendererSourceFiles(): string[] {
  const entries = readdirSync(rendererSrcDir, { recursive: true, withFileTypes: true });
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

/** 相对说明符解析后必须落在 src/renderer 内（CSS 导入同样不得逃逸） */
function escapesRendererSource(file: string, specifier: string): boolean {
  const rel = relative(rendererSrcDir, resolve(dirname(file), specifier));
  return rel.startsWith("..") || isAbsolute(rel);
}

/** 边界守卫本体：返回全部违规项（空数组 = 通过）；独立成函数供故障注入用例直接调用 */
function collectRendererOffenders(files: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const specifier of extractImportSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        if (escapesRendererSource(file, specifier)) {
          offenders.push(`${file} 相对 import 逃出 src/renderer："${specifier}"`);
        }
        continue; // 渲染层内部相对路径（含 .css）一律放行（逃逸已由上一分支拦下）
      }
      if (!ALLOWED_BARE_SPECIFIERS.some((allowed) => allowed.test(specifier))) {
        offenders.push(`${file} 非白名单 import："${specifier}"`);
      }
    }
  }
  return offenders;
}

describe("渲染进程 import 边界（CI 静态检查）", () => {
  it("扫描到渲染层源文件（守卫非空，防止检查静默空转）", () => {
    const files = listRendererSourceFiles();
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.some((file) => file.endsWith(join("renderer", "src", "main.tsx")))).toBe(true);
  });

  it("渲染层源码只 import 白名单（react 系/zustand/@aether/contracts/内部相对路径/CSS）", () => {
    const offenders = collectRendererOffenders(listRendererSourceFiles());
    expect(offenders).toEqual([]);
  });

  it("故障注入：electron / node 内置 / 领域包 / 逃逸相对路径真实触发守卫 fail（守卫非摆设）", () => {
    const electronProbe = join(rendererSrcDir, "src", "__guard_probe_electron__.tsx");
    const nodeProbe = join(rendererSrcDir, "src", "__guard_probe_node__.ts");
    const domainProbe = join(rendererSrcDir, "src", "__guard_probe_domain__.ts");
    const escapeProbe = join(rendererSrcDir, "src", "__guard_probe_escape__.ts");
    writeFileSync(electronProbe, 'import { ipcRenderer } from "electron";\n', "utf8");
    writeFileSync(nodeProbe, 'import path from "node:path";\n', "utf8");
    writeFileSync(domainProbe, 'import { openStorage } from "@aether/storage";\n', "utf8");
    writeFileSync(escapeProbe, 'import { supervisor } from "../../../main/index.js";\n', "utf8");
    try {
      const offenders = collectRendererOffenders([
        electronProbe,
        nodeProbe,
        domainProbe,
        escapeProbe,
      ]);
      expect(offenders).toHaveLength(4);
      expect(offenders[0]).toContain("electron");
      expect(offenders[1]).toContain("node:path");
      expect(offenders[2]).toContain("@aether/storage");
      expect(offenders[3]).toContain("../../../main/index.js");
    } finally {
      rmSync(electronProbe, { force: true });
      rmSync(nodeProbe, { force: true });
      rmSync(domainProbe, { force: true });
      rmSync(escapeProbe, { force: true });
    }
  });
});
