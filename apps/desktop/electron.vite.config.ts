import { defineConfig } from "electron-vite";

// 三段构建（main / preload / renderer）使用 electron-vite 默认布局：
// src/main/index.ts · src/preload/index.ts · src/renderer/index.html → out/
// 注意：v6 起空配置对象会跳过构建（resolveConfig 只构建显式给出的段），三段必须显式声明。
// 渲染层 DOM 规则、主/预载 Node 规则的 tsconfig 拆分在 P0-10 渲染骨架时引入。
export default defineConfig({
  main: {},
  preload: {},
  renderer: {},
});
