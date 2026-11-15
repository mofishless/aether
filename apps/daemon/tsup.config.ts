import { defineConfig } from "tsup";

// contracts 以 TS 源码形态被 workspace 消费（exports 指向 src/index.ts，见其包注释）。
// 必须内联进 dist：否则 dist 在运行时 import "@aether/contracts" 会命中 .ts 源文件，
// 旧版 Node（<23.6 无原生 type-stripping）无法加载。CLI 不支持 --noExternal，故置于 config。
export default defineConfig({
  noExternal: ["@aether/contracts"],
});
