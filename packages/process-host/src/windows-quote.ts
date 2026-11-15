// Windows 命令行参数转义（cmd.exe /d /s /c 上下文）。
//
// 背景（CVE-2024-27980，2024-03 修复）：node 在 Windows 直接 spawn .bat/.cmd 时会遭
// 批处理参数注入，修复后 node 对 .cmd/.bat 直接 spawn 抛 EINVAL；官方指引 = 由调用方经
// cmd.exe 包装并自行转义（node 自身 shell 路径即 `['/d','/s','/c', '"${command}"']` +
// windowsVerbatimArguments:true，DEP0190 也因此警告 shell:true 的 args 拼接不安全）。
//
// 本模块两步转义（每参数）：
// 1) argvW 层——目标程序 CRT 的 CommandLineToArgvW 规则：
//    反斜杠串遇 `"` 整体加倍且该 `"` 转为 `\"`；结尾反斜杠串加倍；整体包 `"…"`。
// 2) cmd 层——cmd.exe 解析元字符 `^ & | < > ( ) % ! "`（含第 1 步的包引号本身）逐个加 `^`
//    前缀。包引号也 caret 化后 cmd 全程不进入引号态，caret 在 cmd /c 命令行上下文逐一
//    消费，最终传给 CreateProcess 的命令行恰好是 argvW 良构引号串（qntm.org/cmd 论证，
//    cross-spawn 同款策略）。
//
// 边界已在本机（Windows 11 + node 24）经真实 cmd.exe 往返实验逐例验证（2026-11-15）：
// 空串/空格/内嵌引号/结尾反斜杠/`& | < > ( ) ^ %`/`; , * ?`/制表符 共 20 例全过，
// 含 `%PATH%`（cmd /c 命令行上下文中 `^%` 可防变量展开——实验证实）。表驱动单测见
// tests/quote-windows-arg.test.ts。
//
// 已知残留局限（如实记录）：批处理文件体内的 % 展开/%1 定位是脚本自身语义，非本层可控。
const CMD_METACHARS = /([\^&|<>()%!"])/g;

/** argvW 层转义（不做 cmd 层处理）：反斜杠/引号规则 + 整体包引号 */
function escapeForArgvW(text: string): string {
  return text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
}

/**
 * 单个参数 → cmd.exe /d /s /c 命令行中的安全 token（纯函数，全平台可用）。
 * 用于 spawnCommand 组装 args；表驱动转义边界单测为本函数的契约。
 */
export function quoteWindowsArg(arg: string): string {
  const quoted = `"${escapeForArgvW(arg)}"`;
  return quoted.replace(CMD_METACHARS, "^$1");
}

/**
 * 命令本体（.cmd/.bat 文件路径）token：仅 argvW 层转义、包引号保持"裸"引号——
 * cmd 解析命令名时需要真引号来跨越空格（路径含空格场景；引号是 Windows 文件名非法字符，
 * 路径内不会出现内嵌引号破坏配对）。实验验证：含空格目录下的脚本路径经此引用可正常执行。
 */
export function quoteWindowsCommand(path: string): string {
  return `"${escapeForArgvW(path)}"`;
}

/** .cmd/.bat 脚本检测（不区分大小写） */
export function isCmdScriptPath(command: string): boolean {
  return /\.(?:cmd|bat)$/i.test(command);
}
