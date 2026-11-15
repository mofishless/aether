import { app, BrowserWindow, ipcMain } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createDaemonSupervisor } from "./daemon/supervisor.js";
import { DAEMON_ENDPOINT_CHANNEL } from "./renderer-bridge.js";
import { isTestBridgeEnabled, TEST_BRIDGE_DAEMON_STATUS_CHANNEL } from "./test-bridge.js";

// 主进程零领域逻辑（SYSTEM_DESIGN §1.2）：窗口生命周期 + daemon 拉起监护（launcher，P0-03）
// + 测试桥 IPC。diff / Git / 状态推断一律在 daemon 子进程内。

// daemon 入口锚点：app path = apps/desktop（dev 与打包前形态一致），产物在姊妹包的 dist。
const daemonEntryPath = path.resolve(app.getAppPath(), "..", "daemon", "dist", "index.js");

// daemon 数据目录策略（P0-10 遗留收口）：默认 userData/aether.db（持久）；
// env 已设 AETHER_DAEMON_DB_PATH 时让位（E2E 隔离库/开发自定义同缝注入）。
// AETHER_AGENT_CLI_PATH / AETHER_MOCK_SCRIPT 等经 process.env 继承自动透传给 daemon。
const daemonDbPath =
  process.env["AETHER_DAEMON_DB_PATH"] ?? path.join(app.getPath("userData"), "aether.db");
mkdirSync(path.dirname(daemonDbPath), { recursive: true });

const supervisor = createDaemonSupervisor({
  daemonEntryPath,
  extraSpawnEnv: { AETHER_DAEMON_DB_PATH: daemonDbPath },
  onStateChange: (status) => {
    if (status.state === "reconnecting") {
      console.error(
        `[aether] daemon 重连中（restart=${status.restartCount}）：${status.lastError}`,
      );
    }
  },
});

// daemon endpoint 查询通道（P0-10 生产通道，非测试桥）：渲染层每次（重）连前 invoke，
// 拿当前 port/token 直连 daemon WS。生命周期管理之外零逻辑——只透传 supervisor 快照面。
ipcMain.handle(DAEMON_ENDPOINT_CHANNEL, () => supervisor.getEndpoint());

// 测试桥（仅测试用途，命名带 aether:test: 前缀）：E2E 读 supervisor 状态快照。
// 门禁（spec-review #6）：仅 AETHER_TEST_BRIDGE=1 时注册；生产默认通道不存在，
// 渲染端即使 invoke 也不会命中 handler。
if (isTestBridgeEnabled()) {
  ipcMain.handle(TEST_BRIDGE_DAEMON_STATUS_CHANNEL, () => supervisor.getStatus());
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Aether",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();

  // daemon 产物缺失时降级：console.warn 不 crash（E2E/开发前提是已 pnpm build）
  if (existsSync(daemonEntryPath)) {
    supervisor.start().catch((error: unknown) => {
      console.error(`[aether] daemon 启动失败：${error instanceof Error ? error.message : error}`);
    });
  } else {
    console.warn(
      `[aether] daemon 入口不存在（${daemonEntryPath}），先执行 pnpm build；本次运行无 daemon`,
    );
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 优雅退出：先停 daemon（system.shutdown → 2s 宽限 → SIGKILL 兜底）再真正退出
let daemonStopRequested = false;
app.on("before-quit", (event) => {
  if (daemonStopRequested) return;
  daemonStopRequested = true;
  event.preventDefault();
  void supervisor
    .stop()
    .catch(() => undefined)
    .then(() => {
      app.quit();
    });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
