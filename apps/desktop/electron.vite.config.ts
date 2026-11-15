import { defineConfig } from "electron-vite";

// 三段构建（main / preload / renderer）使用 electron-vite 默认布局：
// src/main/index.ts · src/preload/index.ts · src/renderer/index.html → out/
// 注意：v6 起空配置对象会跳过构建（resolveConfig 只构建显式给出的段），三段必须显式声明。
// tsconfig 拆分（P0-10 已落地）：主/预载走 tsconfig.json（Node 规则），渲染走
// tsconfig.renderer.json（DOM 规则，无 node types）；两份 tsc 由 typecheck script 覆盖。
//
// v6 默认注入 externalizeDeps：package.json 全部 dependencies 一律 external。
// @aether/contracts 是 workspace 链接的 TS 源码包（exports 指向 src/index.ts），external 后
// 运行时加载 .ts 源会因内部未改写的 .js 相对引用直接失败——必须排除出 external 列表、
// 内联进产物（zod 随之打入）。与 daemon tsup 的 noExternal 同理。ws 是常规 JS 包，保持
// external（node_modules 运行时可解析）。渲染段是常规 vite 构建：react/react-dom/zustand/
// @aether/contracts（连带 zod）全部内联进产物，无 external 概念。
export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        exclude: ["@aether/contracts"],
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: {
        exclude: ["@aether/contracts"],
      },
    },
  },
  renderer: {},
});
