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
      // 门禁按包 glob 分组（vitest v5 语法 thresholds['<glob>']，按仓库根相对路径
      // 聚合计算，类型定义见 vitest distchunks/plugin.d.ts Thresholds；已实证 win32
      // 上 glob 匹配生效）。门禁轴 = lines/statements/functions 各 ≥80：
      // - branches 现状 core 75% / storage 70.45% 未达线，如实不设线不加放水——
      //   P1 补齐分支覆盖后再纳入（摸底与定案数字见 docs/TASK_LIST.md P0-12 注记）；
      // - terminal / desktop UI 不设线（TECH_STACK §4.3：desktop UI 不设线）。
      thresholds: {
        "packages/contracts/src/**": { lines: 80, statements: 80, functions: 80 },
        "packages/core/src/**": { lines: 80, statements: 80, functions: 80 },
        "packages/adapters/*/src/**": { lines: 80, statements: 80, functions: 80 },
        "packages/storage/src/**": { lines: 80, statements: 80, functions: 80 },
        "packages/process-host/src/**": { lines: 80, statements: 80, functions: 80 },
      },
    },
  },
});
