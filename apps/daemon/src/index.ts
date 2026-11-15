// daemon 入口（spawn 协议，阶段 2 主进程 supervisor 依赖，格式稳定勿改）：
// - env AETHER_DAEMON_TOKEN 必填（缺失 → stderr 报错 + 退出码 1）
// - 绑 127.0.0.1 随机端口；监听成功后向 stdout 写单行 JSON {"type":"listening","port":<N>}
//   （stdout 只此一行——父进程按行解析，其余诊断一律走 stderr）
// - flag：--hang-silent（存活但不就绪）/ --hang-signal（握手后真阻塞）——阶段 2 故障注入
// - P0-10：启动即组装（storage/适配器注册/终端池/事件总线/执行日志管线），优雅退出时反向释放
import { DaemonOptionsError, parseDaemonOptions } from "./options.js";
import { createDaemonAssembly, type DaemonAssembly } from "./assembly/assembly.js";
import { keepAliveSilently } from "./hang.js";
import { DEFAULT_HELLO_TIMEOUT_MS, startDaemonServer, type DaemonServer } from "./server.js";

function writeListeningLine(port: number): void {
  process.stdout.write(`${JSON.stringify({ type: "listening", port })}\n`);
}

async function gracefulExit(server: DaemonServer, assembly: DaemonAssembly): Promise<void> {
  // 先关连接（触发客户端重连），再释放终端/落库余量/关库——退出帧尽力送达后连接才断
  await server.shutdown();
  await assembly.close();
  process.exitCode = 0;
  // P0-10：ConPTY 预热/native 句柄会吊住事件循环，自然退出不再发生（supervisor
  // 只能强杀 → exit code 丢失）。优雅路径在资源全释放后显式退出；unref 定时器
  // 延后一拍再 exit，让 pending stdio 刷完（Windows 管道下立即 exit 会截断 stderr），
  // 若循环此时已自然排空则直接以 exitCode 0 收尾，定时器不再触发。
  setTimeout(() => process.exit(0), 250).unref();
}

async function main(): Promise<void> {
  const options = parseDaemonOptions(process.env, process.argv.slice(2));
  if (options.hangSilent) {
    keepAliveSilently();
    return;
  }

  // 数据目录：env 注入缝（测试/E2E/后续 desktop launcher）；默认内存库。
  // TODO(P0-11)：desktop 传 userData 路径后改为必填或落默认策略。
  const dbPath = process.env["AETHER_DAEMON_DB_PATH"] ?? ":memory:";
  const assembly = createDaemonAssembly({ dbPath });

  const daemonServer = await startDaemonServer({
    token: options.token,
    helloTimeoutMs: DEFAULT_HELLO_TIMEOUT_MS,
    hangAfterHandshake: options.hangSignal,
    assembly,
    onShutdownRequested: () => {
      void gracefulExit(daemonServer, assembly);
    },
  });
  writeListeningLine(daemonServer.port);
  // ConPTY 预热必须在 listening 行之后（spawn 含同步段，会阻塞启动预算，见 assembly 注释）
  assembly.warmupConptyInBackground();
}

main().catch((error: unknown) => {
  const message =
    error instanceof DaemonOptionsError || error instanceof Error ? error.message : String(error);
  // 用 exitCode 自然退出而非 process.exit()：Windows 管道下 exit 会截断未刷完的 stderr
  process.stderr.write(`[aether-daemon] fatal: ${message}\n`);
  process.exitCode = 1;
});
