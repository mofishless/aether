// ===== Codex app-server 进程启动（协议定案 §2.1/§7）=====
// Windows 定案链路：node 24 裸 spawn .cmd 是 EINVAL（CVE-2024-27980）——读 .cmd shim
// 内容解析真实入口（node <codex.js> app-server），绕开 cmd.exe 包装拿到一等 node 进程
// （PID/退出证明/树杀语义最干净）；解析失败兜底 process-host spawnCommand 的
// cmd.exe 安全转义路径。CODEX_HOME 设置时必须预创建且字面 ~ 需自行展开（§9-10）。
// 进程治理统一走 @aether/process-host（树杀/ExitProof 与 claude adapter 同语义）。
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, dirname, extname, join, normalize, sep } from "node:path";
import { homedir } from "node:os";
import { spawnCommand } from "@aether/process-host";
import type { ProcessHandle, SpawnTrackedOptions } from "@aether/process-host";

/** 解析后的启动规格：command + 完整 argv（含 app-server 子命令与前置旗标） */
export interface LaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
}

/** .cmd shim 解析结果：真实 node 入口（null = 解析失败，走 cmd.exe 包装兜底） */
export interface ShimResolution {
  readonly nodePath: string;
  readonly scriptPath: string;
}

/**
 * 从 npm 风格 .cmd shim 内容解析真实入口（纯函数，全平台可测）。
 * 识别两种常见形态：
 *   "%_prog%"  "%~dp0\node_modules\@openai\codex\bin\codex.js" %*
 *   node  "%~dp0\...\codex.js" %*
 * 规则：取首个以 .js 结尾的带引号 token；%~dp0 展开为 shim 所在目录（含尾分隔符）；
 * node 二进制：shim 引用 %~dp0\node.exe 且存在时用它，否则用 process.execPath。
 */
export function parseCmdShimContent(
  content: string,
  shimDir: string,
  nodeFallback: string,
): ShimResolution | null {
  const quoted = /"([^"]+\.js)"/.exec(content);
  if (quoted === null || quoted[1] === undefined) {
    return null;
  }
  const rawScript = quoted[1];
  if (!rawScript.includes("%~dp0")) {
    // 非 %~dp0 形态（绝对路径等）：仅接受已含盘符/根的绝对路径
    return /^[a-zA-Z]:[\\/]/.test(rawScript) || rawScript.startsWith("/")
      ? { nodePath: nodeFallback, scriptPath: normalize(rawScript) }
      : null;
  }
  // %~dp0 展开为"shim 目录 + 尾分隔符"（npm 语义），兼容 \% 与 /% 两种写法
  const dirPrefix = shimDir.endsWith(sep) ? shimDir : `${shimDir}${sep}`;
  const scriptPath = normalize(rawScript.replace(/%~dp0[\\/]?/gi, dirPrefix));
  const bundledNode = /%~dp0[\\/]node\.exe/i.test(content)
    ? join(shimDir, "node.exe")
    : nodeFallback;
  return { nodePath: bundledNode, scriptPath };
}

/** 读 .cmd shim 并解析（IO 缝，可注入）；失败返回 null 由调用方兜底 */
export type ShimReader = (shimPath: string) => string;

export const fileShimReader: ShimReader = (shimPath: string): string =>
  readFileSync(shimPath, "utf8");

/** PATH 探测缝（IO，可注入）：裸名 → 解析到的完整入口路径；null = 未探到 */
export type PathProber = (name: string) => string | null;

/**
 * 默认 PATH 探测（P1-01 评审 F5）：win32 裸名 codex 不做 PATHEXT 解析（node 裸
 * spawn 只按字面名找），逐目录探 codex.cmd / codex.exe。.cmd 优先于 .exe 是 Aether
 * 取舍：npm 全局安装是 codex 在 Windows 的主径（同目录共存原生 exe 的场景罕见）。
 */
