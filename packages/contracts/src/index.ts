// @aether/contracts —— desktop 渲染与 daemon 的唯一类型边界（SYSTEM_DESIGN §5）。
// 以 TS 源码形态被 workspace 内直接消费（bundler resolution）；daemon 集成时的 tsup bundle 在 P0-03 接入。
export * from "./domain.js";
export * from "./rpc.js";
export * from "./events.js";
export * from "./provider-event.js";
export * from "./terminal.js";
export * from "./custom-provider.js";
export * from "./hello.js";
