import { contextBridge } from "electron";

// 渲染进程通往主进程的唯一入口（P0-10 起经 @aether/contracts 直连 daemon，preload 只保留壳层桥）。
const bridge = {
  platform: process.platform,
  electronVersion: process.versions.electron,
};

contextBridge.exposeInMainWorld("aether", bridge);
