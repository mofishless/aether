// WS 服务器装配：ws 库 + 握手状态机 + RPC 路由。绑定 127.0.0.1:0（随机端口，§5.1）。
// 进程退出策略不在此层（可测性）：shutdown 由入口/测试驱动，onShutdownRequested 只回调通知。
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { PROTOCOL_VERSION } from "@aether/contracts";
import { CLOSE_CODES } from "./close-codes.js";
import { validateHello, type DaemonVersions } from "./handshake.js";
import { blockEventLoopForever } from "./hang.js";
import { routeMessage, type RouterDeps } from "./rpc/router.js";
import { DAEMON_VERSION } from "./version.js";

/** hello 超时（任务卡 P0-03：3s 内必须收到合法 hello，否则断开） */
export const DEFAULT_HELLO_TIMEOUT_MS = 3000;

export interface DaemonServerOptions {
  /** 一次性 token（env 注入）。只存内存、绝不写日志/stdout。 */
  readonly token: string;
  /** hello 超时 ms，默认 3000（测试可注入小值） */
  readonly helloTimeoutMs?: number;
  /** --hang-signal：握手 welcome 帧写完后真阻塞事件循环（阶段 2 心跳超时 fixture） */
  readonly hangAfterHandshake?: boolean;
  /** system.shutdown 的 Success 帧写完后触发（入口在此执行优雅退出） */
  readonly onShutdownRequested?: () => void;
}

export interface DaemonServer {
  /** 实际监听端口（port 0 随机分配后的真实值） */
  readonly port: number;
  /** 优雅关闭：所有连接 close 1001 → server.close → resolve；幂等 */
  shutdown(): Promise<void>;
}

interface ConnectionContext {
  readonly ws: WebSocket;
  readonly token: string;
  readonly helloTimeoutMs: number;
  readonly hangAfterHandshake: boolean;
  readonly versions: DaemonVersions;
  readonly routerDeps: RouterDeps;
  readonly onShutdownRequested: (() => void) | undefined;
}

// 连接状态机（awaitingHello → ready）是固有的可变运行时状态；用最小局部 flag 表达。
function setupConnection(context: ConnectionContext): void {
  const {
    ws,
    token,
    helloTimeoutMs,
    hangAfterHandshake,
    versions,
    routerDeps,
    onShutdownRequested,
  } = context;
  const state = { authenticated: false };

  const helloTimer = setTimeout(() => {
    ws.close(CLOSE_CODES.HELLO_TIMEOUT, "hello timeout");
  }, helloTimeoutMs);
  ws.on("close", () => {
    clearTimeout(helloTimer);
  });
  // 客户端中途断连属正常（窗口关闭等），不视为服务器错误
  ws.on("error", () => undefined);

  ws.on("message", (data: RawData) => {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const raw = data.toString();
    if (!state.authenticated) {
      handlePreHelloMessage(raw);
      return;
    }
    handleRpcMessage(raw);
  });

  function handlePreHelloMessage(raw: string): void {
    const outcome = validateHello(raw, token, versions);
    if (outcome.kind === "close") {
      ws.close(outcome.code, outcome.reason);
      return;
    }
    clearTimeout(helloTimer);
    state.authenticated = true;
    if (hangAfterHandshake) {
      // send 回调 = welcome 帧已写入 socket（客户端能收到）；随后真阻塞：
      // 不再回任何帧/不处理关闭，供阶段 2 心跳超时判定
      ws.send(JSON.stringify(outcome.welcome), () => blockEventLoopForever());
      return;
    }
    ws.send(JSON.stringify(outcome.welcome));
  }

  function handleRpcMessage(raw: string): void {
    const outcome = routeMessage(raw, routerDeps);
    if (outcome.kind === "none") {
      return;
    }
    if (outcome.kind === "response") {
      ws.send(outcome.frame);
      return;
    }
    // response-and-shutdown：Success 帧写完后才触发优雅退出（客户端先拿到应答）
    ws.send(outcome.frame, () => onShutdownRequested?.());
  }
}

export function startDaemonServer(options: DaemonServerOptions): Promise<DaemonServer> {
  const {
    token,
    helloTimeoutMs = DEFAULT_HELLO_TIMEOUT_MS,
    hangAfterHandshake = false,
    onShutdownRequested,
  } = options;
  const versions: DaemonVersions = {
    protocolVersion: PROTOCOL_VERSION,
    daemonVersion: DAEMON_VERSION,
  };
  const routerDeps: RouterDeps = {
    daemonVersion: DAEMON_VERSION,
    protocolVersion: PROTOCOL_VERSION,
  };

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  // 持续错误兜底：有监听器即不 crash 进程，诊断走 stderr（token 绝不输出）
  wss.on("error", (error: Error) => {
    process.stderr.write(`[aether-daemon] server error: ${error.message}\n`);
  });

  return new Promise<DaemonServer>((resolve, reject) => {
    wss.once("error", reject);
    wss.on("listening", () => {
      const address = wss.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error(`unexpected server address: ${String(address)}`));
        return;
      }
      resolve(createHandle(wss, address.port));
    });
    wss.on("connection", (ws: WebSocket) => {
      setupConnection({
        ws,
        token,
        helloTimeoutMs,
        hangAfterHandshake,
        versions,
        routerDeps,
        onShutdownRequested,
      });
    });
  });
}

function createHandle(wss: WebSocketServer, port: number): DaemonServer {
  let shutdownPromise: Promise<void> | undefined;
  return {
    port,
    shutdown: () => {
      shutdownPromise ??= new Promise<void>((resolve, reject) => {
        for (const client of wss.clients) {
          client.close(CLOSE_CODES.DAEMON_SHUTDOWN, "daemon shutting down");
        }
        wss.close((error?: Error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      return shutdownPromise;
    },
  };
}
