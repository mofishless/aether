// spawnCommand：面向"用户可见命令"的安全 spawn 入口（adapters 默认走这里）。
// - Windows + .cmd/.bat：经 cmd.exe /d /s /c 包装，命令与参数按 windows-quote.ts 转义，
//   windowsVerbatimArguments:true 原样传递（CVE-2024-27980 后官方指引，见该文件头注释）
// - 其余（非 Windows / .exe / 无扩展名）：直接 spawnTracked
import { spawnTracked } from "./spawn-tracked.js";
import { isCmdScriptPath, quoteWindowsArg, quoteWindowsCommand } from "./windows-quote.js";
import type { ProcessHandle, SpawnTrackedOptions } from "./types.js";

const IS_WINDOWS = process.platform === "win32";

export function spawnCommand(
  command: string,
  args: readonly string[] = [],
  options: SpawnTrackedOptions = {},
): ProcessHandle {
  if (!IS_WINDOWS || !isCmdScriptPath(command)) {
    return spawnTracked(command, args, options);
  }
  const line = [quoteWindowsCommand(command), ...args.map(quoteWindowsArg)].join(" ");
  // 与 node 自身 shell 路径同款：cmd.exe /d /s /c "<line>" + verbatim 传参（node normalizeSpawnArguments）
  const shell = process.env.comspec ?? "cmd.exe";
  return spawnTracked(shell, ["/d", "/s", "/c", `"${line}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}
