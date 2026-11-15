import { describe, expect, it } from "vitest";
import type { AgentProcess, ResolvedProviderConfig } from "../src/index.js";
import {
  createAdapter,
  registerAdapter,
  type AdapterFactory,
  type AgentAdapter,
} from "../src/index.js";

// 注册机制（SYSTEM_DESIGN §6.4）：AdapterFactory + registerAdapter/createAdapter；
// P0 实现 = 模块级 Map；daemon 启动时注册内置 kind，core 自身不预置任何实现。

const capabilities = {
  canResume: false,
  followUpAtMessage: false,
  permissionFlags: false,
  structuredEvents: true,
  protocols: [],
} as const;

function fakeAdapter(kind: ResolvedProviderConfig["kind"]): AgentAdapter {
  return {
    kind,
    capabilities,
    discover: async () => ({ available: false, installHint: "安装它" }),
    spawn: async () => fakeProcess(),
    spawnFollowUp: async () => {},
    resume: async () => fakeProcess(),
    cancel: async () => {},
    resolvePermission: async () => {},
    normalizeLogs: () => [],
    dispose: async () => {},
  };
}

function fakeProcess(): AgentProcess {
  return {
    processId: "proc-1",
    pid: null,
    cancel: async () => {},
    exited: Promise.resolve({ code: null, signal: "SIGKILL" }),
  };
}

describe("registerAdapter / createAdapter", () => {
  it("注册后 createAdapter 以 cfg 调用工厂并返回其产物", () => {
    const seen: ResolvedProviderConfig[] = [];
    const factory: AdapterFactory = (cfg) => {
      seen.push(cfg);
      return fakeAdapter(cfg.kind);
    };
    const cfg: ResolvedProviderConfig = {
      kind: "claude-sdk",
      providerConfigId: "pc-1",
      displayName: "Claude",
      config: {},
    };

    registerAdapter("claude-sdk", factory);
    const adapter = createAdapter(cfg);

    expect(seen).toEqual([cfg]);
    expect(adapter.kind).toBe("claude-sdk");
    expect(adapter.capabilities.structuredEvents).toBe(true);
  });

  it("未注册的 kind 抛错，消息含该 kind 与已注册清单", () => {
    registerAdapter("custom", () => fakeAdapter("custom"));

    let caught: unknown;
    try {
      createAdapter({ kind: "tui", providerConfigId: "pc-2", displayName: "TUI", config: {} });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("tui");
    expect(message).toContain("custom");
  });

  it("P0 占位 kind（acp/tui）core 默认不注册——注册动作属于 daemon 启动", () => {
    expect(() =>
      createAdapter({ kind: "acp", providerConfigId: "pc-3", displayName: "ACP", config: {} }),
    ).toThrow(/acp/);
  });

  it("同 kind 重复注册以后者替换（last-wins，供测试与未来热替换）", async () => {
    const first: AdapterFactory = () => fakeAdapter("codex-app-server");
    const second: AdapterFactory = () => ({
      ...fakeAdapter("codex-app-server"),
      normalizeLogs: () => [],
      discover: async () => ({ available: true, version: "second" }),
    });

    registerAdapter("codex-app-server", first);
    registerAdapter("codex-app-server", second);

    const adapter = createAdapter({
      kind: "codex-app-server",
      providerConfigId: "pc-4",
      displayName: "Codex",
      config: {},
    });
    await expect(adapter.discover()).resolves.toEqual({ available: true, version: "second" });
  });

  it("工厂收到的是同一 cfg 对象语义（不强制拷贝，字段逐项一致）", () => {
    let received: ResolvedProviderConfig | undefined;
    registerAdapter("custom", (cfg) => {
      received = cfg;
      return fakeAdapter(cfg.kind);
    });
    const cfg: ResolvedProviderConfig = {
      kind: "custom",
      providerConfigId: "pc-5",
      displayName: "GLM",
      config: { protocol: "openai-chat" },
    };
    createAdapter(cfg);
    expect(received).toBeDefined();
    expect(received?.kind).toBe("custom");
    expect(received?.config).toEqual({ protocol: "openai-chat" });
  });
});
