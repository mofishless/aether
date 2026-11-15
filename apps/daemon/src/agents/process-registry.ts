// 进程注册表（内存态，P0-11）：sessionId → 活跃会话运行句柄。
// followUp / cancel / permission.respond 就地查表；未注册 sessionId 回中文
// INVALID_PARAMS（RPC 层映射）。
//
// 生命周期定案（任务卡 deviations 口径）：
// - 自然完成不清理：追问（agents.followUp）在进程退出后仍须可达——条目保留；
// - cancel("user_cancelled") 后进程退出证明到达时清理（「进程退出后注册表清理」）；
// - daemon 重启后表清空：P0 不做持久恢复——重启后已存在会话只能经
//   sessions.listEvents 查历史，新操作一律 INVALID_PARAMS；持久化恢复随 P3-01
//   agents.resume 落地（此处注释即定案）。
import type { AgentStatus } from "@aether/contracts";
import type { AdapterContext, AgentAdapter, AgentProcess } from "@aether/core";

/** 状态机 fold 的可变观察对象（emit 泵写 / RPC 返回值读，spawn 期即存在） */
export interface StatusWatch {
  status: AgentStatus;
}

/**
 * 事件泵目标（ PumpTarget）：emit 三发接线所需的最小归属链。
 * spawn 期 entry 尚未成形（proc 待 adapter.spawn 返回），泵先绑定本对象；
 * 注册后 entry 以解构共享同一 watch / 状态，语义连续。
 */
export interface PumpTarget {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  /** 当前 run 的 execution_process 行 id（followUp 换行时推进） */
  processId: string;
  readonly watch: StatusWatch;
  /**
   * 待决权限请求 id 集合（permission_request 事件入列，应答/终态出列）。
   * Set 为引用共享：followUp 换 target 时复用同集合，requestId 反查跨轮有效
   * （permission_request 事件不携带 processId，渲染层应答时只能给 requestId）。
   */
  readonly pendingPermissionRequests: Set<string>;
}

/** 注册表条目：治理句柄 + 归属链 + 状态机观察对象。 */
export interface ProcessRegistryEntry extends PumpTarget {
  /** adapter 治理句柄（cancel/spawnFollowUp 目标；processId 是 adapter 侧运行时 id） */
  readonly proc: AgentProcess;
  /** 拥有该会话的 adapter 实例（dispose/cancel 就近可达） */
  readonly adapter: AgentAdapter;
  /** 当前 run 的事件上下文（emit 一路三发已接线；followUp 换新行时整体替换） */
  ctx: AdapterContext;
  readonly providerConfigId: string;
  readonly providerKind: string;
  /** cancel 已落地（进程退出证明到达时据此清理注册表） */
  cancelling: boolean;
  /** 退出证明已到达（cancel 时据此立即清理，避免等待已 settle 的 promise） */
  exitProofSettled: boolean;
}

/** sessionId 与 processId（行 id 或 adapter 运行时 id 均可）双索引内存注册表。 */
export class ProcessRegistry {
  private readonly bySessionId = new Map<string, ProcessRegistryEntry>();

  register(sessionId: string, entry: ProcessRegistryEntry): void {
    this.bySessionId.set(sessionId, entry);
  }

  findBySession(sessionId: string): ProcessRegistryEntry | null {
    return this.bySessionId.get(sessionId) ?? null;
  }

  /** 按 processId 查（agents.permission.respond 入参）：匹配 execution_process 行 id
   *  或 adapter 运行时 processId——两个 id 都可能出现在 UI 侧句柄里。 */
  findByProcessId(processId: string): ProcessRegistryEntry | null {
    for (const entry of this.bySessionId.values()) {
      if (entry.processId === processId || entry.proc.processId === processId) {
        return entry;
      }
    }
    return null;
  }

  /** 按 requestId 反查（permission.respond 缺省 processId 时）：仅命中持有该
   *  待决权限请求的会话——多会话并发等待时按请求精确归属，不会误投。 */
  findByRequestId(requestId: string): ProcessRegistryEntry | null {
    for (const entry of this.bySessionId.values()) {
      if (entry.pendingPermissionRequests.has(requestId)) {
        return entry;
      }
    }
    return null;
  }

  remove(sessionId: string): void {
    this.bySessionId.delete(sessionId);
  }

  /** 全部条目快照（dispose 收口遍历用） */
  entries(): readonly ProcessRegistryEntry[] {
    return [...this.bySessionId.values()];
  }

  get size(): number {
    return this.bySessionId.size;
  }
}
