// P0-11 渲染入口：React 驾驶舱 + RPC 客户端装配。
// 数据通道唯一形态：preload 注入 endpoint → WS 直连 daemon（contracts 契约），不经主进程转发。
// 事件分发：onEvent → 连接计数（骨架观测）+ app-store 领域状态；连接 established →
// handleConnected（订阅接线 + 初始数据拉取，重连幂等重跑）。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { createDaemonRpcClient } from "./rpc/rpc-client.js";
import {
  applyEventEnvelope,
  configureAppStore,
  handleConnected,
  type RpcParams,
  type RpcPort,
} from "./state/app-store.js";
import { applyClientSnapshot, recordEvent } from "./state/connection-store.js";
import "./styles.css";

const container = document.getElementById("app");
if (container === null) {
  throw new Error("渲染入口缺失 #app 节点（index.html 被改动？）");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// preload 缺失（异常环境/单测导入）时不启动连接循环，UI 保持初始 connecting 态
const bridge = window.aether;
if (bridge !== undefined) {
  const client = createDaemonRpcClient({
    fetchEndpoint: () => bridge.getDaemonEndpoint(),
    onSnapshot: (snapshot) => {
      applyClientSnapshot(snapshot);
      if (snapshot.state === "connected") {
        void handleConnected();
      }
    },
    onEvent: (envelope) => {
      recordEvent();
      applyEventEnvelope(envelope);
    },
  });
  // 注入缝：组件一律经 store 动作调用 RPC（渲染层纪律，renderer-boundary 测试锁定）
  const rpcPort: RpcPort = {
    request: <T,>(method: string, params?: RpcParams) => client.request<T>(method, params),
  };
  configureAppStore(rpcPort);
  client.start();
}
