import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AgentStatus as ContractsAgentStatus,
  AutonomyLevel as ContractsAutonomyLevel,
  PermissionDecision as ContractsPermissionDecision,
  ProviderEvent,
  ProviderKind as ContractsProviderKind,
  Session as ContractsSession,
} from "@aether/contracts";
import type {
  AdapterCapabilities,
  AdapterContext,
  AgentAdapter,
  AgentProcess,
  AgentStatus,
  AutonomyLevel,
  CancelReason,
  DiscoverResult,
  PermissionDecision,
  ProviderKind,
  ResolvedProviderConfig,
  SessionRecord,
  SpawnInput,
} from "../src/index.js";

// 端口类型编译期断言（任务卡 P0-07 TDD 第 3 条）：
// 1) AgentAdapter 结构与 SYSTEM_DESIGN §6.2 签名形状逐字对齐；
// 2) 枚举零重复定义——core 的对外类型与 @aether/contracts 同一（类型恒等断言）。
// expectTypeOf 断言由 `pnpm --filter @aether/core typecheck` 强制（vitest 运行时本身不查类型）。

describe("AgentAdapter §6.2 形状断言", () => {
  it("属性：kind / capabilities", () => {
    expectTypeOf<AgentAdapter["kind"]>().toEqualTypeOf<ProviderKind>();
    expectTypeOf<AgentAdapter["capabilities"]>().toEqualTypeOf<AdapterCapabilities>();
  });

  it("九成员方法签名逐字对齐", () => {
    expectTypeOf<AgentAdapter["discover"]>().toEqualTypeOf<() => Promise<DiscoverResult>>();
    expectTypeOf<AgentAdapter["spawn"]>().toEqualTypeOf<
      (input: SpawnInput, ctx: AdapterContext) => Promise<AgentProcess>
    >();
    expectTypeOf<AgentAdapter["spawnFollowUp"]>().toEqualTypeOf<
      (proc: AgentProcess, input: { message: string }, ctx: AdapterContext) => Promise<void>
    >();
    expectTypeOf<AgentAdapter["resume"]>().toEqualTypeOf<
      (session: SessionRecord, ctx: AdapterContext) => Promise<AgentProcess>
    >();
    expectTypeOf<AgentAdapter["cancel"]>().toEqualTypeOf<
      (proc: AgentProcess, reason: CancelReason) => Promise<void>
    >();
    expectTypeOf<AgentAdapter["resolvePermission"]>().toEqualTypeOf<
      (processId: string, requestId: string, decision: PermissionDecision) => Promise<void>
    >();
    expectTypeOf<AgentAdapter["normalizeLogs"]>().toEqualTypeOf<
      (raw: unknown[]) => ProviderEvent[]
    >();
    expectTypeOf<AgentAdapter["dispose"]>().toEqualTypeOf<() => Promise<void>>();
  });

  it("AgentProcess 形状（processId / pid / cancel / exited 退出证明）", () => {
    expectTypeOf<AgentProcess["processId"]>().toEqualTypeOf<string>();
    expectTypeOf<AgentProcess["pid"]>().toEqualTypeOf<number | null>();
    expectTypeOf<AgentProcess["cancel"]>().toEqualTypeOf<(reason: CancelReason) => Promise<void>>();
    expectTypeOf<AgentProcess["exited"]>().toEqualTypeOf<
      Promise<{ code: number | null; signal?: string }>
    >();
  });

  it("AdapterContext 形状（emit / worktreePath / env / loadEvents）", () => {
    expectTypeOf<AdapterContext["emit"]>().toEqualTypeOf<(ev: ProviderEvent) => void>();
    expectTypeOf<AdapterContext["worktreePath"]>().toEqualTypeOf<string>();
    expectTypeOf<AdapterContext["env"]>().toEqualTypeOf<Record<string, string>>();
    expectTypeOf<AdapterContext["loadEvents"]>().toEqualTypeOf<
      (sessionId: string) => Promise<ProviderEvent[]>
    >();
  });

  it("AdapterCapabilities 形状（五字段）", () => {
    expectTypeOf<AdapterCapabilities["canResume"]>().toEqualTypeOf<boolean>();
    expectTypeOf<AdapterCapabilities["followUpAtMessage"]>().toEqualTypeOf<boolean>();
    expectTypeOf<AdapterCapabilities["permissionFlags"]>().toEqualTypeOf<boolean>();
    expectTypeOf<AdapterCapabilities["structuredEvents"]>().toEqualTypeOf<boolean>();
    expectTypeOf<AdapterCapabilities["protocols"]>().toEqualTypeOf<readonly string[]>();
  });
});

