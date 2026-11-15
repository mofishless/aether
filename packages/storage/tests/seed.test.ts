import { afterAll, describe, expect, it } from "vitest";
import {
  AgentProfileRepository,
  ProviderConfigRepository,
  closeDatabase,
  openStorage,
  seedDefaults,
} from "../src/index.js";
import { createDbTestContext, expectIsoTimestamp, expectNotNull, firstOf } from "./helpers.js";

describe("种子（seedDefaults）", () => {
  const ctx = createDbTestContext();
  afterAll(() => ctx.dispose());

  it("fresh 库插入默认 claude-sdk 配置与全局 agent_profile，字段符合口径", () => {
    const db = openStorage(":memory:");
    const configs = new ProviderConfigRepository(db);
    const profiles = new AgentProfileRepository(db);

    const configList = configs.findAll();
    expect(configList).toHaveLength(1);
    const config = expectNotNull(configList[0] ?? null);
    expect(config.kind).toBe("claude-sdk");
    expect(config.displayName).toBe("Claude Code (SDK)");
    expect(config.configJson).toBe("{}");
    expectIsoTimestamp(config.createdAt);
    expectIsoTimestamp(config.updatedAt);

    const profileList = profiles.findAll();
    expect(profileList).toHaveLength(1);
    const profile = expectNotNull(profileList[0] ?? null);
    expect(profile.projectId).toBeNull(); // NULL = 全局可用
    expect(profile.name).toBe("Default Claude");
    expect(profile.providerConfigId).toBe(config.id); // 引用默认配置
  });

  it("seedDefaults 二次调用幂等：仍只有一套默认行", () => {
    const db = openStorage(":memory:");
    seedDefaults(db);
    seedDefaults(db);
    const configs = new ProviderConfigRepository(db);
    const profiles = new AgentProfileRepository(db);
    expect(configs.findAll()).toHaveLength(1);
    expect(profiles.findAll()).toHaveLength(1);
  });

  it("openStorage 同一文件库二次引导：种子不重复", () => {
    const path = ctx.nextDbPath();
    const first = ctx.track(openStorage(path));
    closeDatabase(first);
    const second = ctx.track(openStorage(path));
    const configs = new ProviderConfigRepository(second);
    const profiles = new AgentProfileRepository(second);
    expect(configs.findAll()).toHaveLength(1);
    expect(profiles.findAll()).toHaveLength(1);
  });

  it("ensure-exists 语义锁定：删除默认 profile 后 seedDefaults 会复活，且引用同一 provider_config", () => {
    const db = openStorage(":memory:");
    const configs = new ProviderConfigRepository(db);
    const profiles = new AgentProfileRepository(db);

    const seedConfig = firstOf(configs.findAll());
    const seedProfile = firstOf(profiles.findAll());
    expect(profiles.delete(seedProfile.id)).toBe(true);
    expect(profiles.findAll()).toHaveLength(0); // 默认行已被用户删除

    seedDefaults(db); // 模拟重启：openStorage 每次都会补齐默认行

    const revivedList = profiles.findAll();
    expect(revivedList).toHaveLength(1);
    const revived = expectNotNull(revivedList[0] ?? null);
    expect(revived.id).not.toBe(seedProfile.id); // 新插入的行，非复活原行
    expect(revived.name).toBe(seedProfile.name); // "Default Claude"
    expect(revived.projectId).toBeNull();
    expect(revived.providerConfigId).toBe(seedConfig.id); // 引用同一默认配置
    expect(configs.findAll()).toHaveLength(1); // 配置行未被删除，也不会重复插入
  });
});
