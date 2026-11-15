// preload 经 contextBridge 注入的 window.aether 类型面（渲染层唯一宿主能力入口，验收①类型化通道）。
// 可选（?）：node 环境单测导入渲染模块时 window 上不存在该对象。
import type { DaemonEndpoint } from "./rpc/rpc-client.js";

declare global {
  interface Window {
    readonly aether?: {
      readonly platform: string;
      readonly electronVersion: string;
      /** 取当前 daemon endpoint（每次（重）连前调用；supervisor 重启后 port/token 换新） */
      getDaemonEndpoint(): Promise<DaemonEndpoint | null>;
    };
  }
}

declare module "*.css";

// （CSS 模块声明见 css.d.ts——通配 ambient 需独立非模块文件）
