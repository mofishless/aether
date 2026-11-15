// spawnCommand：Windows .cmd/.bat 安全执行（cmd.exe /d /s /c 包装，CVE-2024-27980 后指引）；
// 非 Windows 直接 spawn。参数转义正确性由 quote-windows-arg.test.ts 表驱动覆盖，
// 此处验证真 .cmd/.bat 文件的执行成功与带空格参数的送达。
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCommand } from "../src/index.js";
import { collectText } from "./helpers/process.js";
import type { ProcessHandle } from "../src/index.js";

/** stdout 必须默认可读（stdio 默认 pipe） */
function mustStdout(handle: ProcessHandle) {
  if (handle.stdout === null) throw new Error("stdout 应默认可读");
  return handle.stdout;
}

const IS_WIN = process.platform === "win32";
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

/** 临时 .cmd/.bat（目录名含空格，覆盖命令路径引号场景）；CRLF 行尾（批处理规范） */
function writeTempScript(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aether cmd lab "));
  tempDirs.push(dir);
  const scriptPath = join(dir, name);
  writeFileSync(scriptPath, `@echo off\r\n${body}\r\n`, "utf8");
  return scriptPath;
}

describe("spawnCommand：跨平台安全命令执行", () => {
  it.skipIf(IS_WIN)(
    "非 Windows：直接 spawn 并产出 ExitProof",
    async () => {
      const handle = spawnCommand(process.execPath, ["-e", 'console.log("aether-direct-spawn")']);
      const stdout = await collectText(mustStdout(handle));
      const proof = await handle.exited;
      expect(proof.code).toBe(0);
      expect(stdout).toContain("aether-direct-spawn");
    },
    20_000,
  );

  it.skipIf(!IS_WIN)(
    "Windows .cmd：echo 脚本执行成功（路径含空格）",
    async () => {
      const scriptPath = writeTempScript("echo-test.cmd", "@echo aether-cmd-ok");
      const handle = spawnCommand(scriptPath, []);
      const stdout = await collectText(mustStdout(handle));
      const proof = await handle.exited;
      expect(proof.code).toBe(0);
      expect(stdout).toContain("aether-cmd-ok");
    },
    20_000,
  );

  it.skipIf(!IS_WIN)(
    "Windows .cmd：带空格参数完整送达（%~1 展开）",
    async () => {
      const scriptPath = writeTempScript("echo-arg.cmd", "@echo %~1");
      const handle = spawnCommand(scriptPath, ["hello aether world"]);
      const stdout = await collectText(mustStdout(handle));
      const proof = await handle.exited;
      expect(proof.code).toBe(0);
      expect(stdout).toContain("hello aether world");
    },
    20_000,
  );

  it.skipIf(!IS_WIN)(
    "Windows .bat：与 .cmd 同样处理",
    async () => {
      const scriptPath = writeTempScript("echo-test.bat", "@echo aether-bat-ok");
      const handle = spawnCommand(scriptPath, []);
      const stdout = await collectText(mustStdout(handle));
      const proof = await handle.exited;
      expect(proof.code).toBe(0);
      expect(stdout).toContain("aether-bat-ok");
    },
    20_000,
  );

  it.skipIf(!IS_WIN)(
    "Windows 无扩展名 / .exe 命令不包装：直接 spawn node 本体",
    async () => {
      // process.execPath = node.exe：不应走 cmd.exe 包装（execPath 为 .exe）
      const handle = spawnCommand(process.execPath, ["-e", 'console.log("aether-exe-direct")']);
      const stdout = await collectText(mustStdout(handle));
      const proof = await handle.exited;
      expect(proof.code).toBe(0);
      expect(stdout).toContain("aether-exe-direct");
    },
    20_000,
  );
});
