// ConPTY 预热（调研 06 §9.1：Windows 首次 PTY 创建有秒级冷启动——conpty.dll/OpenConsole 加载）。
// 提供 warmup() API + 模块级"已预热"标志；daemon 启动时后台调（接线在 P0-10）。
// 非 Windows 无 ConPTY 概念：直接置位返回。预热是尽力而为的优化：
// 失败不抛错、不置位（环境修复后可重试），绝不打断 daemon 启动。
import { createPtySession } from "./pty-session.js";
import { resolveDefaultShell } from "./shell.js";

let conptyWarmed = false;

/** 是否已完成 ConPTY 预热（非 Windows 平台在首次调用 warmupConpty 后即为 true） */
export function isConptyWarmed(): boolean {
  return conptyWarmed;
}

/** 预热 ConPTY：创建一个哑 PTY 立即释放，摊平首次创建的秒级冷启动；幂等 */
export async function warmupConpty(): Promise<void> {
  if (conptyWarmed) {
    return;
  }
  if (process.platform !== "win32") {
    conptyWarmed = true;
    return;
  }
  const shellFile = resolveDefaultShell();
  if (shellFile === null) {
    // 无 shell 可用：无事可预热，保持未置位以便环境修复后重试
    return;
  }
  try {
    const session = createPtySession({
      terminalId: "conpty-warmup",
      cols: 80,
      rows: 24,
      file: shellFile,
    });
    await session.dispose();
    conptyWarmed = true;
  } catch {
    // 尽力而为：失败不置位、不抛错（哑 PTY 由 dispose/退出事件兜底释放）
  }
}