export const envPathProber: PathProber = (name: string): string | null => {
  const pathValue = process.env["PATH"];
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    return null;
  }
  for (const dir of pathValue.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const ext of [".cmd", ".exe"]) {
      const candidate = join(dir, `${name}${ext}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
};

/** 裸名判定：无扩展名且不含路径分隔符（如 "codex"；"./codex"、"codex.exe" 不算） */
function isBareName(cliPath: string): boolean {
  return !cliPath.includes("/") && !cliPath.includes("\\") && extname(cliPath) === "";
}

/**
 * 启动规格解析（纯决策，不做 IO 之外的 spawn）：
 * - win32 + 裸名（无扩展名，如默认 "codex"）：PATH 探测 codex.cmd / codex.exe
 *   （P1-01 评审 F5——node 裸 spawn 不做 PATHEXT 解析）；探到 .cmd 落入下方 shim
 *   解析链、探到 .exe 原样直启；探不到保持裸名原样（spawn 失败由 discover 兜底提示）
 * - win32 + .cmd/.bat：读 shim → node <script>（一等 node 进程）；解析失败 → 原样
 *   交 spawnCommand（其内部做 cmd.exe /d /s /c 安全转义包装）
 * - .mjs/.js 脚本：process.execPath <script>（测试 mock server 与自备入口共用此径）
 * - 其余（POSIX codex / .exe / 绝对路径）：原样 spawn
 * serverArgs 为 app-server 之后的附加旗标（默认含 T3 生产参数
 * -c thread_unload_delay_secs=0，§7 Aether 采纳——thread 即用即卸防内存膨胀，
 * 卸载后新 turn 前由适配器 thread/resume 重载）。
 */
export function resolveCodexLaunch(
  cliPath: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly extraArgs?: readonly string[];
    /** 尾随子命令（默认 "app-server"；discover 探测传 "--version"） */
    readonly subcommand?: readonly string[];
    readonly shimReader?: ShimReader;
    readonly nodePath?: string;
    /** PATH 探测缝（默认 envPathProber；纯单测可注入假件） */
    readonly pathProber?: PathProber;
  } = {},
): LaunchSpec {
  const platform = options.platform ?? process.platform;
  const nodePath = options.nodePath ?? process.execPath;
  const extra = options.extraArgs ?? DEFAULT_CODEX_SERVER_ARGS;
  const trailing = options.subcommand ?? ["app-server"];
  const shimReader = options.shimReader ?? fileShimReader;
  const isWindows = platform === "win32";
  const isCmd = /\.(?:cmd|bat)$/i.test(cliPath);

  // win32 裸名：PATH 探测补全后按补全路径走常规分支（探测结果必带扩展名，递归终止）
  if (isWindows && !isCmd && isBareName(cliPath)) {
    const probed = (options.pathProber ?? envPathProber)(cliPath);
    if (probed !== null) {
      return resolveCodexLaunch(probed, options);
    }
  }

  if (isWindows && isCmd) {
    try {
      const resolution = parseCmdShimContent(shimReader(cliPath), dirname(cliPath), nodePath);
      if (resolution !== null) {
        return {
          command: resolution.nodePath,
          args: [resolution.scriptPath, ...extra, ...trailing],
        };
      }
    } catch {
      // shim 不可读/解析失败：落入 cmd.exe 包装兜底
    }
    return { command: cliPath, args: [...extra, ...trailing] };
  }
  if (/\.(?:mjs|cjs|js)$/i.test(cliPath)) {
    return { command: nodePath, args: [cliPath, ...extra, ...trailing] };
  }
  return { command: cliPath, args: [...extra, ...trailing] };
}

/**
 * CODEX_HOME 规范化（§2.1/§9-10）：设置时目录必须已存在且为目录，字面 ~ 服务端
 * 不展开会拒启——此处替换展开（支持 ~ 与 ~/ 前缀）并预创建。返回展开后路径；
 * 入参未设置时返回 null（服务端默认 ~/.codex，无需预创建）。
 */
export function prepareCodexHome(configured: string | undefined): string | null {
  if (configured === undefined || configured.length === 0) {
    return null;
  }
  let expanded = configured;
  if (expanded === "~") {
    expanded = homedir();
  } else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = join(homedir(), expanded.slice(2));
  }
  // 预创建：codex 启动校验"目录必须已存在"（§2.1），缺失即启动失败
  mkdirSync(expanded, { recursive: true });
  return expanded;
}

export interface LaunchCodexServerOptions {
  /** CLI 可执行入口（config.cliPath；默认 "codex"） */
  readonly cliPath: string;
  /** app-server 前置附加旗标（默认 T3 生产参数 -c thread_unload_delay_secs=0） */
  readonly extraArgs?: readonly string[];
  /** CODEX_HOME（已展开预创建后的路径；null = 不设） */
  readonly codexHome: string | null;
  /** spawn 注入缝（默认 process-host spawnCommand；测试可换） */
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnTrackedOptions,
  ) => ProcessHandle;
  /** 平台注入缝（默认 process.platform；纯单测可覆盖） */
  readonly platform?: NodeJS.Platform;
  readonly cwd: string;
  readonly env: Record<string, string>;
}

export const DEFAULT_CODEX_SERVER_ARGS: readonly string[] = ["-c", "thread_unload_delay_secs=0"];

/**
 * 启动 codex app-server 子进程（治理 spawn）。env 自行铺底再叠加注入项
 * （与 claude adapter 同策略：整体替换语义下保留宿主环境）。
 */
export function launchCodexServer(options: LaunchCodexServerOptions): ProcessHandle {
  const spawn = options.spawn ?? spawnCommand;
  const spec = resolveCodexLaunch(options.cliPath, {
    ...(options.extraArgs !== undefined ? { extraArgs: options.extraArgs } : {}),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
  });
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  if (options.codexHome !== null) {
    env["CODEX_HOME"] = options.codexHome;
  }
  return spawn(spec.command, spec.args, {
    cwd: options.cwd,
    env,
    // POSIX 进程组：子进程即组长，killTree 整组树杀（与 claude adapter 同款）
    detached: (options.platform ?? process.platform) !== "win32",
  });
}
