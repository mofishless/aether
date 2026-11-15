// 入口参数解析（纯函数，便于单测）：一次性 token 来自环境变量，测试 flag 来自 argv。

export interface DaemonOptions {
  readonly token: string;
  /** 保持进程存活但不 bind、不写 stdout（阶段 2 启动超时 fixture） */
  readonly hangSilent: boolean;
  /** 握手成功后真阻塞事件循环（阶段 2 心跳超时 fixture） */
  readonly hangSignal: boolean;
}

export class DaemonOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonOptionsError";
  }
}

export function parseDaemonOptions(env: NodeJS.ProcessEnv, argv: string[]): DaemonOptions {
  const token = env["AETHER_DAEMON_TOKEN"];
  if (typeof token !== "string" || token.length === 0) {
    throw new DaemonOptionsError(
      "AETHER_DAEMON_TOKEN is required: one-time token injected by the spawning parent process",
    );
  }

  let hangSilent = false;
  let hangSignal = false;
  for (const arg of argv) {
    if (arg === "--hang-silent") {
      hangSilent = true;
    } else if (arg === "--hang-signal") {
      hangSignal = true;
    } else {
      // fail-closed：拒绝未知 flag，防止拼写错误静默通过
      throw new DaemonOptionsError(`unknown daemon flag: ${arg}`);
    }
  }
  if (hangSilent && hangSignal) {
    throw new DaemonOptionsError("--hang-silent and --hang-signal are mutually exclusive");
  }

  return Object.freeze({ token, hangSilent, hangSignal });
}
