import { existsSync } from "node:fs";
import { join } from "node:path";

/** 默认 shell 探测：win32 → PowerShell 绝对路径；POSIX → /bin/bash 或 /bin/sh。找不到返回 null（上层决定跳过还是显式传 file）。 */
export function resolveDefaultShell(): string | null {
  if (process.platform === "win32") {
    const windir = process.env.windir ?? "C:\\Windows";
    const powershell = join(windir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return existsSync(powershell) ? powershell : null;
  }
  if (existsSync("/bin/bash")) {
    return "/bin/bash";
  }
  if (existsSync("/bin/sh")) {
    return "/bin/sh";
  }
  return null;
}