describe("枚举零重复定义（唯一来源 @aether/contracts）", () => {
  it("core 转发类型与 contracts 类型恒等", () => {
    expectTypeOf<ProviderKind>().toEqualTypeOf<ContractsProviderKind>();
    expectTypeOf<AutonomyLevel>().toEqualTypeOf<ContractsAutonomyLevel>();
    expectTypeOf<PermissionDecision>().toEqualTypeOf<ContractsPermissionDecision>();
    expectTypeOf<AgentStatus>().toEqualTypeOf<ContractsAgentStatus>();
  });

  it("SessionRecord 即 contracts Session（§6.2 名字定案，实体不重复定义）", () => {
    expectTypeOf<SessionRecord>().toEqualTypeOf<ContractsSession>();
  });
});

describe("core 定案类型形状", () => {
  it("CancelReason：三个既定字面量开放可扩展（非裸 string 塌缩的开放联合）", () => {
    // 显式注解的赋值 = 编译期可赋值性检查（typecheck 强制）
    const reasons: CancelReason[] = [
      "user_cancelled",
      "process_exit",
      "shutdown",
      "adapter-defined",
    ];
    expect(reasons).toHaveLength(4);
    type LiteralsExtend = "user_cancelled" | "process_exit" | "shutdown" extends CancelReason
      ? true
      : false;
    type AnyStringExtends = string extends CancelReason ? true : false;
    expectTypeOf<LiteralsExtend>().toEqualTypeOf<true>();
    expectTypeOf<AnyStringExtends>().toEqualTypeOf<true>();
  });

  it("DiscoverResult：available + 可选 version/installHint", () => {
    expectTypeOf<DiscoverResult["available"]>().toEqualTypeOf<boolean>();
    expectTypeOf<DiscoverResult["version"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<DiscoverResult["installHint"]>().toEqualTypeOf<string | undefined>();
  });

  it("SpawnInput：sessionId/message/autonomy/model（workspacePath 与 env 由 AdapterContext 携带，不重复）", () => {
    expectTypeOf<SpawnInput["sessionId"]>().toEqualTypeOf<string>();
    expectTypeOf<SpawnInput["message"]>().toEqualTypeOf<string>();
    expectTypeOf<SpawnInput["autonomy"]>().toEqualTypeOf<ContractsAutonomyLevel>();
    expectTypeOf<SpawnInput["model"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<SpawnInput>().not.toMatchTypeOf<{ workspacePath: string }>();
    expectTypeOf<SpawnInput>().not.toMatchTypeOf<{ env: Record<string, string> }>();
  });

  it("ResolvedProviderConfig：AdapterFactory 入参最小形状", () => {
    expectTypeOf<ResolvedProviderConfig["kind"]>().toEqualTypeOf<ContractsProviderKind>();
    expectTypeOf<ResolvedProviderConfig["providerConfigId"]>().toEqualTypeOf<string>();
    expectTypeOf<ResolvedProviderConfig["displayName"]>().toEqualTypeOf<string>();
    expectTypeOf<ResolvedProviderConfig["config"]>().toEqualTypeOf<
      Readonly<Record<string, unknown>>
    >();
  });
});

describe("AgentAdapter 结构可实现性（运行时冒烟）", () => {
  it("最小 satisfies 实现可通过结构检查并在运行时可调用", () => {
    const capabilities = {
      canResume: true,
      followUpAtMessage: true,
      permissionFlags: true,
      structuredEvents: true,
      protocols: [],
    } as const satisfies AdapterCapabilities;

    const process: AgentProcess = {
      processId: "proc-1",
      pid: 4321,
      cancel: async () => {},
      exited: Promise.resolve({ code: 0 }),
    };

    const adapter = {
      kind: "claude-sdk",
      capabilities,
      discover: async (): Promise<DiscoverResult> => ({ available: true, version: "1.0.0" }),
      spawn: async (): Promise<AgentProcess> => process,
      spawnFollowUp: async (): Promise<void> => {},
      resume: async (): Promise<AgentProcess> => process,
      cancel: async (): Promise<void> => {},
      resolvePermission: async (): Promise<void> => {},
      normalizeLogs: (raw: unknown[]): ProviderEvent[] => (raw.length === 0 ? [] : []),
      dispose: async (): Promise<void> => {},
    } satisfies AgentAdapter;

    expect(adapter.kind).toBe("claude-sdk");
    expect(adapter.capabilities.canResume).toBe(true);
    expect(adapter.normalizeLogs([])).toEqual([]);
    expectTypeOf(adapter).toExtend<AgentAdapter>();
  });
});
