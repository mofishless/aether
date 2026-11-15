import { app, BrowserWindow } from "electron";
import path from "node:path";

// P0-01 空壳窗口。领域逻辑（spawn daemon、RPC、worktree…）一律不进主进程——
// daemon 拉起在 P0-03 落地（T3 DesktopBackendManager 式，见 SYSTEM_DESIGN §1.2）。

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

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
