// P1-01 支撑件：provider 会话恢复能力差异的渲染层静态标注表。
// 数据来源纪律：daemon 侧才注册适配器（@aether/adapters-codex），渲染层不得依赖
// 任何适配器包——本表是 renderer 内常量，仅类型 import contracts 的 ProviderKind
// （renderer-boundary 白名单允许）。内容口径：docs/research/codex/app-server-protocol.md
// §5"与 Claude --resume 的差异"定案表；daemon 侧 providers 数据流（后续 catalog 卡）
// 落地后由真实数据取代，本表退化为缺省标注。canResume 徽标带"入口随 P3-01 落地"
// 限定语（P1-01 评审 F7）：能力为真但 UI 无用户可达恢复入口，不放话。
import type { ProviderKind } from "@aether/contracts";

/** 单个 provider 的能力标注（UI 展示用纯数据，全 readonly 防原地篡改） */
export interface ProviderCapability {
  readonly kind: ProviderKind;
  /** UI 显示名（provider kind 标签） */
  readonly label: string;
  /** 是否支持会话恢复（AdapterCapabilities.canResume 口径） */
  readonly canResume: boolean;
  /** 恢复机制一句话说明 */
  readonly resumeSummary: string;
  /** 能力差异徽标条目（模块级冻结常量：同 kind 重复取用引用稳定，防渲染抖动） */
  readonly badges: readonly string[];
}

/** 全部 ProviderKind 的能力表（含 P2+ 占位 kind 的"能力未定"标注，键完备由类型保证） */
export const PROVIDER_CAPABILITIES: Readonly<Record<ProviderKind, ProviderCapability>> =
  Object.freeze({
    "claude-sdk": Object.freeze({
      kind: "claude-sdk",
      label: "Claude SDK",
      canResume: true,
      resumeSummary: "恢复目标经 CLI 参数选择（Options.resume / --resume）",
      badges: Object.freeze([
        "支持会话恢复（--resume，入口随 P3-01 落地）",
        "历史水合：SDK 内部完成",
        "运行中会话：不支持 rejoin",
      ]),
    }),
    "codex-app-server": Object.freeze({
      kind: "codex-app-server",
      label: "Codex app-server",
      canResume: true,
      resumeSummary: "恢复目标是一等 RPC 参数（thread/resume {threadId}）",
      badges: Object.freeze([
        "支持会话恢复（thread/resume，入口随 P3-01 落地）",
        "历史水合：响应内嵌 turns，可游标分页",
        "运行中会话：支持 rejoin（重新接入并收后续事件）",
      ]),
    }),
    custom: Object.freeze({
      kind: "custom",
      label: "自定义 provider",
      canResume: false,
      resumeSummary: "恢复能力随 provider 配置而定",
      badges: Object.freeze(["恢复能力未知（随配置）"]),
    }),
    acp: Object.freeze({
      kind: "acp",
      label: "ACP",
      canResume: false,
      resumeSummary: "P2+ 扩展位，能力未定",
      badges: Object.freeze(["P2+ 扩展位（能力未定）"]),
    }),
    tui: Object.freeze({
      kind: "tui",
      label: "TUI",
      canResume: false,
      resumeSummary: "P2+ 扩展位，能力未定",
      badges: Object.freeze(["P2+ 扩展位（能力未定）"]),
    }),
  });

/** 启动面板可选的 provider kind（MVP 两种；custom/acp/tui 不进选择器） */
export const SPAWN_PROVIDER_KINDS: readonly ProviderKind[] = Object.freeze([
  "claude-sdk",
  "codex-app-server",
]);

/** 运行时窄化守卫：store 动作入参在系统边界校验（未知 kind 拒绝，不静默吞） */
export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === "string" && value in PROVIDER_CAPABILITIES;
}

/** 取某 kind 的能力标注（键已由类型与守卫保证存在；返回模块级冻结常量） */
export function capabilityOf(kind: ProviderKind): ProviderCapability {
  return PROVIDER_CAPABILITIES[kind];
}
