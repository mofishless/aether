// daemon 入口（spawn 协议，阶段 2 主进程 supervisor 依赖，格式稳定勿改）：
// - env AETHER_DAEMON_TOKEN 必填（缺失 → stderr 报错 + 退出码 1）
// - 绑 127.0.0.1 随机端口；监听成功后向 stdout 写单行 JSON {"type":"listening","port":<N>}
//   （stdout 只此一行——父进程按行解析，其余诊断一律走 stderr）
// - flag：--hang-silent（存活但不就绪）/ --hang-signal（握手后真阻塞）——阶段 2 故障注入
import { DaemonOptionsError, parseDaemonOptions } from "./options.js";
import { keepAliveSilently } from "./hang.js";
import { DEFAULT_HELLO_TIMEOUT_MS, startDaemonServer, type DaemonServer } from "./server.js";

function writeListeningLine(port: number): void {
  process.stdout.write(`${JSON.stringify({ type: "listening", port })}\n`);
}

async function gracefulExit(server: DaemonServer): Promise<void> {
  await server.shutdown();
  process.exitCode = 0;
}

async function main(): Promise<void> {
  const options = parseDaemonOptions(process.env, process.argv.slice(2));
  if (options.hangSilent) {
    keepAliveSilently();
    return;
  }

  const daemonServer = await startDaemonServer({
    token: options.token,
    helloTimeoutMs: DEFAULT_HELLO_TIMEOUT_MS,
    hangAfterHandshake: options.hangSignal,
    onShutdownRequested: () => {
      void gracefulExit(daemonServer);
    },
  });
  writeListeningLine(daemonServer.port);
}

main().catch((error: unknown) => {
  const message =
    error instanceof DaemonOptionsError || error instanceof Error ? error.message : String(error);
  // 用 exitCode 自然退出而非 process.exit()：Windows 管道下 exit 会截断未刷完的 stderr
  process.stderr.write(`[aether-daemon] fatal: ${message}\n`);
  process.exitCode = 1;
});
