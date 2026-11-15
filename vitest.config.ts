import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["apps/*/tests/**/*.test.ts", "packages/**/tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // 覆盖率门禁（≥80%）在 P0-12 收口时启用，范围限核心包：
      // contracts / core / adapters / storage / process-host（TECH_STACK §4.3）
      include: ["packages/*/src/**", "packages/adapters/*/src/**"],
      exclude: ["**/index.ts", "**/*.d.ts"],
    },
  },
});
