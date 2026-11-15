// P0-10 渲染入口：React 骨架 + RPC 客户端装配。
// 数据通道唯一形态：preload 注入 endpoint → WS 直连 daemon（contracts 契约），不经主进程转发。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { createDaemonRpcClient } from "./rpc/rpc-client.js";
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
    onSnapshot: applyClientSnapshot,
    onEvent: recordEvent,
  });
  client.start();
}
