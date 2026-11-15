import type { DatabaseSync } from "node:sqlite";
import type { ProviderConfigKind } from "@aether/contracts";
import { AgentProfileRepository } from "./repositories/agent-profile.repository.js";
import { ProviderConfigRepository } from "./repositories/provider-config.repository.js";

const DEFAULT_PROVIDER_KIND: ProviderConfigKind = "claude-sdk";
const DEFAULT_PROVIDER_DISPLAY_NAME = "Claude Code (SDK)";
const DEFAULT_PROFILE_NAME = "Default Claude";

/**
 * 默认行种子（TASK_LIST P0-04）：默认 claude-sdk provider_config + 全局 agent_profile。
 *
 * ensure-exists 语义：每次 openStorage 都执行检查补齐默认行——用户删除默认
 * agent_profile 后重启会被复活，视为"出厂默认的保守行为"（与任务卡"首次运行种子"
 * 措辞的差异已在 spec-review 中裁决：保持 ensure-exists 并文档化+测试锁定，非一次性引导）。
 *
 * 幂等：库内已有 provider_config（或默认行已存在）则跳过。
 * 说明：分步插入而非单事务——若中途失败，下一次 seedDefaults 会补齐缺失的一半，
 * 仍收敛到"恰好一套默认行"。
 */
export function seedDefaults(db: DatabaseSync): void {
  const configs = new ProviderConfigRepository(db);
  const profiles = new AgentProfileRepository(db);

  const existingConfigs = configs.findAll();
  let providerConfigId: string;
  if (existingConfigs.length === 0) {
    const created = configs.create({
      kind: DEFAULT_PROVIDER_KIND,
      displayName: DEFAULT_PROVIDER_DISPLAY_NAME,
    });
    providerConfigId = created.id;
  } else {
    const defaultConfig = existingConfigs.find(
      (config) =>
        config.kind === DEFAULT_PROVIDER_KIND &&
        config.displayName === DEFAULT_PROVIDER_DISPLAY_NAME,
    );
    if (defaultConfig === undefined) {
      return; // 用户已有自己的配置且无默认配置：不越权插入默认行
    }
    providerConfigId = defaultConfig.id;
  }

  const hasDefaultProfile = profiles
    .findAll()
    .some((profile) => profile.projectId === null && profile.name === DEFAULT_PROFILE_NAME);
  if (!hasDefaultProfile) {
    profiles.create({
      projectId: null, // NULL = 全局可用
      name: DEFAULT_PROFILE_NAME,
      providerConfigId,
    });
  }
}
